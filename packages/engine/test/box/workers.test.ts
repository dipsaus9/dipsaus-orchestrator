// The box of a box worker's run (DIPO-271) on an in-memory backend and a real git repository:
// - the code goes in as a plain copy of the start commit, no `.git`, plus only the files the base
//   office config lists, read from dipo's checkout of the base (criterion 5);
// - the box gets the office image, the host-only box network and no Mac folder unless a package
//   cache is given (criterion 4), and the session's environment is exactly the model proxy's,
//   the web proxy's and the CA bundle's (criterion 4);
// - dipo's web route and model proxy start only after the first box on the network runs
//   (criterion 10);
// - the end of every box run runs the post-run token check, deletes the box and releases the
//   routes, also for a run a stopped daemon left behind (criterion 9);
// - daemon stop stops every running box, which ends the worker inside it (criterion 6), and a
//   sticky box-token hold refuses a new box (criterion 8);
// - before the worker (DIPO-294): the office's install runs in the box with the box's web route as
//   a session gets it, a failed or timed-out install is a result with its reason, and `/work` is
//   compared with the start commit on dipo's own copy (`BoxParts.changedSinceStart`).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import {
  ManualClock,
  type TempRepo,
  withTempDir,
  withTempRepo,
} from "@dipsaus-orchestrator/testkit";

import { CODE_STAGE_PREFIX, filtersOffConfig } from "../../src/box/code";
import { BASE_CHECKOUT_CONFIG } from "../../src/git/hardened";
import type { GitSession } from "../../src/git/office";
import {
  boxImageTag,
  type BaseBox,
  type BoxImageDescription,
  NODE_TARBALL_SHA256,
} from "../../src/box/image";
import { BOX_PLACEHOLDER_API_KEY, type RunningModelProxy } from "../../src/box/model-proxy";
import { BoxError, boxName } from "../../src/box/port";
import { SecretToken } from "../../src/box/token";
import { BOX_TOKEN_CHECK } from "../../src/box/token-check";
import { boxTokenHoldPath, boxTokenStickyHolds } from "../../src/box/token-hold";
import type { BoxWebRouteStart } from "../../src/box/web-proxy";
import {
  BOX_CA_FILE,
  BOX_INDEX_DIR,
  BOX_RUN_FILE,
  BOX_SYSTEM_FILE,
  BoxWorkers,
  type BoxWorkersDeps,
  readBoxRun,
} from "../../src/box/workers";
import { DIPO_PART_PATH } from "../../src/box/door";
import { BoxParts, type BoxPartsDeps } from "../../src/box/parts";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";
import { AdapterHolds, type HoldNotice } from "../../src/workers/hold";
import { BOX_HOST_ADDRESS, BUILD_HOST_ADDRESS, FakeBoxes } from "./fake-boxes";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000271" as OfficeId;
const RUN = "run_01J9ZK5Q8W3V4X6Y7Z00000001";
const BOX = boxName(RUN);
const ADAPTER = "claude-cli";
const TOKEN = "fake-box-login-for-tests-0123456789";
const CA =
  "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIBATAKBggqhkjOPQQDAjA=\n-----END CERTIFICATE-----\n";
const IMAGE: BoxImageDescription = {
  debian: "trixie",
  toolchain: { node: "24.22.1" },
  nodeSha256: NODE_TARBALL_SHA256["24.22.1"]!,
  packages: [],
  claudeCode: "2.1.303",
};
/**
 * The listed files of the base office config: one present, one missing, one a symlink, and one
 * reached through a symlinked folder.
 */
const LISTED = [
  { path: "config/local.json", noRealSecrets: true as const },
  { path: "missing.json", noRealSecrets: true as const },
  { path: "linked.json", noRealSecrets: true as const },
  { path: "via/inner.json", noRealSecrets: true as const },
];

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

interface World {
  readonly boxes: FakeBoxes;
  readonly workers: BoxWorkers;
  readonly log: string[];
  readonly holds: AdapterHolds;
  readonly notices: HoldNotice[];
  readonly warnings: { message: string; fields: Readonly<Record<string, unknown>> }[];
  readonly git: OfficeGit;
  readonly commit: string;
  readonly runDir: string;
  readonly systemFile: string;
  readonly tmp: string;
  readonly indexDir: string;
  readonly base: string;
}

interface WorldOptions {
  readonly boxes?: ConstructorParameters<typeof FakeBoxes>[0];
  readonly packageCache?: string;
  readonly sticky?: boolean;
  readonly modelFails?: boolean;
  /** The box door (DIPO-272); no queue is read without it. */
  readonly door?: BoxWorkersDeps["door"];
  /** The tree check (DIPO-294); none without it. */
  readonly treeCheck?: BoxWorkersDeps["treeCheck"];
  /** A `.gitignore` in the start commit. */
  readonly gitignore?: string;
}

/**
 * A repository with tracked code, its real `_base` checkout (`ensureBaseWorktree`), files outside
 * git in the main checkout (listed and unlisted), and the box workers on the fake backend with
 * logging routes.
 */
