// The office package cache (DIPO-267) with a fake fill box and temp folders: the cache key and the
// lockfile hash, the refresh rule, the fill box and what it gets, a failed fill that refuses the
// box, the copied-out symlinks, the cache root rule, the realpath rule, the read-only attachment,
// the start install in the box, and the lockfile read from the base branch's git objects.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId, Signal } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { BOX_NETWORK_NAME } from "../../src/box/apple-args";
import { AppleContainerBoxes } from "../../src/box/apple-container";
import {
  type BaseLockfile,
  boxCacheEnv,
  boxCacheInstall,
  cacheSkipReason,
  checkCopiedTree,
  createBoxWithPackageCache,
  ensurePackageCache,
  FILL_BOX_DIR,
  type FillBoxes,
  fillInstall,
  lockfileHash,
  managerVersion,
  officePackageCacheRoot,
  PACKAGE_CACHE_DIR,
  PACKAGE_CACHE_STAMP,
  type PackageCacheRequest,
  packageCacheKey,
  readBaseLockfile,
  resolvePackageCacheMount,
} from "../../src/box/cache";
import {
  BOX_PACKAGE_CACHE_PATH,
  BoxError,
  type BoxExecOptions,
  type BoxNetwork,
  type BoxProcess,
  type BoxSpec,
  boxName,
} from "../../src/box/port";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { fakeContainer } from "./fake-container";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000267" as OfficeId;
const PROXY_URL = "http://192.0.2.1:3128";
const CA = "-----BEGIN CERTIFICATE-----\nMIIBdGVzdA==\n-----END CERTIFICATE-----\n";
const NETWORK: BoxNetwork = { name: BOX_NETWORK_NAME, mode: "hostOnly", hostAddress: "192.0.2.1" };
const IMAGE = { tag: `dipo-box:${"b".repeat(64)}`, toolchain: { node: "24.22.1", bun: "1.4.2" } };
const FILL_BOX = boxName("fill-1");

const BUN_LOCK = (version: string) =>
  JSON.stringify({
    lockfileVersion: 1,
    workspaces: {
      "": { name: "repo", dependencies: { "is-number": version } },
      "packages/a": { name: "a" },
    },
    packages: {
      a: ["a@workspace:packages/a"],
      "is-number": [`is-number@${version}`, "", {}, "sha512-x"],
    },
  });

