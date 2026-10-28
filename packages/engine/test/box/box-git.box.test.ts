// The box's own git repository and the verify at done on a real box (DIPO-346, 0008, 0002), opt-in:
// it registers only with DIPO_TEST_BOX=1 and never in CI. It needs macOS with Apple container
// 1.6.0 or newer and its service running and the internet (the
// web route builds its Safe-Chain box from the pinned release, DIPO-343): the office image (now with git) is built in a build box on its
// first run, which takes minutes. It needs no box login: no model session runs. The maintainer
// runs it by hand:
//
//   DIPO_TEST_BOX=1 bun test packages/engine/test/box/box-git.box.test.ts
//
// It makes one box of a small repository through `BoxWorkers.create`, then, as the worker would
// with the box user's commands:
// - the box holds its own repository: one commit of the start state, no remote, no hooks, the box
//   user's, and the Mac repository's config, refs and hooks are unchanged;
// - the office's verify runs in the box (`BoxWorkers.verify`): a test that needs git passes there,
//   and a red one comes back with its exit and output;
// - parts go through the real path (`BoxParts`: the tar stream out of the box, the extraction, the
//   scans and the commit from git objects): a part leaves the box without its `.git`, also after the
//   worker set `core.hooksPath` and a remote and committed in the box, and no hook runs on the Mac;
//   each bypass form is refused with nothing committed (a symlink to `.git`, a `.git` file below
//   the root, a nested repository); a root `.git` file with a `gitdir` pointer stays in the box;
// - fail closed: a box whose tar does not keep its `.git` in (the exclude dropped on its way to
//   the box, as if the in-box filter were undone) hands the Mac a changed `.git/config`, which is
//   refused, and nothing is committed or pushed.
// The test deletes the box it made; it stops or deletes nothing else, and keeps the image.

import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import {
  cleanEnv,
  ManualClock,
  type TempRepoWithRemote,
  withBareRemote,
  withTempDir,
} from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import { BOX_GIT_BRANCH, BOX_GIT_START_SUBJECT } from "../../src/box/box-git";
import { readBaseBox } from "../../src/box/image";
import { startModelProxy } from "../../src/box/model-proxy";
import {
  BOX_GIT_EXCLUDE,
  BoxParts,
  type PartPark,
  type PartRun,
  partStageRoot,
} from "../../src/box/parts";
import { type BoxPort, boxName } from "../../src/box/port";
import { startBoxWebRoute } from "../../src/box/safe-chain-box";
import { BOX_INDEX_DIR, BoxWorkers } from "../../src/box/workers";
import { OfficeGit, spawnGitExec } from "../../src/git";
import { systemListenHttp } from "../../src/platform/box-host";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";
import { AdapterHolds } from "../../src/workers/hold";

const registers =
  process.env["DIPO_TEST_BOX"] === "1" &&
  process.env["DIPO_TEST_CI"] !== "1" &&
  process.env["CI"] === undefined;

/** The image build on a cold builder, the box, the parts and the verifies. */
const TIMEOUT_MS = 45 * 60_000;
const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z0000GIT1" as OfficeId;
const BRANCH = "DIPO-1/box-git";
/** A test suite that needs git: it fails without a repository and its start commit. */
const GIT_TEST = `#!/bin/sh
set -eu
git rev-parse --verify HEAD >/dev/null
git log --format=%s | grep -qx '${BOX_GIT_START_SUBJECT}'
echo "git test passed"
`;

function fact(text: string): void {
  console.log(`fact: ${text}`);
}

/** What the Mac repository holds that the box must never reach: config, refs but the branch, hooks. */
async function macState(repo: TempRepoWithRemote): Promise<string> {
  const config = await repo.git("config", "--local", "--list");
  const refs = (await repo.git("for-each-ref", "--format=%(refname) %(objectname)"))
    .split("\n")
    .filter((line) => !line.includes(BRANCH))
    .join("\n");
  const hooks = readdirSync(join(repo.dir, ".git", "hooks"))
    .toSorted()
    .join(",");
  return [config, refs, hooks].join("\n--\n");
}