async function world(repo: TempRepo, tmp: string, options: WorldOptions = {}): Promise<World> {
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src", "greet.ts"), "export const greet = () => 'hi';\n");
  writeFileSync(join(repo.dir, "README.md"), "# repo\n");
  if (options.gitignore !== undefined)
    writeFileSync(join(repo.dir, ".gitignore"), options.gitignore);
  const commit = await repo.commitAll("start");
  await repo.git("update-ref", "refs/remotes/origin/main", commit);
  const git = officeGit(repo.dir, repo.env);
  // dipo's real `_base` checkout: clean, so it never holds a file outside git.
  const base = (await git.ensureBaseWorktree()).path;
  // Outside git in the main checkout: the listed file, unlisted ones, a listed symlink and a
  // listed file behind a symlinked folder.
  mkdirSync(join(repo.dir, "config"), { recursive: true });
  writeFileSync(join(repo.dir, "config", "local.json"), '{"local":true}\n');
  writeFileSync(join(repo.dir, ".env"), "TOKEN=real\n");
  writeFileSync(join(repo.dir, "notes.txt"), "mine\n");
  writeFileSync(join(tmp, "outside.json"), "{}\n");
  symlinkSync(join(tmp, "outside.json"), join(repo.dir, "linked.json"));
  mkdirSync(join(repo.dir, "real-folder"));
  writeFileSync(join(repo.dir, "real-folder", "inner.json"), "{}\n");
  symlinkSync(join(repo.dir, "real-folder"), join(repo.dir, "via"));

  const log = options.boxes?.log ?? [];
  const boxes = new FakeBoxes({ ...options.boxes, log });
  const notices: HoldNotice[] = [];
  const holds = new AdapterHolds({
    clock: new ManualClock(),
    notify: (notice) => notices.push(notice),
    ...(options.sticky === true
      ? { sticky: boxTokenStickyHolds(boxTokenHoldPath(tmp), ADAPTER) }
      : {}),
  });
  const caFile = join(tmp, "route-ca.pem");
  writeFileSync(caFile, CA);
  const route =
    (what: string) =>
    async (network: { hostAddress: string }): Promise<BoxWebRouteStart> => {
      log.push(`${what} started on ${network.hostAddress}`);
      return {
        ok: true,
        route: {
          host: network.hostAddress,
          port: 3128,
          url: `http://${network.hostAddress}:3128`,
          caFile,
          stop: async () => {
            log.push(`${what} stopped`);
          },
        },
      };
    };
  const token = new SecretToken(TOKEN);
  const warnings: World["warnings"] = [];
  const indexDir = join(tmp, "state", BOX_INDEX_DIR);
  const workers = new BoxWorkers({
    boxes,
    startWebRoute: route("web route"),
    startBuildRoute: route("build route"),
    startModelProxy: async (network): Promise<RunningModelProxy> => {
      log.push(`model proxy started on ${network.hostAddress}`);
      if (options.modelFails === true) throw new BoxError("token.missing", "no box login");
      return {
        hostAddress: network.hostAddress,
        port: 4000,
        url: `http://${network.hostAddress}:4000`,
        scanner: () => token.scanner(),
        redact: (text) => token.redact(text),
        stop: async () => {
          log.push("model proxy stopped");
        },
      };
    },
    readBaseBox: async (): Promise<BaseBox> =>
      ({
        ok: true,
        description: { image: IMAGE, files: LISTED },
        detected: {},
        commit,
      }) as unknown as BaseBox,
    code: { spawn: systemSpawn, clock: systemClock },
    holds,
    adapter: ADAPTER,
    tmpRoot: tmp,
    indexDir,
    scratchRoot: tmp,
    ...(options.packageCache === undefined ? {} : { packageCache: () => options.packageCache }),
    ...(options.door === undefined ? {} : { door: options.door }),
    ...(options.treeCheck === undefined ? {} : { treeCheck: options.treeCheck }),
    warn: (message, fields) => warnings.push({ message, fields }),
  });
  const runDir = join(tmp, "runs", RUN);
  mkdirSync(runDir, { recursive: true });
  const systemFile = join(runDir, "system.md");
  writeFileSync(systemFile, "# system\n");
  return {
    boxes,
    workers,
    log,
    holds,
    notices,
    warnings,
    git,
    commit,
    runDir,
    systemFile,
    tmp,
    indexDir,
    base,
  };
}

async function created(w: World): Promise<void> {
  await w.workers.create({
    office: OFFICE,
    runId: RUN,
    runDir: w.runDir,
    git: w.git,
    startCommit: w.commit,
  });
}

function inBoxes(fn: (repo: TempRepo, tmp: string) => Promise<void>): Promise<void> {
  return withTempRepo((repo) => withTempDir((tmp) => fn(repo, realpathSync(tmp))));
}

