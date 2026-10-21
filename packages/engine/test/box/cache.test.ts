// The office package cache (DIPO-267) with a fake Spawn and temp folders: the cache key and the
// lockfile hash, the refresh rule, the fill command and its folder, a failed fill that refuses the
// box, the realpath rule, the read-only attachment, the start install in the box, and the
// lockfile read from the base branch's git objects.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId, SpawnOptions } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { BOX_NETWORK_NAME } from "../../src/box/apple-args";
import { AppleContainerBoxes } from "../../src/box/apple-container";
import {
  type BaseLockfile,
  boxCacheInstall,
  createBoxWithPackageCache,
  ensurePackageCache,
  fillCommand,
  fillEnvironment,
  lockfileHash,
  PACKAGE_CACHE_FILL_TIMEOUT_MS,
  PACKAGE_CACHE_STAMP,
  type PackageCacheRequest,
  packageCacheKey,
  readBaseLockfile,
  resolvePackageCacheMount,
} from "../../src/box/cache";
import {
  BOX_PACKAGE_CACHE_PATH,
  BoxError,
  type BoxNetwork,
  type BoxSpec,
} from "../../src/box/port";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { type CliReply, fakeContainer } from "./fake-container";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000267" as OfficeId;
const ARM = { os: "linux", cpu: "arm64" } as const;
const PROXY_URL = "http://192.0.2.1:3128";
const CA = "-----BEGIN CERTIFICATE-----\nMIIBdGVzdA==\n-----END CERTIFICATE-----\n";
const PATH = "/usr/bin:/bin";
const BUN = "/opt/tools/bun";
const NETWORK: BoxNetwork = { name: BOX_NETWORK_NAME, mode: "hostOnly", hostAddress: "192.0.2.1" };

function source(text: string, name = "bun.lock"): BaseLockfile {
  const manager = name === "bun.lock" ? "bun" : name === "pnpm-lock.yaml" ? "pnpm" : "npm";
  return {
    commit: "a".repeat(40),
    lockfile: { name, manager, text },
    files: [
      { path: "package.json", text: '{ "name": "repo", "workspaces": ["packages/*"] }\n' },
      { path: "packages/a/package.json", text: '{ "name": "a" }\n' },
    ],
  };
}

/** The cache folder a fill command names (`--cache-dir=`, `--cache=` or `--store-dir=`). */
function cacheDirOf(cmd: readonly string[]): string | undefined {
  for (const arg of cmd) {
    const match = /^--(?:cache-dir|cache|store-dir)=(.+)$/.exec(arg);
    if (match !== null) return match[1];
  }
  return undefined;
}

/** Every file below `dir`, relative to it, sorted. */
function filesBelow(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .toSorted();
}

/** A fake package manager: writes one package into the cache folder it is given. */
function fakeManager(reply: (options: SpawnOptions) => CliReply = () => ({})) {
  const seen: { options: SpawnOptions; project: string[] }[] = [];
  const spawn = (options: SpawnOptions) => {
    seen.push({ options, project: options.cwd === undefined ? [] : filesBelow(options.cwd) });
    const answer = reply(options);
    const cacheDir = cacheDirOf(options.cmd);
    if (cacheDir !== undefined && (answer.code ?? 0) === 0 && answer.hang !== true) {
      mkdirSync(join(cacheDir, "is-number@7.0.0@@@1"), { recursive: true });
      writeFileSync(join(cacheDir, "is-number@7.0.0@@@1", "package.json"), "{}\n");
    }
    return fakeContainer(() => answer).spawn(options);
  };
  return { spawn, seen };
}

function request(
  dir: string,
  spawn: PackageCacheRequest["spawn"],
  lockfile: BaseLockfile,
  clock = new ManualClock(),
): PackageCacheRequest {
  const caFile = join(dir, "ca.pem");
  if (!existsSync(caFile)) writeFileSync(caFile, CA);
  return {
    root: join(dir, "package-cache"),
    source: lockfile,
    proxy: { url: PROXY_URL, caFile },
    tools: { bun: BUN, npm: "/opt/tools/npm", pnpm: "/opt/tools/pnpm" },
    path: PATH,
    spawn,
    clock,
    target: ARM,
  };
}

async function rejection(promise: Promise<unknown>): Promise<BoxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BoxError);
    return error as BoxError;
  }
  throw new Error("expected the call to fail");
}