function source(text = BUN_LOCK("7.0.0"), name = "bun.lock"): BaseLockfile {
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

/** Every file and link below `dir`, relative to it, sorted. */
function filesBelow(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .toSorted();
}

type InstallResult = { code: number; stdout?: string; stderr?: string } | BoxError;

/**
 * A fake box port for fill boxes: a host folder stands for the box's files. `copyIn` and
 * `copyOut` copy into and out of it, the install writes into the cache folder it names, through
 * `install`, and the host's tar packs that folder into the archive that is copied out.
 */
function fakeFill(dir: string, install: (cacheDir: string) => InstallResult = writePackage) {
  const boxFs = join(dir, "box-fs");
  const calls: string[] = [];
  const specs: BoxSpec[] = [];
  const installs: { command: readonly string[]; options: BoxExecOptions | undefined }[] = [];
  let failCreate: BoxError | null = null;
  let failDelete = false;
  const boxes: FillBoxes = {
    network: async () => {
      calls.push("network");
      return NETWORK;
    },
    create: async (spec) => {
      const name = boxName(spec.runId);
      calls.push(`create ${name}`);
      specs.push(spec);
      if (failCreate !== null) throw failCreate;
      rmSync(boxFs, { recursive: true, force: true });
      mkdirSync(boxFs);
      return name;
    },
    start: async (name) => {
      calls.push(`start ${name}`);
    },
    delete: async (name) => {
      calls.push(`delete ${name}`);
      if (failDelete) throw new BoxError("box.failed", "container delete failed");
    },
    exec: async (name, command, options) => {
      calls.push(`exec ${name} ${command[0]}`);
      if (command[0] === "mkdir") {
        mkdirSync(join(boxFs, command[2]!), { recursive: true });
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command[0] === "tar") {
        // The host's tar packs the box's cache folder, as GNU tar does in the fill box.
        const [, , , from, , archive, folder] = command;
        const packed = spawnSync(
          "tar",
          ["-C", join(boxFs, from!), "-cf", join(boxFs, archive!), folder!],
          { env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" } },
        );
        return { code: packed.status, stdout: "", stderr: String(packed.stderr) };
      }
      if (command[0] === "stat") {
        return { code: 0, stdout: `${statSync(join(boxFs, command[3]!)).size}\n`, stderr: "" };
      }
      installs.push({ command, options });
      const cacheArg = command.find((arg) => /^--(?:cache-dir|cache|store-dir)=/.test(arg));
      const result = install(join(boxFs, cacheArg!.split("=")[1]!));
      if (result instanceof BoxError) throw result;
      return { stdout: "", stderr: "", ...result };
    },
    copyIn: async (name, from, to) => {
      calls.push(`copyIn ${name} ${to}`);
      cpSync(from, join(boxFs, to), { recursive: true });
    },
    execLive: (name, command) => {
      calls.push(`execLive ${name} ${command.join(" ")}`);
      return liveProcess([readFileSync(join(boxFs, command[1]!))]);
    },
    stop: async (name) => {
      calls.push(`stop ${name}`);
    },
  };
  const caFile = join(dir, "ca.pem");
  writeFileSync(caFile, CA);
  let failAcquire = false;
  const route = {
    acquire: async (box: string) => {
      calls.push(`acquire ${box}`);
      if (failAcquire) throw new Error("the web route did not start");
      return { url: PROXY_URL, caFile };
    },
    release: async (box: string) => {
      calls.push(`release ${box}`);
    },
  };
  return {
    boxes,
    route,
    calls,
    specs,
    installs,
    boxFs,
    failCreateWith: (error: BoxError) => {
      failCreate = error;
    },
    failAcquire: () => {
      failAcquire = true;
    },
    failDelete: () => {
      failDelete = true;
    },
  };
}

/** A long-running box command: `chunks` on stdout, then `exit`; `hang` keeps it open until killed. */
function liveProcess(
  chunks: readonly Uint8Array[],
  exit: { code: number | null; signal: Signal | null } = { code: 0, signal: null },
  hang = false,
): BoxProcess & { readonly kills: string[] } {
  const kills: string[] = [];
  let finish!: (value: { code: number | null; signal: Signal | null }) => void;
  const exited = new Promise<{ code: number | null; signal: Signal | null }>((resolve) => {
    finish = resolve;
  });
  let close!: () => void;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      close = () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      if (!hang) close();
    },
  });
  if (!hang) finish(exit);
  return {
    stdin: { write: () => {}, end: () => {} },
    stdout,
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    exited,
    kills,
    kill: (signal: Signal = "SIGTERM") => {
      kills.push(signal);
      close();
      finish({ code: null, signal });
    },
  };
}

/** The default install: one package in the cache folder. */
function writePackage(cacheDir: string): InstallResult {
  mkdirSync(join(cacheDir, "is-number@7.0.0@@@1"), { recursive: true });
  writeFileSync(join(cacheDir, "is-number@7.0.0@@@1", "package.json"), "{}\n");
  return { code: 0 };
}