describe("the code a box gets (criterion 5)", () => {
  it("is a plain copy of the start commit with no .git, plus only the listed files from the main checkout", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      // The real `_base` is clean: the listed file was never there to copy.
      expect(existsSync(join(w.base, "config", "local.json"))).toBe(false);
      expect(existsSync(join(w.base, "README.md"))).toBe(true);
      // A change after the start commit, committed or not, is not the box's.
      writeFileSync(join(repo.dir, "README.md"), "# changed later\n");
      await created(w);
      const box = w.boxes.boxes.get(BOX);
      const code = box?.copies.find((copy) => copy.to === "/work");
      expect(code?.listing).toEqual([
        "README.md",
        "config/",
        "config/local.json",
        "src/",
        "src/greet.ts",
      ]);
      expect(code?.listing.some((path) => path.startsWith(".git"))).toBe(false);
      expect(code?.listing).not.toContain(".env");
      expect(code?.listing).not.toContain("notes.txt");
      // The listed file that is missing, the listed symlink and the one behind a symlinked folder
      // are left out, and said so.
      expect(w.warnings.map((warning) => [warning.fields["path"], warning.fields["why"]])).toEqual([
        ["missing.json", "missing in the main checkout"],
        ["linked.json", "not a regular file (a symlink or a folder)"],
        ["via/inner.json", "via on its way is a symlink"],
      ]);
      // The stage folder is gone again.
      expect(readdirSync(tmp).filter((name) => name.startsWith(CODE_STAGE_PREFIX))).toEqual([]);
    }));

  it("never lets a listed file replace a tracked one", () =>
    inBoxes(async (repo, tmp) => {
      writeFileSync(join(repo.dir, "config.json"), "{}\n");
      mkdirSync(join(repo.dir, "config"));
      writeFileSync(join(repo.dir, "config", "local.json"), '{"tracked":true}\n');
      const w = await world(repo, tmp);
      await created(w);
      expect(w.warnings.map((warning) => warning.fields["why"])).toContain(
        "a file of that path is in the start commit",
      );
    }));
});

/** A git session whose one step, the filter driver listing, exits `code`. */
function listingSession(code: number, stdout = ""): GitSession {
  return {
    repository: { kind: "repository", commonDir: "/x/.git" },
    step: async () => ({ code, stdout, stderr: "" }),
    ok: async () => "",
  } as unknown as GitSession;
}

describe("the archive of the start commit", () => {
  it("is refused when git cannot list its filter drivers", async () => {
    expect(await filtersOffConfig(listingSession(1))).toEqual([...BASE_CHECKOUT_CONFIG]);
    expect(
      await filtersOffConfig(listingSession(0, "filter.lfs.smudge\nfilter.evil.process\n")),
    ).toEqual([
      ...BASE_CHECKOUT_CONFIG,
      ["filter.lfs.smudge", ""],
      ["filter.lfs.process", ""],
      ["filter.lfs.required", "false"],
      ["filter.evil.smudge", ""],
      ["filter.evil.process", ""],
      ["filter.evil.required", "false"],
    ]);
    for (const code of [3, 128]) {
      const error = (await filtersOffConfig(listingSession(code)).catch(
        (e: unknown) => e,
      )) as BoxError;
      expect(error).toBeInstanceOf(BoxError);
      expect(error.code).toBe("box.refused");
    }
  });

  it("runs no filter program a filter= attribute in the commit names", () =>
    inBoxes(async (repo, tmp) => {
      const marker = join(tmp, "filter-ran");
      writeFileSync(join(repo.dir, ".gitattributes"), "* filter=evil\n");
      const w = await world(repo, tmp);
      // The repository's own config defines the driver; the archive must run neither command.
      await repo.git("config", "filter.evil.smudge", `touch ${marker}; cat`);
      await repo.git("config", "filter.evil.process", `touch ${marker}`);
      await repo.git("config", "filter.evil.required", "true");
      await created(w);
      expect(existsSync(marker)).toBe(false);
      const code = w.boxes.boxes.get(BOX)?.copies.find((copy) => copy.to === "/work");
      expect(code?.listing).toContain("src/greet.ts");
    }));
});