/** A box port that only records the specs it was asked to create. */
function recordingBoxes() {
  const created: BoxSpec[] = [];
  return {
    created,
    boxes: {
      create: async (spec: BoxSpec) => {
        created.push(spec);
        return `dipo-${spec.runId}`;
      },
    },
  };
}

describe("the cache key and the lockfile hash", () => {
  it("hashes the lockfile with sha256", () => {
    expect(lockfileHash("lock\n")).toBe(createHash("sha256").update("lock\n").digest("hex"));
  });

  it("is a sha256 that changes with the lockfile, its name and the box platform only", () => {
    const key = packageCacheKey(source("one").lockfile, ARM);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(packageCacheKey(source("one").lockfile, ARM)).toBe(key);
    // The manifests are not part of the key: only the lockfile is.
    expect(packageCacheKey({ ...source("one"), files: [] }.lockfile, ARM)).toBe(key);
    expect(packageCacheKey(source("two").lockfile, ARM)).not.toBe(key);
    expect(packageCacheKey(source("one", "package-lock.json").lockfile, ARM)).not.toBe(key);
    expect(packageCacheKey(source("one").lockfile, { os: "linux", cpu: "x64" })).not.toBe(key);
    expect(packageCacheKey(null, ARM)).not.toBe(key);
  });
});

describe("the refresh rule", () => {
  it("fills once, reuses the cache while the lockfile is unchanged, and fills a new one when it changes", () =>
    withTempDir(async (dir) => {
      const manager = fakeManager();
      const first = await ensurePackageCache(request(dir, manager.spawn, source("one")));
      const root = realpathSync(join(dir, "package-cache"));
      expect(first.filled).toBe(true);
      expect(first.path).toBe(join(root, packageCacheKey(source("one").lockfile, ARM)));
      expect(first.lockfileSha256).toBe(lockfileHash("one"));
      expect(filesBelow(first.path)).toEqual([
        "bun/is-number@7.0.0@@@1/package.json",
        PACKAGE_CACHE_STAMP,
      ]);
      const stamp = JSON.parse(readFileSync(join(first.path, PACKAGE_CACHE_STAMP), "utf8"));
      expect(stamp).toMatchObject({
        key: first.key,
        manager: "bun",
        lockfile: "bun.lock",
        lockfileSha256: lockfileHash("one"),
        target: ARM,
      });
      // Only the generation stays; the fill folder is gone.
      expect(readdirSync(root)).toEqual([first.key]);

      const again = await ensurePackageCache(request(dir, manager.spawn, source("one")));
      expect(again).toEqual({ ...first, filled: false });
      expect(manager.seen).toHaveLength(1);

      const changed = await ensurePackageCache(request(dir, manager.spawn, source("two")));
      expect(changed.filled).toBe(true);
      expect(changed.path).not.toBe(first.path);
      expect(manager.seen).toHaveLength(2);
      // A box still running on the older generation keeps it unchanged.
      expect(filesBelow(first.path)).toEqual([
        "bun/is-number@7.0.0@@@1/package.json",
        PACKAGE_CACHE_STAMP,
      ]);
    }));

  it("fills again a generation that has no stamp", () =>
    withTempDir(async (dir) => {
      const manager = fakeManager();
      const key = packageCacheKey(source("one").lockfile, ARM);
      mkdirSync(join(dir, "package-cache", key, "bun"), { recursive: true });
      writeFileSync(join(dir, "package-cache", key, "bun", "half"), "");
      const cache = await ensurePackageCache(request(dir, manager.spawn, source("one")));
      expect(cache.filled).toBe(true);
      expect(filesBelow(cache.path)).toEqual([
        "bun/is-number@7.0.0@@@1/package.json",
        PACKAGE_CACHE_STAMP,
      ]);
    }));

  it("fills one generation once when two boxes start together", () =>
    withTempDir(async (dir) => {
      const manager = fakeManager();
      const [a, b] = await Promise.all([
        ensurePackageCache(request(dir, manager.spawn, source("one"))),
        ensurePackageCache(request(dir, manager.spawn, source("one"))),
      ]);
      expect(a.path).toBe(b.path);
      expect(manager.seen).toHaveLength(1);
    }));

  it("makes an empty cache when the base has no lockfile, without running anything", () =>
    withTempDir(async (dir) => {
      const manager = fakeManager();
      const cache = await ensurePackageCache(
        request(dir, manager.spawn, { commit: "a".repeat(40), lockfile: null, files: [] }),
      );
      expect(cache).toMatchObject({ filled: true, manager: null, lockfileSha256: null });
      expect(filesBelow(cache.path)).toEqual([PACKAGE_CACHE_STAMP]);
      expect(manager.seen).toHaveLength(0);
    }));
});