if (registers) {
  describe("the box's own git repository and the verify at done, on a real box", () => {
    it(
      "makes the repository, runs a git test as the verify, and keeps every form of .git out of the parts",
      async () => {
        const env = cleanEnv();
        const home = homedir();
        const cliEnv = { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: home };
        await withTempDir(async (tmp) => {
          await withBareRemote(async (repo) => {
            writeFileSync(join(repo.dir, "README.md"), "# a box git test\n");
            writeFileSync(join(repo.dir, "git-test.sh"), GIT_TEST, { mode: 0o755 });
            mkdirSync(join(repo.dir, "src"));
            writeFileSync(join(repo.dir, "src", "a.ts"), "export const a = 1;\n");
            const start = await repo.commitAll("start");
            await repo.git("push", "--quiet", "origin", "main");
            await repo.git("fetch", "--quiet", "origin");
            await repo.git("branch", BRANCH, start);
            await repo.git("push", "--quiet", "origin", BRANCH);
            const real = realpathSync(repo.dir);
            const git = new OfficeGit({
              officeId: OFFICE,
              mainWorktree: real,
              commonDir: join(real, ".git"),
              settings: { remote: "origin", base: "main" },
              runner: { exec: spawnGitExec(systemSpawn), env: repo.env, sleep: async () => {} },
              clock: new ManualClock(),
            });
            const boxes = new AppleContainerBoxes({
              spawn: systemSpawn,
              clock: systemClock,
              cli: "/usr/local/bin/container",
              env: cliEnv,
              netToolsRoot: join(tmp, "state", "box-net-tools"),
            });
            expect(await boxes.check()).toMatchObject({ ok: true });
            const workers = new BoxWorkers({
              boxes,
              startWebRoute: (network, ids) =>
                startBoxWebRoute(
                  network,
                  {
                    boxes,
                    clock: systemClock,
                    scratchRoot: tmp,
                    toolsRoot: join(tmp, "state", "box-net-tools"),
                    caFile: join(tmp, "route", "ca.pem"),
                    boxId: ids.boxId,
                    buildId: ids.buildId,
                  },
                  { clock: systemClock },
                ),
              // No session runs, so the model proxy never starts.
              startModelProxy: (network) =>
                startModelProxy({
                  network,
                  keychain: { spawn: systemSpawn, clock: systemClock, env: cliEnv },
                  listen: systemListenHttp,
                }),
              readBaseBox,
              code: { spawn: systemSpawn, clock: systemClock },
              holds: new AdapterHolds({ clock: systemClock, notify: () => {} }),
              adapter: "claude-cli",
              tmpRoot: tmp,
              indexDir: join(tmp, "state", BOX_INDEX_DIR),
              scratchRoot: tmp,
              netToolsRoot: join(tmp, "state", "box-net-tools"),
              warn: (message, fields) => fact(`${message} ${JSON.stringify(fields)}`),
            });
            const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
            const box = boxName(runId);
            const runDir = join(tmp, "runs", runId);
            mkdirSync(runDir, { recursive: true });
            const before = await macState(repo);
            /** A command of the worker's in the box, as the box user in /work. */
            const inBox = async (script: string): Promise<string> => {
              const ran = await boxes.exec(box, ["/bin/sh", "-c", script], { cwd: "/work" });
              if (ran.code !== 0) fact(`box command failed: ${script}: ${ran.stderr}`);
              expect(ran.code).toBe(0);
              return ran.stdout;
            };
            try {
              const made = performance.now();
              await workers.create({ office: OFFICE, runId, runDir, git, startCommit: start });
              fact(
                `the box with its repository was ready in ${Math.round(performance.now() - made)} ms`,
              );

              // 1. The box's own repository, the box user's, sharing nothing with the Mac's.
              expect((await inBox("git log --format=%s")).trim()).toBe(BOX_GIT_START_SUBJECT);
              expect((await inBox("git rev-parse --abbrev-ref HEAD")).trim()).toBe(BOX_GIT_BRANCH);
              expect((await inBox("git remote")).trim()).toBe("");
              expect((await inBox("git status --porcelain")).trim()).toBe("");
              expect((await inBox("stat -c %u .git")).trim()).toBe("1000");
              expect((await inBox("ls -A .git")).split("\n")).not.toContain("hooks");
              expect((await inBox("git for-each-ref --format='%(refname)'")).trim()).toBe(
                `refs/heads/${BOX_GIT_BRANCH}`,
              );

              // 2. The verify in the box: a test that needs git passes, a red one comes back.
              const installed = await workers.install({
                runId,
                commands: [],
                env: {},
                timeoutMs: 60_000,
              });
              expect(installed).toEqual({ ok: true });
              const green = await workers.verify({
                runId,
                commands: [["sh", "git-test.sh"]],
                cwd: ".",
                env: {},
                timeoutMs: 120_000,
              });
              fact(`the verify of a git test in the box: ${JSON.stringify(green)}`);
              expect(green).toEqual({ kind: "green", command: "sh git-test.sh" });
              const red = await workers.verify({
                runId,
                commands: [
                  ["sh", "-c", "git rev-parse HEAD; echo 'src/a.ts:1:1: error: red'; exit 3"],
                ],
                cwd: ".",
                env: {},
                timeoutMs: 120_000,
              });
              expect(red).toMatchObject({ kind: "red", exitCode: 3, timedOutMinutes: null });
              expect(red.kind === "red" ? red.output : "").toContain("src/a.ts:1:1: error: red");

              // 3. Parts through the real path.
              const parks: PartPark[] = [];
              const run: PartRun = {
                runId,
                office: OFFICE,
                story: "DIPO-1",
                branch: BRANCH,
                startSha: start,
                box,
                runDir,
              };
              const partsOf = (through: Pick<BoxPort, "execLive" | "stop">) =>
                new BoxParts({
                  boxes: through,
                  clock: systemClock,
                  stageRoot: partStageRoot(join(tmp, "state")),
                  run: (id) => (id === runId ? run : null),
                  git: (office) => (office === OFFICE ? git : undefined),
                  listedFiles: async () => [],
                  live: () => true,
                  park: (_id, park) => {
                    parks.push(park);
                    return true;
                  },
                  readDoor: () => null,
                });
              const parts = partsOf(boxes);
              let n = 0;
              const deliver = (message: string) =>
                parts.onPart({
                  runId,
                  box,
                  n: (n += 1),
                  name: `1700000000-${n}.part`,
                  message,
                  at: 0,
                });
              const tip = async () => (await repo.git("rev-parse", `refs/heads/${BRANCH}`)).trim();
              const remoteTip = async () =>
                (await repo.git("ls-remote", "origin", `refs/heads/${BRANCH}`)).split("\t")[0];

              // The worker uses its repository: a commit, a hooks path with a hook, a remote.
              const marker = join(tmp, "HOOK-RAN");
              await inBox(
                [
                  "echo 'export const a = 2;' > src/a.ts",
                  "git commit -qam 'Work in the box'",
                  "mkdir -p box-hooks",
                  `for hook in pre-commit post-commit reference-transaction pre-push; do printf '#!/bin/sh\\ntouch ${marker}\\n' > box-hooks/$hook; chmod +x box-hooks/$hook; done`,
                  "git config core.hooksPath /work/box-hooks",
                  "git remote add evil https://example.com/evil.git",
                ].join(" && "),
              );
              await deliver("Change a");
              expect(parks).toEqual([]);
              const first = await tip();
              const paths = (await repo.git("ls-tree", "-r", "--name-only", first)).split("\n");
              expect(paths.some((path) => path.split("/").includes(".git"))).toBe(false);
              expect(paths).toContain("box-hooks/pre-commit");
              expect(await repo.git("show", `${first}:src/a.ts`)).toBe("export const a = 2;\n");
              expect(await remoteTip()).toBe(first);
              expect(existsSync(marker)).toBe(false);
              expect(await macState(repo)).toBe(before);

              // Each bypass form is refused, and nothing is committed.
              for (const [what, plant, clean] of [
                ["a symlink to .git", "ln -s ../.git src/repo", "rm src/repo"],
                ["a symlink to .git/config", "ln -s ../.git/config src/config", "rm src/config"],
                [
                  "a .git file below the root",
                  "mkdir -p vendor/lib && echo 'gitdir: ../../.git' > vendor/lib/.git",
                  "rm -rf vendor",
                ],
                [
                  "a nested repository",
                  "mkdir -p vendor/nested && echo x > vendor/nested/x && git -C vendor/nested init -q",
                  "rm -rf vendor",
                ],
              ] as const) {
                parks.length = 0;
                await inBox(plant);
                await deliver(`Plant ${what}`);
                fact(`${what}: ${parks.map((park) => park.detail).join(" | ")}`);
                expect(parks).toHaveLength(1);
                expect(parks[0]?.reason).toBe("scope-violation");
                expect(await tip()).toBe(first);
                expect(await remoteTip()).toBe(first);
                await inBox(clean);
              }

              // Fail closed: the exclude dropped on its way to the box, so the stream carries the
              // box's .git with the changed config; the Mac refuses it and commits nothing.
              parks.length = 0;
              await inBox(
                "git config core.hooksPath hooks && echo 'export const a = 3;' > src/a.ts",
              );
              const leaky: Pick<BoxPort, "execLive" | "stop"> = {
                execLive: (name, command, options) =>
                  boxes.execLive(
                    name,
                    command.filter((arg) => arg !== `--exclude=${BOX_GIT_EXCLUDE}`) as [
                      string,
                      ...string[],
                    ],
                    options,
                  ),
                stop: (name) => boxes.stop(name),
              };
              await partsOf(leaky).onPart({
                runId,
                box,
                n: (n += 1),
                name: `1700000000-${n}.part`,
                message: "Carry the box's git config",
                at: 0,
              });
              fact(`a changed .git/config: ${parks.map((park) => park.detail).join(" | ")}`);
              expect(parks.map((park) => park.reason)).toEqual(["scope-violation"]);
              expect(parks[0]?.detail).toContain("git's own folder (.git)");
              expect(await tip()).toBe(first);
              expect(await remoteTip()).toBe(first);
              expect(await macState(repo)).toBe(before);

              // A root .git file with a gitdir pointer stays in the box.
              parks.length = 0;
              await inBox("rm -rf .git && echo 'gitdir: /home/dipo/elsewhere' > .git");
              await deliver("Change a again");
              expect(parks).toEqual([]);
              const last = await tip();
              expect(
                (await repo.git("ls-tree", "-r", "--name-only", last))
                  .split("\n")
                  .some((path) => path.split("/").includes(".git")),
              ).toBe(false);
              expect(await repo.git("show", `${last}:src/a.ts`)).toBe("export const a = 3;\n");
              expect(existsSync(marker)).toBe(false);
              expect(await macState(repo)).toBe(before);
            } finally {
              await boxes.delete(box).catch(() => {});
              await workers.close();
            }
          });
        });
      },
      TIMEOUT_MS,
    );
  });
}