describe("the box of a box run (criteria 4 and 10)", () => {
  it("gets the office image and the box network, no Mac folder, and the proxies only once it runs", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      const box = w.boxes.boxes.get(BOX);
      expect(box?.spec).toEqual({
        runId: RUN,
        image: boxImageTag(IMAGE),
        network: { name: "dipo-boxes", mode: "hostOnly", hostAddress: BOX_HOST_ADDRESS },
      });
      expect(box?.spec.packageCache).toBeUndefined();
      // The image was built through the build route on the builder's network, stopped after.
      expect(w.log).toContain(`build route started on ${BUILD_HOST_ADDRESS}`);
      expect(w.log.indexOf("build route stopped")).toBeLessThan(w.log.indexOf(`create ${BOX}`));
      // Making the box starts no proxy of the box network.
      expect(w.log.filter((line) => line.includes(BOX_HOST_ADDRESS))).toEqual([]);

      const session = await w.workers.session({
        runId: RUN,
        runDir: w.runDir,
        systemFile: w.systemFile,
      });
      const started = w.log.indexOf(`start ${BOX}`);
      expect(started).toBeGreaterThanOrEqual(0);
      expect(w.log.indexOf(`web route started on ${BOX_HOST_ADDRESS}`)).toBeGreaterThan(started);
      expect(w.log.indexOf(`model proxy started on ${BOX_HOST_ADDRESS}`)).toBeGreaterThan(started);
      expect(session.env).toEqual({
        ANTHROPIC_API_KEY: BOX_PLACEHOLDER_API_KEY,
        ANTHROPIC_BASE_URL: `http://${BOX_HOST_ADDRESS}:4000`,
        NO_PROXY: BOX_HOST_ADDRESS,
        HTTPS_PROXY: `http://${BOX_HOST_ADDRESS}:3128`,
        HTTP_PROXY: `http://${BOX_HOST_ADDRESS}:3128`,
        NODE_EXTRA_CA_CERTS: BOX_CA_FILE,
      });
      expect(JSON.stringify(session)).not.toContain(TOKEN);
      expect(session.systemFile).toBe(BOX_SYSTEM_FILE);
      expect(box?.copies.find((copy) => copy.to === "/dipo")?.listing).toEqual([
        "safe-chain-ca.pem",
        "system.md",
      ]);
      expect(readBoxRun(w.runDir)).toEqual({ runId: RUN, office: OFFICE, box: BOX });
      expect(w.workers.isBoxRun(w.runDir)).toBe(true);
    }));

  it("installs dipo's own dipo-part command in the box it makes, after the code (DIPO-272)", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      expect(w.log.indexOf(`copy in ${BOX} ${DIPO_PART_PATH}`)).toBeGreaterThan(
        w.log.indexOf(`copy in ${BOX} /work`),
      );
      expect(w.log).toContain(`exec ${BOX} /bin/chmod`);
      // Without the door no queue is read.
      await w.workers.session({ runId: RUN, runDir: w.runDir, systemFile: w.systemFile });
      expect(w.workers.readDoor(RUN)).toBeNull();
    }));

  it("reads the box's part queue only while a session runs, when the door is given (DIPO-272)", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, { door: { pollMs: 60_000 } });
      await created(w);
      expect(w.workers.readDoor(RUN)).toBeNull();
      await w.workers.session({ runId: RUN, runDir: w.runDir, systemFile: w.systemFile });
      // The fake backend runs no live exec, so the read reaches the box and fails there.
      const error = await w.workers.readDoor(RUN)?.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      await w.workers.finish(RUN);
      expect(w.workers.readDoor(RUN)).toBeNull();
    }));

  it("starts no proxy when the box does not start, and deletes the box", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, {
        boxes: { startFails: new BoxError("box.failed", "the VM did not boot") },
      });
      const error = (await created(w).catch((e: unknown) => e)) as BoxError;
      expect(error.message).toContain("the VM did not boot");
      expect(w.log.filter((line) => line.includes(BOX_HOST_ADDRESS))).toEqual([]);
      expect(w.boxes.boxes.has(BOX)).toBe(false);
      expect(readBoxRun(w.runDir)?.finished).toBe(true);
    }));

  it("mounts the office package cache read-only only when one is given (the DIPO-267 seam)", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, { packageCache: "/opt/dipo/cache/office" });
      await created(w);
      expect(w.boxes.boxes.get(BOX)?.spec.packageCache).toBe("/opt/dipo/cache/office");
    }));

  it("refuses a new box while the box-token hold stands, before anything is made (criterion 8)", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, { sticky: true });
      w.holds.hold(ADAPTER, [{ check: BOX_TOKEN_CHECK, detail: "the token was found" }]);
      const error = (await created(w).catch((e: unknown) => e)) as BoxError;
      expect(error.code).toBe("box.held");
      expect(w.log).toEqual([]);
    }));
});