describe("the fill", () => {
  it("runs Bun outside any box with scripts off, through the Safe-Chain proxy, for the box platform", () =>
    withTempDir(async (dir) => {
      const manager = fakeManager();
      await ensurePackageCache(request(dir, manager.spawn, source("one")));
      const [call] = manager.seen;
      const options = call!.options;
      const work = join(options.cwd!, "..");
      expect(options.cmd).toEqual([
        BUN,
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        `--cache-dir=${join(work, "cache", "bun")}`,
        `--cafile=${join(work, "ca.pem")}`,
        "--os=linux",
        "--cpu=arm64",
      ]);
      // Its whole environment is dipo's: its own home and temp folders, the proxy and its CA.
      expect(options.env).toEqual(
        fillEnvironment({
          path: PATH,
          home: join(work, "home"),
          tmp: join(work, "tmp"),
          caFile: join(work, "ca.pem"),
          proxyUrl: PROXY_URL,
        }),
      );
      expect(options.env?.["HTTPS_PROXY"]).toBe(PROXY_URL);
      expect(options.env?.["npm_config_ignore_scripts"]).toBe("true");
      // The fill folder holds only the lockfile and the manifests: no .npmrc or bunfig.toml.
      expect(call!.project).toEqual(["bun.lock", "package.json", "packages/a/package.json"]);
    }));

  it("runs npm ci and pnpm fetch into their own cache folders", () => {
    const common = { cacheDir: "/c", caFile: "/ca.pem", proxyUrl: PROXY_URL, target: ARM };
    expect(fillCommand({ ...common, manager: "npm", tool: "/opt/npm" })).toEqual([
      "/opt/npm",
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache=/c",
      "--cafile=/ca.pem",
      `--https-proxy=${PROXY_URL}`,
      `--proxy=${PROXY_URL}`,
      "--os=linux",
      "--cpu=arm64",
    ]);
    expect(fillCommand({ ...common, manager: "pnpm", tool: "/opt/pnpm" })).toEqual([
      "/opt/pnpm",
      "fetch",
      "--store-dir=/c",
    ]);
  });
});

describe("a failed fill", () => {
  it("refuses with box.cacheFillFailed and the manager's output, and leaves nothing to mount", () =>
    withTempDir(async (dir) => {
      const manager = fakeManager(() => ({
        code: 1,
        stderr: "error: 403 blocked by safe-chain\n",
      }));
      const error = await rejection(ensurePackageCache(request(dir, manager.spawn, source("one"))));
      expect(error.code).toBe("box.cacheFillFailed");
      expect(error.message).toContain("blocked by safe-chain");
      expect(readdirSync(join(dir, "package-cache"))).toEqual([]);
    }));

  it("kills a fill at its deadline and refuses", () =>
    withTempDir(async (dir) => {
      const clock = new ManualClock();
      const manager = fakeManager(() => ({ hang: true }));
      const pending = rejection(
        ensurePackageCache(request(dir, manager.spawn, source("one"), clock)),
      );
      while (clock.pendingTimers === 0) await Bun.sleep(1);
      clock.advance(PACKAGE_CACHE_FILL_TIMEOUT_MS);
      const error = await pending;
      expect(error.code).toBe("box.cacheFillFailed");
      expect(error.message).toContain("killed");
      expect(readdirSync(join(dir, "package-cache"))).toEqual([]);
    }));

  it("refuses without the manager's program or with a CA bundle that is not certificates", () =>
    withTempDir(async (dir) => {
      const manager = fakeManager();
      const base = request(dir, manager.spawn, source("one"));
      const noTool = await rejection(ensurePackageCache({ ...base, tools: {} }));
      expect(noTool.code).toBe("box.cacheFillFailed");
      writeFileSync(join(dir, "bad.pem"), "not a certificate\n");
      const badCa = await rejection(
        ensurePackageCache({ ...base, proxy: { url: PROXY_URL, caFile: join(dir, "bad.pem") } }),
      );
      expect(badCa.code).toBe("box.cacheFillFailed");
      expect(manager.seen).toHaveLength(0);
    }));

  it("never creates the box when the fill or the lockfile read fails", () =>
    withTempDir(async (dir) => {
      const manager = fakeManager(() => ({ code: 1 }));
      const { boxes, created } = recordingBoxes();
      const spec = { runId: "run_1", image: "dipo-box:x", network: NETWORK };
      const { source: _, ...cache } = request(dir, manager.spawn, source("one"));
      const failed = await rejection(
        createBoxWithPackageCache({ boxes, spec, readSource: async () => source("one"), cache }),
      );
      expect(failed.code).toBe("box.cacheFillFailed");
      const unread = await rejection(
        createBoxWithPackageCache({
          boxes,
          spec,
          readSource: () => Promise.reject(new Error("git failed")),
          cache,
        }),
      );
      expect(unread.code).toBe("box.cacheFillFailed");
      expect(created).toEqual([]);
    }));
});