function request(
  dir: string,
  fill: ReturnType<typeof fakeFill>,
  lockfile: BaseLockfile = source(),
): PackageCacheRequest {
  return {
    root: join(dir, "package-cache"),
    source: lockfile,
    boxes: fill.boxes,
    image: IMAGE,
    route: fill.route,
    fillId: () => "1",
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

/** The calls of one whole fill, in order. */
const FILL_CALLS = [
  "network",
  `create ${FILL_BOX}`,
  `start ${FILL_BOX}`,
  `acquire ${FILL_BOX}`,
  `exec ${FILL_BOX} mkdir`,
  `copyIn ${FILL_BOX} ${FILL_BOX_DIR}/project`,
  `copyIn ${FILL_BOX} ${FILL_BOX_DIR}/ca.pem`,
  `exec ${FILL_BOX} bun`,
  `exec ${FILL_BOX} tar`,
  `exec ${FILL_BOX} stat`,
  `execLive ${FILL_BOX} cat ${FILL_BOX_DIR}/cache.tar`,
  `release ${FILL_BOX}`,
  `delete ${FILL_BOX}`,
];

describe("the cache key and the lockfile hash", () => {
  it("hashes the lockfile with sha256", () => {
    expect(lockfileHash("lock\n")).toBe(createHash("sha256").update("lock\n").digest("hex"));
  });

  it("is a sha256 that changes with the lockfile, its name and the manager's version only", () => {
    const key = packageCacheKey(source("one").lockfile, "1.4.2");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(packageCacheKey(source("one").lockfile, "1.4.2")).toBe(key);
    expect(packageCacheKey({ ...source("one"), files: [] }.lockfile, "1.4.2")).toBe(key);
    expect(packageCacheKey(source("two").lockfile, "1.4.2")).not.toBe(key);
    expect(packageCacheKey(source("one", "package-lock.json").lockfile, "1.4.2")).not.toBe(key);
    expect(packageCacheKey(source("one").lockfile, "1.5.0")).not.toBe(key);
    expect(packageCacheKey(null, null)).not.toBe(key);
  });

  it("takes the manager's version from the office image", () => {
    const toolchain = { node: "24.22.1", bun: "1.4.2", pnpm: "12.14.0" };
    expect(managerVersion("bun", toolchain)).toBe("1.4.2");
    expect(managerVersion("pnpm", toolchain)).toBe("12.14.0");
    expect(managerVersion("npm", toolchain)).toBe("node-24.22.1");
    expect(managerVersion("pnpm", { node: "24.22.1" })).toBeNull();
  });
});

describe("the refresh rule", () => {
  it("fills once, reuses the cache while the lockfile is unchanged, and fills a new one when it changes", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      const first = await ensurePackageCache(request(dir, fill));
      const root = realpathSync(join(dir, "package-cache"));
      expect(first.filled).toBe(true);
      expect(first.path).toBe(join(root, packageCacheKey(source().lockfile, "1.4.2")));
      expect(first.lockfileSha256).toBe(lockfileHash(BUN_LOCK("7.0.0")));
      expect(filesBelow(first.path)).toEqual([
        "bun/is-number@7.0.0@@@1/package.json",
        PACKAGE_CACHE_STAMP,
      ]);
      const stamp = JSON.parse(readFileSync(join(first.path, PACKAGE_CACHE_STAMP), "utf8"));
      expect(stamp).toMatchObject({
        key: first.key,
        manager: "bun",
        managerVersion: "1.4.2",
        lockfile: "bun.lock",
        lockfileSha256: first.lockfileSha256,
      });
      // Only the generation stays; the fill folder is gone.
      expect(readdirSync(root)).toEqual([first.key]);

      const again = await ensurePackageCache(request(dir, fill));
      expect(again).toEqual({ ...first, filled: false });
      expect(fill.installs).toHaveLength(1);

      const changed = await ensurePackageCache(request(dir, fill, source(BUN_LOCK("7.0.1"))));
      expect(changed.filled).toBe(true);
      expect(changed.path).not.toBe(first.path);
      expect(fill.installs).toHaveLength(2);
      // A box still running on the older generation keeps it unchanged.
      expect(filesBelow(first.path)).toEqual([
        "bun/is-number@7.0.0@@@1/package.json",
        PACKAGE_CACHE_STAMP,
      ]);

      // A new Bun in the office image fills a new generation as well.
      const newer = await ensurePackageCache({
        ...request(dir, fill),
        image: { ...IMAGE, toolchain: { ...IMAGE.toolchain, bun: "1.5.0" } },
      });
      expect(newer.filled).toBe(true);
      expect(newer.path).not.toBe(first.path);
    }));

  it("fills again a generation that has no stamp", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      const key = packageCacheKey(source().lockfile, "1.4.2");
      mkdirSync(join(dir, "package-cache", key, "bun"), { recursive: true, mode: 0o700 });
      chmodSync(join(dir, "package-cache"), 0o700);
      writeFileSync(join(dir, "package-cache", key, "bun", "half"), "");
      const cache = await ensurePackageCache(request(dir, fill));
      expect(cache.filled).toBe(true);
      expect(filesBelow(cache.path)).toEqual([
        "bun/is-number@7.0.0@@@1/package.json",
        PACKAGE_CACHE_STAMP,
      ]);
    }));

  it("fills one generation once when two boxes start together", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      const [a, b] = await Promise.all([
        ensurePackageCache(request(dir, fill)),
        ensurePackageCache(request(dir, fill)),
      ]);
      expect(a.path).toBe(b.path);
      expect(fill.installs).toHaveLength(1);
    }));

  it("makes an empty cache when the base has no lockfile, without a fill box", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      const cache = await ensurePackageCache(
        request(dir, fill, { commit: "a".repeat(40), lockfile: null, files: [] }),
      );
      expect(cache).toMatchObject({ filled: true, manager: null, lockfileSha256: null });
      expect(filesBelow(cache.path)).toEqual([PACKAGE_CACHE_STAMP]);
      expect(fill.calls).toEqual([]);
    }));
});