describe("the end of a box run (criterion 9)", () => {
  it("runs the post-run token check, deletes the box and stops the routes after the last box", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      await w.workers.session({ runId: RUN, runDir: w.runDir, systemFile: w.systemFile });
      w.log.length = 0;
      const finished = await w.workers.finish(RUN);
      expect(finished).toEqual({
        kind: "checked",
        check: { ok: true, code: "box.tokenAbsent", hold: false },
      });
      expect(w.log).toEqual([
        "list",
        `exec ${BOX} sh`,
        `export ${BOX}`,
        `delete ${BOX}`,
        "web route stopped",
        "model proxy stopped",
      ]);
      expect(w.holds.adapterHeld(ADAPTER)).toBeNull();
      expect(readBoxRun(w.runDir)?.finished).toBe(true);
      expect(w.workers.pending()).toEqual([]);
      // A later session of the run has no box: rebuilding one is DIPO-278's.
      const gone = (await w.workers
        .session({ runId: RUN, runDir: w.runDir, systemFile: w.systemFile })
        .catch((e: unknown) => e)) as BoxError;
      expect(gone.code).toBe("box.gone");
    }));

  it("holds the adapter, sticky, when the token is in the box, and still deletes the box", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, {
        sticky: true,
        boxes: { exportText: `leaked ${TOKEN} here` },
      });
      await created(w);
      const finished = await w.workers.finish(RUN);
      expect(finished).toMatchObject({ kind: "checked", check: { code: "box.tokenFound" } });
      const hold = w.holds.adapterHeld(ADAPTER);
      expect(hold?.check).toBe(BOX_TOKEN_CHECK);
      expect(hold?.liftedBy).toBeDefined();
      expect(existsSync(boxTokenHoldPath(tmp))).toBe(true);
      expect(readFileSync(boxTokenHoldPath(tmp), "utf8")).not.toContain(TOKEN);
      expect(w.boxes.boxes.has(BOX)).toBe(false);
    }));

  it("holds the adapter when the check cannot even start, and keeps the box for the next pass", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, { modelFails: true });
      await created(w);
      const finished = await w.workers.finish(RUN);
      expect(finished.kind).toBe("failed");
      const hold = w.holds.adapterHeld(ADAPTER);
      expect(hold?.check).toBe(BOX_TOKEN_CHECK);
      expect(hold?.detail).toContain("(token.missing)");
      expect(w.boxes.boxes.has(BOX)).toBe(true);
      expect(w.workers.pending()).toEqual([RUN]);
    }));

  it("starts a stopped box for the check, which reads the running box's environment", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      await w.boxes.stop(BOX);
      w.log.length = 0;
      await w.workers.finish(RUN);
      expect(w.log.slice(0, 3)).toEqual([
        "list",
        `start ${BOX}`,
        `model proxy started on ${BOX_HOST_ADDRESS}`,
      ]);
      expect(w.log).toContain(`exec ${BOX} sh`);
    }));

  it("finishes only the runs that ended, also after a daemon restart", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      expect(await w.workers.finishEnded(() => false)).toEqual([]);
      expect(await w.workers.finishEnded(() => null)).toEqual([]);
      expect(w.boxes.boxes.has(BOX)).toBe(true);
      // A new daemon: its box workers find the run in the index.
      const restarted = new BoxWorkers({
        boxes: w.boxes,
        startWebRoute: async () => ({ ok: false, reason: "not needed" }),
        startBuildRoute: async () => ({ ok: false, reason: "not needed" }),
        startModelProxy: async (network) => ({
          hostAddress: network.hostAddress,
          port: 4000,
          url: "",
          scanner: () => new SecretToken(TOKEN).scanner(),
          redact: (text) => text,
          stop: async () => {},
        }),
        readBaseBox: async () => ({ ok: false, errors: [] }),
        code: { spawn: systemSpawn, clock: systemClock },
        holds: w.holds,
        adapter: ADAPTER,
        tmpRoot: tmp,
        indexDir: w.indexDir,
        scratchRoot: tmp,
      });
      expect(restarted.pending()).toEqual([RUN]);
      expect(await restarted.finishEnded((runId) => runId === RUN)).toEqual([RUN]);
      expect(w.boxes.boxes.has(BOX)).toBe(false);
      expect(readBoxRun(w.runDir)?.finished).toBe(true);
      expect(restarted.pending()).toEqual([]);
    }));

  it("finishes, at daemon start, an ended box the index lost, through the backend's list", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      // The index lost the box (its file is gone), the backend still lists it.
      rmSync(join(w.indexDir, BOX), { force: true });
      expect(w.workers.pending()).toEqual([]);
      expect(await w.workers.finishEnded((runId) => runId === RUN)).toEqual([]);
      expect(await w.workers.finishEnded((runId) => runId === RUN, { listBoxes: true })).toEqual([
        RUN,
      ]);
      expect(w.boxes.boxes.has(BOX)).toBe(false);
    }));

  it("keeps the index in the state folder, private", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      expect(readdirSync(w.indexDir)).toEqual([BOX]);
      expect(statSync(w.indexDir).mode & 0o777).toBe(0o700);
    }));

  it("deletes the box of a launch whose worker never ran, without the check", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      w.log.length = 0;
      await w.workers.discard(RUN);
      expect(w.log).toEqual([`delete ${BOX}`]);
      expect(w.workers.pending()).toEqual([]);
    }));
});

describe("a new session in a box that already runs (an orphaned claude)", () => {
  it("stops and starts the box again, so no earlier process survives into the new session", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      // The first session right after create: no worker ran yet, so the box is not restarted.
      w.log.length = 0;
      await w.workers.session({ runId: RUN, runDir: w.runDir, systemFile: w.systemFile });
      expect(w.log.filter((line) => line.startsWith("stop ") || line.startsWith("start "))).toEqual(
        [],
      );
      // Its host was killed with SIGKILL: claude still runs in the box.
      const box = w.boxes.boxes.get(BOX)!;
      box.workerRunning = true;
      w.log.length = 0;
      await w.workers.session({ runId: RUN, runDir: w.runDir, systemFile: w.systemFile });
      expect(w.log.slice(0, 3)).toEqual(["list", `stop ${BOX}`, `start ${BOX}`]);
      expect(box.workerRunning).toBe(false);
      expect(box.state).toBe("running");
    }));

  it("starts a stopped box without stopping it first", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      await w.workers.session({ runId: RUN, runDir: w.runDir, systemFile: w.systemFile });
      await w.boxes.stop(BOX);
      w.log.length = 0;
      await w.workers.session({ runId: RUN, runDir: w.runDir, systemFile: w.systemFile });
      expect(w.log.slice(0, 2)).toEqual(["list", `start ${BOX}`]);
    }));
});

