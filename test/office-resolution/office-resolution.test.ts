// The CLI resolves an office from the current directory (DIPO-27, AC #10) and the engine owns the
// office list. `cli` may not import `engine`, so this test sits outside both packages: it runs
// `dipo office forget|reload-config` through the CLI's `main` with its real git resolution, against
// an engine office manager on real temporary repositories, and checks that both sides resolve a
// repository to the same main worktree. An unopened `cp -r` copy of an office carries the
// original's marker; the CLI must never act on the original from inside it. It imports source files
// by path because the repository root has no package links.

import { describe, expect, it } from "bun:test";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  type CommandDefinition,
  type OfficeId,
  RequestId,
} from "../../packages/contract/src/index";
import {
  git,
  isolatedEnv,
  ManualClock,
  withTempDir,
  withTempRepo,
} from "../../packages/testkit/src/index";

import type { DaemonSession } from "../../packages/cli/src/daemon-commands";
import { main, type CliDeps } from "../../packages/cli/src/index";
import {
  isBacklogProject,
  locateRepository,
  readOfficeId,
  type Workspace,
} from "../../packages/cli/src/workspace";
import { executeCommand } from "../../packages/engine/src/commands/execute";
import { resolveRepository } from "../../packages/engine/src/office/repository";
import { systemSpawn } from "../../packages/engine/src/platform/process";
import {
  BACKLOG_FIXTURE,
  officeRows,
  officeSetup,
  resultOf,
  send,
  type OfficeSetup,
} from "../../packages/engine/test/office/helpers";

let requests = 0;

interface Cli {
  readonly out: string[];
  readonly err: string[];
  readonly questions: string[];
  run(args: string[]): Promise<number>;
}

/** The CLI in `cwd`, talking to the office manager of `s` through the one executor. */
function cli(
  s: OfficeSetup,
  cwd: string,
  env: Record<string, string>,
  answers: string[] = [],
): Cli {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const workspace: Workspace = {
    cwd,
    interactive: answers.length > 0,
    ask: async (question) => {
      questions.push(question);
      return answers.shift() ?? "";
    },
    locate: (path) => locateRepository(path, env),
    readOfficeId,
    isBacklogProject,
  };
  const session: DaemonSession = {
    command: (async (definition: CommandDefinition, args: unknown) => {
      requests += 1;
      const reply = await executeCommand(s.deps, {
        requestId: RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${String(90_000_000 + requests)}`),
        name: definition.name,
        args,
        origin: "cli",
        confirmed: false,
      });
      return reply.ok
        ? { ok: true, result: reply.result, changed: reply.changed }
        : { ok: false, error: reply.error };
    }) as DaemonSession["command"],
    subscribe: () => {
      throw new Error("subscribe must not be called");
    },
    close: () => undefined,
  };
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => 1,
    connectDaemon: async () => session,
    daemon: {
      inspect: () => Promise.reject(new Error("not used")),
      start: () => Promise.reject(new Error("not used")),
      stop: () => Promise.reject(new Error("not used")),
      restart: () => Promise.reject(new Error("not used")),
    },
    clock: new ManualClock(),
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace,
  };
  return { out, err, questions, run: (args) => main(args, deps) };
}

async function openOffice(s: OfficeSetup, path: string): Promise<OfficeId> {
  return resultOf<{ office: OfficeId }>(await send(s, "office.open", { path })).office;
}

describe("office resolution from the current directory", () => {
  it("never forgets or reloads the original office from inside an unopened copy", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const original = await openOffice(s, repo.dir);
        const copy = join(repo.root, "copy");
        cpSync(repo.dir, copy, { recursive: true });

        const forget = cli(s, join(copy, "backlog"), repo.env);
        expect(await forget.run(["office", "forget", "--yes"])).toBe(1);
        expect(forget.err).toEqual(["dipo: not an office, run `dipo office open`"]);
        const reload = cli(s, copy, repo.env);
        expect(await reload.run(["office", "reload-config"])).toBe(1);
        expect(reload.err).toEqual(["dipo: not an office, run `dipo office open`"]);
        expect(officeRows(s.state).map((row) => [row.office_id, row.forgotten_at])).toEqual([
          [original, null],
        ]);

        // At a terminal the copy is opened once (copy detection gives it its own id); forgetting it
        // is confirmed again because it is now another office.
        const asked = cli(s, copy, repo.env, ["y", "y", "y"]);
        expect(await asked.run(["office", "forget"])).toBe(0);
        expect(asked.questions).toEqual([
          `Forget the office at ${copy}? Its repository and history are kept, and \`dipo office open\` brings it back. [y/N] `,
          `Open ${copy} as an office now? [y/N] `,
          expect.stringMatching(new RegExp(`^Forget the office at ${copy}\\?`)),
        ]);
        const rows = officeRows(s.state);
        expect(rows.map((row) => [row.path, row.forgotten_at === null])).toEqual([
          [repo.dir, true],
          [copy, false],
        ]);
        expect(rows[1]?.office_id).not.toBe(original);
        expect(asked.err[0]).toBe("dipo: not an office, run `dipo office open`");
        expect(asked.err[1]).toContain("is a copy and became the new office");
        expect(asked.out.at(-1)).toBe(`forgot office ${rows[1]?.office_id} at ${copy}`);

        // From the original the same commands act on the original.
        const here = cli(s, repo.dir, repo.env);
        expect(await here.run(["office", "reload-config"])).toBe(0);
        expect(here.out).toEqual([
          expect.stringContaining(`office ${original}: configuration valid`),
        ]);
        expect(await here.run(["office", "forget", "--yes"])).toBe(0);
        expect(here.out.at(-1)).toBe(`forgot office ${original} at ${repo.dir}`);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("resolves the same main worktree as the engine, also for a separate git directory and a linked worktree", async () => {
    await withTempDir(async (root) => {
      const home = join(root, "home");
      const work = join(root, "work");
      mkdirSync(home);
      mkdirSync(work);
      const env = isolatedEnv(home);
      await git(
        root,
        home,
        "init",
        "--quiet",
        "-b",
        "main",
        `--separate-git-dir=${join(root, "store.git")}`,
        work,
      );
      await git(work, home, "commit", "--quiet", "--allow-empty", "-m", "init");
      await git(work, home, "worktree", "add", "--quiet", "-b", "DIPO-1/x", join(root, "linked"));
      const plain = join(root, "plain");
      mkdirSync(plain);
      for (const path of [work, join(root, "linked"), join(root, "store.git"), plain]) {
        const engine = await resolveRepository({ spawn: systemSpawn, env }, path);
        const client = await locateRepository(path, env);
        expect(client).toEqual(engine.ok ? engine.repository : null);
      }
      expect((await locateRepository(work, env))?.mainWorktree).toBe(work);
    });
  });
});