describe("the fill box", () => {
  it("runs the install in a fill box of the office image, after the route, and deletes it", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      await ensurePackageCache(request(dir, fill));
      expect(fill.calls).toEqual(FILL_CALLS);
      // The office image on the host-only network, and no package cache mounted.
      expect(fill.specs).toEqual([{ runId: "fill-1", image: IMAGE.tag, network: NETWORK }]);
      expect(FILL_BOX).toBe("dipo-fill-1");
    }));

  it("copies in only the lockfile, the manifests and the CA, and installs with scripts off through the route", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      await ensurePackageCache(request(dir, fill));
      expect(filesBelow(join(fill.boxFs, FILL_BOX_DIR))).toEqual([
        "ca.pem",
        "cache.tar",
        "cache/bun/is-number@7.0.0@@@1/package.json",
        "project/bun.lock",
        "project/package.json",
        "project/packages/a/package.json",
      ]);
      expect(readFileSync(join(fill.boxFs, FILL_BOX_DIR, "ca.pem"), "utf8")).toBe(CA);
      const [install] = fill.installs;
      const expected = fillInstall("bun", PROXY_URL);
      expect(install?.command).toEqual(expected.command);
      expect(install?.command).toContain("--ignore-scripts");
      expect(install?.command).toContain("--frozen-lockfile");
      expect(install?.options?.cwd).toBe(`${FILL_BOX_DIR}/project`);
      expect(install?.options?.env).toEqual(expected.env);
      expect(install?.options?.env?.["HTTPS_PROXY"]).toBe(PROXY_URL);
      expect(install?.options?.env?.["NODE_EXTRA_CA_CERTS"]).toBe(`${FILL_BOX_DIR}/ca.pem`);
      expect(install?.options?.timeoutMs).toBeGreaterThan(0);
    }));

  it("installs npm and pnpm into their own cache folders, with no platform flags", () => {
    expect(fillInstall("npm", PROXY_URL).command).toEqual([
      "npm",
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--cache=${FILL_BOX_DIR}/cache/npm`,
    ]);
    expect(fillInstall("pnpm", PROXY_URL).command).toEqual([
      "pnpm",
      "fetch",
      `--store-dir=${FILL_BOX_DIR}/cache/pnpm`,
    ]);
    for (const manager of ["bun", "npm", "pnpm"] as const) {
      const { command, env } = fillInstall(manager, PROXY_URL);
      expect(command.filter((arg) => /^--(?:os|cpu)=/.test(arg))).toEqual([]);
      expect(env["npm_config_ignore_scripts"]).toBe("true");
    }
  });
});

describe("a failed fill", () => {
  it("refuses with the install's output, deletes the fill box and leaves nothing to mount", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir, () => ({ code: 1, stderr: "error: 403 blocked by safe-chain\n" }));
      const error = await rejection(ensurePackageCache(request(dir, fill)));
      expect(error.code).toBe("box.cacheFillFailed");
      expect(error.message).toContain("blocked by safe-chain");
      expect(fill.calls.slice(-2)).toEqual([`release ${FILL_BOX}`, `delete ${FILL_BOX}`]);
      expect(readdirSync(join(dir, "package-cache"))).toEqual([]);
    }));

  it("refuses an install killed at its deadline, and deletes the fill box", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir, () => new BoxError("box.timedOut", "killed"));
      const error = await rejection(ensurePackageCache(request(dir, fill)));
      expect(error.code).toBe("box.cacheFillFailed");
      expect(error.details).toMatchObject({ cause: "box.timedOut" });
      expect(fill.calls.at(-1)).toBe(`delete ${FILL_BOX}`);
      expect(readdirSync(join(dir, "package-cache"))).toEqual([]);
    }));

  it("deletes the fill box when it cannot be created, and never starts the route", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      fill.failCreateWith(new BoxError("box.timedOut", "create killed"));
      const error = await rejection(ensurePackageCache(request(dir, fill)));
      expect(error.code).toBe("box.cacheFillFailed");
      expect(fill.calls).toEqual(["network", `create ${FILL_BOX}`, `delete ${FILL_BOX}`]);
    }));

  it("makes a fill box it could not delete visible, in the error and as an event", () =>
    withTempDir(async (dir) => {
      const events: unknown[] = [];
      const failing = fakeFill(dir, () => ({ code: 1 }));
      failing.failDelete();
      const error = await rejection(
        ensurePackageCache({ ...request(dir, failing), onEvent: (event) => events.push(event) }),
      );
      expect(error.code).toBe("box.cacheFillFailed");
      expect(error.details["cleanup"]).toEqual([
        { step: "boxDelete", reason: "container delete failed" },
      ]);
      expect(events).toEqual([
        {
          kind: "fillCleanupFailed",
          box: FILL_BOX,
          step: "boxDelete",
          reason: "container delete failed",
        },
      ]);

      // A fill that worked keeps its cache; the left box is still reported.
      const working = fakeFill(dir);
      working.failDelete();
      const cache = await ensurePackageCache({
        ...request(dir, working),
        onEvent: (event) => events.push(event),
      });
      expect(cache.filled).toBe(true);
      expect(events).toHaveLength(2);
    }));

  it("refuses when the route does not start, releases what acquire took, and deletes the fill box", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      fill.failAcquire();
      const error = await rejection(ensurePackageCache(request(dir, fill)));
      expect(error.code).toBe("box.cacheFillFailed");
      expect(fill.calls.slice(-3)).toEqual([
        `acquire ${FILL_BOX}`,
        `release ${FILL_BOX}`,
        `delete ${FILL_BOX}`,
      ]);
      expect(fill.installs).toEqual([]);
    }));

  it("refuses an image without the manager, and a lockfile with a git dependency, before any box", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      const noBun = await rejection(
        ensurePackageCache({
          ...request(dir, fill),
          image: { ...IMAGE, toolchain: { node: "24.22.1" } },
        }),
      );
      expect(noBun.code).toBe("box.cacheUnsupported");
      const git = await rejection(
        ensurePackageCache(
          request(
            dir,
            fill,
            source(
              JSON.stringify({
                workspaces: { "": {} },
                packages: { x: ["x@git+ssh://git@example.com/x.git#abc"] },
              }),
            ),
          ),
        ),
      );
      expect(git.code).toBe("box.cacheUnsupported");
      expect(fill.calls).toEqual([]);
    }));

  it("never creates the box when the fill or the lockfile read fails", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir, () => ({ code: 1 }));
      const spec = { runId: "run_1", image: "dipo-box:x", network: NETWORK };
      const { source: _, boxes: __, ...cache } = request(dir, fill);
      const failed = await rejection(
        createBoxWithPackageCache({
          boxes: fill.boxes,
          spec,
          readSource: async () => source(),
          cache,
        }),
      );
      expect(failed.code).toBe("box.cacheFillFailed");
      const unread = await rejection(
        createBoxWithPackageCache({
          boxes: fill.boxes,
          spec,
          readSource: () => Promise.reject(new Error("git failed")),
          cache,
        }),
      );
      expect(unread.code).toBe("box.cacheFillFailed");
      expect(fill.specs.map((made) => made.runId)).toEqual(["fill-1"]);
    }));
});

/** An install that also leaves a symlink `link` to `target` in the cache. */
const withLink = (target: string) => (cacheDir: string) => {
  writePackage(cacheDir);
  symlinkSync(target, join(cacheDir, "is-number@7.0.0@@@1", "link"));
  return { code: 0 };
};

describe("links in the filled cache", () => {
  for (const [what, target] of [
    ["a relative symlink that stays in the cache", "package.json"],
    ["an absolute symlink", "/etc/hosts"],
    ["a relative symlink out of the generation", "../../../../../outside"],
  ] as const) {
    it(`refuses ${what}: the package cache takes no links`, () =>
      withTempDir(async (dir) => {
        mkdirSync(join(dir, "outside"));
        const fill = fakeFill(dir, withLink(target));
        const error = await rejection(ensurePackageCache(request(dir, fill)));
        expect(error.code).toBe("box.cacheFillFailed");
        expect(error.message).toContain("takes no links");
        expect(readdirSync(join(dir, "package-cache"))).toEqual([]);
        expect(readdirSync(join(dir, "outside"))).toEqual([]);
      }));
  }
});

describe("the archive's size", () => {
  it("refuses an archive above the cap in the fill box, before it is copied out", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      const error = await rejection(
        ensurePackageCache({ ...request(dir, fill), archiveLimits: { maxArchiveBytes: 100 } }),
      );
      expect(error.code).toBe("box.cacheFillFailed");
      expect(error.message).toContain("more than 100");
      expect(fill.calls.filter((call) => call.startsWith("execLive"))).toEqual([]);
      expect(fill.calls.at(-1)).toBe(`delete ${FILL_BOX}`);
    }));
});

describe("the cache root", () => {
  it("refuses a root its group or others may write, before any box", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      mkdirSync(join(dir, "package-cache"));
      chmodSync(join(dir, "package-cache"), 0o777);
      const error = await rejection(ensurePackageCache(request(dir, fill)));
      expect(error.code).toBe("box.cacheFillFailed");
      expect(error.message).toContain("writable by no one else");
      expect(fill.calls).toEqual([]);
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
  it("creates the box with the real path of the filled cache, after a changed lockfile refreshed it", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      const spec = { runId: "run_1", image: IMAGE.tag, network: NETWORK };
      const { source: _, boxes: __, ...cache } = request(dir, fill);
      const made = await createBoxWithPackageCache({
        boxes: fill.boxes,
        spec,
        readSource: async () => source(),
        cache,
      });
      expect(made.name).toBe("dipo-run_1");
      expect(fill.specs.at(-1)).toEqual({ ...spec, packageCache: made.cache.path });

      const next = await createBoxWithPackageCache({
        boxes: fill.boxes,
        spec: { ...spec, runId: "run_2" },
        readSource: async () => source(BUN_LOCK("7.0.1")),
        cache,
      });
      expect(next.cache.filled).toBe(true);
      expect(fill.specs.at(-1)?.packageCache).toBe(next.cache.path);
      expect(next.cache.path).not.toBe(made.cache.path);
    }));

  it("reaches the backend as the one bind mount of the cache, read-only", () =>
    withTempDir(async (dir) => {
      const fill = fakeFill(dir);
      const { source: _, boxes: __, ...cache } = request(dir, fill);
      // Filled first; the story box then reuses it, so only `container create` runs.
      const filled = await ensurePackageCache(request(dir, fill));
      const container = fakeContainer(() => ({ stdout: "dipo-run_1\n" }));
      const boxes = new AppleContainerBoxes({
        spawn: container.spawn,
        clock: new ManualClock(),
        env: { PATH: "/usr/bin:/bin" },
        host: { memoryBytes: 8 * 1024 ** 3, cpus: 4 },
        home: "/Users/someone",
        packageCacheRoot: cache.root,
      });
      const made = await createBoxWithPackageCache({
        boxes,
        spec: { runId: "run_1", image: "docker.io/library/alpine:3.20", network: NETWORK },
        readSource: async () => source(),
        cache,
      });
      expect(made.cache).toEqual({ ...filled, filled: false });
      const [args] = container.args();
      expect(container.args()).toHaveLength(1);
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
    const pnpm = boxCacheInstall("pnpm");
    expect(pnpm.command).toContain(`--store-dir=${BOX_PACKAGE_CACHE_PATH}/pnpm`);
    expect(pnpm.command).toContain("--package-import-method=copy");
    expect(pnpm.env["pnpm_config_side_effects_cache_readonly"]).toBe("true");
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

describe("the copied cache holds no links (DIPO-295)", () => {
  it("refuses a relative symlink inside the cache and a file with a second hard link", () =>
    withTempDir(async (dir) => {
      const cache = join(dir, "cache");
      mkdirSync(join(cache, "bun", "pkg"), { recursive: true });
      writeFileSync(join(cache, "bun", "pkg", "package.json"), "{}\n");
      await checkCopiedTree(cache);
      symlinkSync("package.json", join(cache, "bun", "pkg", "link"));
      const linked = await rejection(checkCopiedTree(cache));
      expect(linked.code).toBe("box.cacheFillFailed");
      expect(linked.message).toContain("the cache takes no links");
      rmSync(join(cache, "bun", "pkg", "link"));
      linkSync(join(cache, "bun", "pkg", "package.json"), join(cache, "bun", "pkg", "again.json"));
      const hard = await rejection(checkCopiedTree(cache));
      expect(hard.message).toContain("a second hard link");
    }));
});

describe("a box run without the package cache (DIPO-295)", () => {
  it("says why without the fill box's output", () => {
    const failed = new BoxError("box.cacheFillFailed", "bun could not fill: BOX-OUTPUT", false, {
      manager: "bun",
      code: 1,
      output: "BOX-OUTPUT",
    });
    expect(cacheSkipReason(failed)).toBe("bun exited 1 in the fill box");
    expect(
      cacheSkipReason(
        new BoxError("box.cacheFillFailed", "could not be filled: x", false, {
          cause: "box.timedOut",
        }),
      ),
    ).toBe("the fill passed its deadline");
    expect(
      cacheSkipReason(
        new BoxError("box.cacheFillFailed", "BOX-OUTPUT", false, { cause: "box.failed" }),
      ),
    ).toBe("the fill failed (box.failed)");
    expect(
      cacheSkipReason(new BoxError("box.cacheUnsupported", "bun.lock has the field\u001b[31m x.")),
    ).toBe("the package cache cannot be filled from this base: bun.lock has the field x.");
    expect(cacheSkipReason(new Error("disk\nfull"))).toBe("the fill failed: disk full");
  });

  it("keeps each office's root in dipo's state folder, and refuses an id that leaves it", () => {
    expect(officePackageCacheRoot("/state", OFFICE)).toBe(`/state/${PACKAGE_CACHE_DIR}/${OFFICE}`);
    for (const office of ["..", "a/b", ""]) {
      expect(() => officePackageCacheRoot("/state", office)).toThrow(BoxError);
    }
  });

  it("points the office's own install at the read-only cache for npm and pnpm too", () => {
    expect(boxCacheEnv("npm")).toMatchObject({
      npm_config_cache: `${BOX_PACKAGE_CACHE_PATH}/npm`,
      npm_config_prefer_offline: "true",
    });
    expect(boxCacheEnv("pnpm")).toMatchObject({
      npm_config_store_dir: `${BOX_PACKAGE_CACHE_PATH}/pnpm`,
      pnpm_config_store_dir: `${BOX_PACKAGE_CACHE_PATH}/pnpm`,
      pnpm_config_package_import_method: "copy",
    });
  });
});