describe("daemon stop (criterion 6)", () => {
  it("stops every running box, which ends the worker in it, and the routes", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      await w.workers.session({ runId: RUN, runDir: w.runDir, systemFile: w.systemFile });
      const box = w.boxes.boxes.get(BOX)!;
      box.workerRunning = true;
      w.log.length = 0;
      await w.workers.close();
      expect(w.log).toEqual(["list", `stop ${BOX}`, "web route stopped", "model proxy stopped"]);
      expect(box.workerRunning).toBe(false);
      // The box keeps its files for the run's next session.
      expect(w.boxes.boxes.has(BOX)).toBe(true);
    }));

  it("calls no backend when no box run is pending", () =>
    withTempDir(async (tmp) => {
      const log: string[] = [];
      const workers = new BoxWorkers({
        boxes: new FakeBoxes({ log }),
        startWebRoute: async () => ({ ok: false, reason: "unused" }),
        startBuildRoute: async () => ({ ok: false, reason: "unused" }),
        startModelProxy: async () => {
          throw new Error("unused");
        },
        readBaseBox: async () => ({ ok: false, errors: [] }),
        code: { spawn: systemSpawn, clock: systemClock },
        holds: new AdapterHolds({ clock: new ManualClock(), notify: () => {} }),
        adapter: ADAPTER,
        tmpRoot: tmp,
        indexDir: join(tmp, "state", BOX_INDEX_DIR),
        scratchRoot: tmp,
      });
      expect(await workers.finishEnded(() => true)).toEqual([]);
      // A state folder whose boxes never ran: the second layer does not ask the backend either.
      expect(await workers.finishEnded(() => true, { listBoxes: true })).toEqual([]);
      await workers.close();
      expect(log).toEqual([]);
      expect(existsSync(join(tmp, BOX_RUN_FILE))).toBe(false);
    }));
});

/** The install of the run in its box, with a run environment for /work. */
function installIn(w: World, timeoutMs = 15 * 60_000) {
  return w.workers.install({
    runId: RUN,
    commands: [["bun", "install", "--frozen-lockfile"]],
    env: { DIPO_STORY: "DIPO-1", DIPO_WORKTREE: "/work" },
    timeoutMs,
  });
}

const INSTALL = ["bun", "install", "--frozen-lockfile"];
const isInstall = (command: readonly string[]) => command.join(" ") === INSTALL.join(" ");