describe("the realpath rule", () => {
  it("returns the real path of a folder under the cache root", () =>
    withTempDir(async (dir) => {
      const root = join(dir, "package-cache");
      mkdirSync(join(root, "generation"), { recursive: true });
      expect(await resolvePackageCacheMount(join(root, "generation"), root)).toBe(
        realpathSync(join(root, "generation")),
      );
    }));

  it("refuses a symlink in the root that points out of it, a folder outside, the root and a file", () =>
    withTempDir(async (dir) => {
      const root = join(dir, "package-cache");
      const outside = join(dir, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      writeFileSync(join(root, "file"), "");
      symlinkSync(outside, join(root, "escape"));
      symlinkSync("/", join(root, "slash"));
      for (const path of [
        join(root, "escape"),
        join(root, "slash"),
        outside,
        root,
        join(root, "file"),
        join(root, "missing"),
        "relative/path",
      ]) {
        const error = await rejection(resolvePackageCacheMount(path, root));
        expect(error.code).toBe("box.cacheOutsideRoot");
      }
    }));
});

describe("the read-only attachment", () => {
  it("creates the box with the real path of the filled cache, mounted read-only", () =>
    withTempDir(async (dir) => {
      const manager = fakeManager();
      const { boxes, created } = recordingBoxes();
      const spec = { runId: "run_1", image: "dipo-box:x", network: NETWORK };
      const { source: _, ...cache } = request(dir, manager.spawn, source("one"));
      const made = await createBoxWithPackageCache({
        boxes,
        spec,
        readSource: async () => source("one"),
        cache,
      });
      expect(made.name).toBe("dipo-run_1");
      expect(created).toEqual([{ ...spec, packageCache: made.cache.path }]);

      // A changed base lockfile refreshes the cache before the next box is created.
      const next = await createBoxWithPackageCache({
        boxes,
        spec: { ...spec, runId: "run_2" },
        readSource: async () => source("two"),
        cache,
      });
      expect(next.cache.filled).toBe(true);
      expect(created[1]?.packageCache).toBe(next.cache.path);
      expect(next.cache.path).not.toBe(made.cache.path);
    }));

  it("reaches the backend as the one bind mount of the cache, read-only", () =>
    withTempDir(async (dir) => {
      const manager = fakeManager();
      const container = fakeContainer(() => ({ stdout: "dipo-run_1\n" }));
      const { source: _, ...cache } = request(dir, manager.spawn, source("one"));
      const boxes = new AppleContainerBoxes({
        spawn: container.spawn,
        clock: new ManualClock(),
        env: { PATH },
        host: { memoryBytes: 8 * 1024 ** 3, cpus: 4 },
        home: "/Users/someone",
        packageCacheRoot: cache.root,
      });
      const made = await createBoxWithPackageCache({
        boxes,
        spec: { runId: "run_1", image: "docker.io/library/alpine:3.20", network: NETWORK },
        readSource: async () => source("one"),
        cache,
      });
      const [args] = container.args();
      const mounts = args!.flatMap((arg, at) => (arg === "--mount" ? [args![at + 1]] : []));
      expect(mounts).toEqual([
        `type=bind,source=${made.cache.path},target=${BOX_PACKAGE_CACHE_PATH},readonly`,
      ]);
      expect(args).not.toContain("--volume");
    }));
});

describe("the start install in the box", () => {
  it("installs offline from the read-only cache, and names the cache for that command only", () => {
    expect(boxCacheInstall("bun")).toEqual({
      command: ["bun", "install", "--frozen-lockfile", "--offline", "--backend=copyfile"],
      env: { BUN_INSTALL_CACHE_DIR: `${BOX_PACKAGE_CACHE_PATH}/bun` },
    });
    expect(boxCacheInstall("npm").command).toContain(`--cache=${BOX_PACKAGE_CACHE_PATH}/npm`);
    expect(boxCacheInstall("npm").command).toContain("--offline");
    expect(boxCacheInstall("pnpm").command).toContain(`--store-dir=${BOX_PACKAGE_CACHE_PATH}/pnpm`);
    expect(boxCacheInstall("pnpm").command).toContain("--package-import-method=copy");
  });
});

function officeGit(dir: string, env: Record<string, string>): OfficeGit {
  const real = realpathSync(dir);
  return new OfficeGit({
    officeId: OFFICE,
    mainWorktree: real,
    commonDir: join(real, ".git"),
    settings: { remote: "origin", base: "main" },
    runner: { exec: spawnGitExec(systemSpawn), env, sleep: async () => {} },
    clock: new ManualClock(),
  });
}

describe("the lockfile on the base branch", () => {
  it("is read from <remote>/<base> with its manifests, never from a story's commit or checkout", () =>
    withTempRepo(async (repo) => {
      writeFileSync(join(repo.dir, "package.json"), '{ "workspaces": ["packages/*"] }\n');
      writeFileSync(join(repo.dir, "bun.lock"), "base lock\n");
      writeFileSync(join(repo.dir, ".npmrc"), "registry=https://example.com/\n");
      writeFileSync(join(repo.dir, "bunfig.toml"), "[install]\n");
      mkdirSync(join(repo.dir, "packages/a"), { recursive: true });
      writeFileSync(join(repo.dir, "packages/a/package.json"), '{ "name": "a" }\n');
      mkdirSync(join(repo.dir, "node_modules/x"), { recursive: true });
      writeFileSync(join(repo.dir, "node_modules/x/package.json"), '{ "name": "x" }\n');
      const base = await repo.commitAll("base");
      await repo.git("update-ref", "refs/remotes/origin/main", base);
      await repo.git("checkout", "--quiet", "-b", "DIPO-1/story");
      writeFileSync(join(repo.dir, "bun.lock"), "story lock\n");
      await repo.commitAll("story");
      writeFileSync(join(repo.dir, "bun.lock"), "checkout lock\n");

      expect(await readBaseLockfile(officeGit(repo.dir, repo.env))).toEqual({
        commit: base,
        lockfile: { name: "bun.lock", manager: "bun", text: "base lock\n" },
        files: [
          { path: "package.json", text: '{ "workspaces": ["packages/*"] }\n' },
          { path: "packages/a/package.json", text: '{ "name": "a" }\n' },
        ],
      });
    }));

  it("is null when the base has no lockfile", () =>
    withTempRepo(async (repo) => {
      writeFileSync(join(repo.dir, "README.md"), "hello\n");
      const base = await repo.commitAll("base");
      await repo.git("update-ref", "refs/remotes/origin/main", base);
      expect(await readBaseLockfile(officeGit(repo.dir, repo.env))).toEqual({
        commit: base,
        lockfile: null,
        files: [],
      });
    }));

  it("refuses yarn.lock, a lone bun.lockb and lockfiles of two managers with box.cacheUnsupported", async () => {
    for (const lockfiles of [["yarn.lock"], ["bun.lockb"], ["bun.lock", "package-lock.json"]]) {
      await withTempRepo(async (repo) => {
        for (const name of lockfiles) writeFileSync(join(repo.dir, name), "lock\n");
        const base = await repo.commitAll("base");
        await repo.git("update-ref", "refs/remotes/origin/main", base);
        const error = await rejection(readBaseLockfile(officeGit(repo.dir, repo.env)));
        expect(error.code).toBe("box.cacheUnsupported");
      });
    }
  });

  it("reads pnpm-workspace.yaml with a pnpm lockfile", () =>
    withTempRepo(async (repo) => {
      writeFileSync(join(repo.dir, "package.json"), "{}\n");
      writeFileSync(join(repo.dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeFileSync(join(repo.dir, "pnpm-workspace.yaml"), "packages: ['packages/*']\n");
      const base = await repo.commitAll("base");
      await repo.git("update-ref", "refs/remotes/origin/main", base);
      const read = await readBaseLockfile(officeGit(repo.dir, repo.env));
      expect(read.lockfile?.manager).toBe("pnpm");
      expect(read.files.map((file) => file.path)).toEqual(["package.json", "pnpm-workspace.yaml"]);
    }));
});