describe("the install in the box before the worker (DIPO-294)", () => {
  it("runs in /work with the run environment and the web route, CA bundle and Safe-Chain a session gets", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, {
        boxes: { live: () => ({ stdout: "120 packages installed\n" }) },
      });
      await created(w);
      w.log.length = 0;
      expect(await installIn(w)).toEqual({ ok: true });
      // The web route starts once the box runs, the CA bundle goes in, then the install: no
      // model proxy, no restart of the box.
      expect(w.log).toEqual([
        `web route started on ${BOX_HOST_ADDRESS}`,
        `copy in ${BOX} /dipo`,
        `exec live ${BOX} bun install --frozen-lockfile`,
      ]);
      expect(w.boxes.liveExecs).toEqual([
        {
          box: BOX,
          command: INSTALL,
          cwd: "/work",
          env: {
            DIPO_STORY: "DIPO-1",
            DIPO_WORKTREE: "/work",
            HTTPS_PROXY: `http://${BOX_HOST_ADDRESS}:3128`,
            HTTP_PROXY: `http://${BOX_HOST_ADDRESS}:3128`,
            NODE_EXTRA_CA_CERTS: BOX_CA_FILE,
          },
        },
      ]);
      expect(w.boxes.boxes.get(BOX)?.copies.at(-1)?.listing).toEqual(["safe-chain-ca.pem"]);
      // The session then gets the same route and CA, started once, in the box create made.
      w.log.length = 0;
      const session = await w.workers.session({
        runId: RUN,
        runDir: w.runDir,
        systemFile: w.systemFile,
      });
      expect(w.log).not.toContain(`stop ${BOX}`);
      expect(w.log).not.toContain(`web route started on ${BOX_HOST_ADDRESS}`);
      const env = w.boxes.liveExecs[0]?.env ?? {};
      for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NODE_EXTRA_CA_CERTS"]) {
        expect(env[name]).toBe(session.env[name] as string);
      }
      expect(w.workers.routeUsers.web).toEqual([BOX]);
    }));

  it("says why a failed install failed, keeps the box's output out of the reason, and logs its tail", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, {
        boxes: {
          live: () => ({
            stdout: "error: lockfile had changes, but lockfile is frozen\n",
            code: 1,
          }),
        },
      });
      await created(w);
      const result = await installIn(w);
      expect(result).toEqual({
        ok: false,
        reason: "the install (bun install --frozen-lockfile) exited 1 in the box",
        output: "error: lockfile had changes, but lockfile is frozen\n",
        ended: null,
      });
      const warning = w.warnings.find((x) => x.message === "the install in the box failed");
      expect(warning?.fields["output"]).toContain("lockfile had changes");
      // Only the first failing command list runs.
      expect(w.boxes.liveExecs).toHaveLength(1);
    }));

  it("runs the command lists in order and stops at the first that fails", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, {
        boxes: { live: (_box, command) => ({ code: command[0] === "second" ? 2 : 0 }) },
      });
      await created(w);
      const result = await w.workers.install({
        runId: RUN,
        commands: [["first"], ["second", "x"], ["third"]],
        env: {},
        timeoutMs: 60_000,
      });
      expect(result.ok ? "" : result.reason).toBe("the install (second x) exited 2 in the box");
      expect(w.boxes.liveExecs.map((exec) => exec.command[0])).toEqual(["first", "second"]);
    }));

  it("times out at the office's deadline, ends the install in the box, and says so", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, {
        boxes: { live: (_box, command) => (isInstall(command) ? { hang: true } : { code: 0 }) },
      });
      await created(w);
      const result = await installIn(w, 30);
      expect(result).toMatchObject({ ok: false, ended: "killed" });
      expect(result.ok ? "" : result.reason).toMatch(
        /^the install \(bun install --frozen-lockfile\) timed out after [0-9.]+ min in the box$/,
      );
      // dipo's kill in the box ran after its deadline.
      expect(w.boxes.liveExecs.map((exec) => exec.command[0])).toEqual(["bun", "/bin/sh"]);
    }));

  it("says when a timed-out install could be ended neither in the box nor by stopping it, and the box is still deleted", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp, {
        boxes: {
          // The install hangs, the kill in the box finds it still running, and the box cannot stop.
          live: (_box, command) => (isInstall(command) ? { hang: true } : { code: 1 }),
          stopFails: new BoxError("box.failed", "the box would not stop"),
        },
      });
      await created(w);
      const result = await installIn(w, 30);
      expect(result).toMatchObject({ ok: false, ended: "failed" });
      expect(result.ok ? "" : result.reason).toMatch(
        /^the install \(bun install --frozen-lockfile\) timed out after [0-9.]+ min in the box, and could be ended neither inside the box nor by stopping it$/,
      );
      expect(w.log).toContain(`stop ${BOX}`);
      // The failed launch then deletes the box (`discard`), which ends what still runs in it.
      await w.workers.discard(RUN);
      expect(w.boxes.boxes.has(BOX)).toBe(false);
      expect(w.workers.routeUsers.web).toEqual([]);
    }));

  it("says when the box stopped under the install", () =>
    inBoxes(async (repo, tmp) => {
      let w: World | null = null;
      w = await world(repo, tmp, {
        boxes: {
          live: () => {
            const box = w?.boxes.boxes.get(BOX);
            if (box !== undefined) box.state = "stopped";
            return { code: 137 };
          },
        },
      });
      await created(w);
      const result = await installIn(w);
      expect(result.ok ? "" : result.reason).toBe(
        "the box stopped while the install (bun install --frozen-lockfile) ran",
      );
    }));
});

/** Packs a host folder as the box's `tar` would: the bytes of a tar archive of it. */
function tarOf(dir: string): Uint8Array {
  const packed = spawnSync("tar", ["-C", dir, "-cf", "-", "."], {
    env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (packed.status !== 0) throw new Error(`tar failed: ${String(packed.stderr)}`);
  return new Uint8Array(packed.stdout);
}

/**
 * A world whose fake boxes keep their files, whose `tar` in the box packs the box's `/work`, and
 * whose tree check is the real `BoxParts.changedSinceStart` on the office's git; `install` is
 * what the install does to `/work`.
 */
async function treeWorld(
  repo: TempRepo,
  tmp: string,
  install: (work: string) => void,
  limits?: BoxPartsDeps["limits"],
): Promise<World> {
  let parts: BoxParts | null = null;
  let boxes: FakeBoxes | null = null;
  const w = await world(repo, tmp, {
    gitignore: "node_modules/\n*.log\n",
    boxes: {
      files: join(tmp, "box-files"),
      live: (box, command) => {
        const work = (boxes as FakeBoxes).filesOf(box, "/work");
        if (command[0] === "tar") return { bytes: tarOf(work) };
        install(work);
        return { code: 0 };
      },
    },
    treeCheck: (run) => (parts as BoxParts).changedSinceStart(run),
  });
  boxes = w.boxes;
  parts = new BoxParts({
    boxes: w.boxes,
    clock: systemClock,
    tmpRoot: tmp,
    run: () => null,
    git: () => w.git,
    listedFiles: async () => LISTED.map((file) => file.path),
    live: () => true,
    ...(limits === undefined ? {} : { limits }),
  });
  return w;
}

const TREE_FACTS = { runId: RUN, office: OFFICE, story: "DIPO-1", branch: "DIPO-1/x" };

describe("the check of /work after the install (DIPO-294)", () => {
  it("finds /work the same when the install wrote only paths git ignores, beside the listed files", () =>
    inBoxes(async (repo, tmp) => {
      const w = await treeWorld(repo, tmp, (work) => {
        mkdirSync(join(work, "node_modules", "left-pad"), { recursive: true });
        writeFileSync(join(work, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
        writeFileSync(join(work, "install.log"), "done\n");
      });
      await created(w);
      expect(await installIn(w)).toEqual({ ok: true });
      expect(existsSync(join(w.boxes.filesOf(BOX, "/work"), "config", "local.json"))).toBe(true);
      expect(await w.workers.changedSinceStart({ ...TREE_FACTS, startSha: w.commit })).toEqual({
        kind: "same",
      });
      // The archive came out of the box through dipo's own `tar`, never a git call on it.
      expect(w.boxes.liveExecs.map((exec) => exec.command[0])).toEqual(["bun", "tar"]);
    }));

  it("names every file git does not ignore that the install added, changed or deleted", () =>
    inBoxes(async (repo, tmp) => {
      const w = await treeWorld(repo, tmp, (work) => {
        writeFileSync(join(work, "src", "greet.ts"), "export const greet = () => 'changed';\n");
        writeFileSync(join(work, "bun.lock"), "{}\n");
        rmSync(join(work, "README.md"));
      });
      await created(w);
      expect(await installIn(w)).toEqual({ ok: true });
      expect(await w.workers.changedSinceStart({ ...TREE_FACTS, startSha: w.commit })).toEqual({
        kind: "changed",
        paths: ["README.md", "bun.lock", "src/greet.ts"],
      });
    }));

  it("counts a symlink the install wrote outside the ignored paths as a change", () =>
    inBoxes(async (repo, tmp) => {
      const w = await treeWorld(repo, tmp, (work) => {
        symlinkSync("greet.ts", join(work, "src", "alias.ts"));
        // One in an ignored folder is not a change.
        mkdirSync(join(work, "node_modules", ".bin"), { recursive: true });
        symlinkSync("../left-pad/cli.js", join(work, "node_modules", ".bin", "left-pad"));
      });
      await created(w);
      expect(await installIn(w)).toEqual({ ok: true });
      expect(await w.workers.changedSinceStart({ ...TREE_FACTS, startSha: w.commit })).toEqual({
        kind: "changed",
        paths: ["src/alias.ts"],
      });
    }));

  it("is not known, with the cap named and no path, when the archive of /work passes its cap", () =>
    inBoxes(async (repo, tmp) => {
      const w = await treeWorld(
        repo,
        tmp,
        (work) => writeFileSync(join(work, "vendor.bin"), "x".repeat(64 * 1024)),
        { maxArchiveBytes: 16 * 1024, maxEntries: 1000, maxTotalBytes: 1024 * 1024 },
      );
      await created(w);
      expect(await installIn(w)).toEqual({ ok: true });
      const check = await w.workers.changedSinceStart({ ...TREE_FACTS, startSha: w.commit });
      expect(check).toEqual({
        kind: "unknown",
        reason:
          "the archive of the box's /work passed 16384 bytes; files git should ignore (such as node_modules) may be missing from .gitignore",
      });
      expect(JSON.stringify(check)).not.toContain("vendor.bin");
    }));

  it("compares with the start commit, not with a branch tip", () =>
    inBoxes(async (repo, tmp) => {
      const w = await treeWorld(repo, tmp, () => undefined);
      await created(w);
      // A later commit on main is not what the box got.
      writeFileSync(join(repo.dir, "src", "later.ts"), "export const later = 1;\n");
      await repo.commitAll("later");
      expect(
        await w.workers.changedSinceStart({ ...TREE_FACTS, branch: "main", startSha: w.commit }),
      ).toEqual({ kind: "same" });
    }));

  it("is not known when the box's files cannot be read, or without the tree check", () =>
    inBoxes(async (repo, tmp) => {
      const w = await treeWorld(repo, tmp, () => undefined);
      await created(w);
      // A start commit git does not have: dipo cannot read the tree to compare with.
      const unknown = await w.workers.changedSinceStart({
        ...TREE_FACTS,
        startSha: "0".repeat(40),
      });
      expect(unknown).toEqual({ kind: "unknown", reason: "dipo could not read the box's /work" });
    }));

  it("is not known without the tree check", () =>
    inBoxes(async (repo, tmp) => {
      const w = await world(repo, tmp);
      await created(w);
      expect(await w.workers.changedSinceStart({ ...TREE_FACTS, startSha: w.commit })).toEqual({
        kind: "unknown",
        reason: "this daemon cannot compare the box's files with the start commit",
      });
    }));
});
