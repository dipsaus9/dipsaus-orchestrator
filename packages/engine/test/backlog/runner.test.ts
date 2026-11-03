// The Backlog CLI runner (DIPO-28; 0010 section 1): the never-run list and anything outside the
// allowlist are refused before spawning, text holding a 50-dash line never reaches the CLI, and a
// non-zero exit or a `not found` line is an error carrying the command and its output. Calls on one
// checkout run alone while the CLI could rewrite its config.yml, and at the same time once it is
// settled (DIPO-434).

import { afterEach, describe, expect, it } from "bun:test";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Spawn } from "@dipsaus-orchestrator/contract";
import { ManualClock, makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { BacklogCommandError, BacklogRefusedError, refusal, runBacklog } from "../../src/backlog";
import { listAll } from "../../src/backlog/list";
import {
  BACKLOG_ENV_KEYS,
  BacklogTimedOutError,
  backlogEnv,
  CheckoutGate,
  type GateLeave,
  waitAtGate,
} from "../../src/backlog/runner";
import { CALL_DEADLINE_MS, KILL_GRACE_MS } from "../../src/platform/deadline";
import { hangingSpawn, settle } from "../platform/hanging";
import { readManifest, stubSpawn } from "./helpers";

const RULE = "-".repeat(50);

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("refused subcommands", () => {
  const refused: readonly (readonly string[])[] = [
    ["task", "complete", "TASK-1"],
    ["cleanup"],
    ["task", "demote", "TASK-1"],
    ["doctor", "--fix"],
    ["config", "set", "statuses", "Refined,Ready"],
    ["task", "edit", "TASK-1", "-s", "Draft"],
    ["task", "edit", "TASK-1", "--status", "draft"],
    ["task", "edit", "TASK-1", "--status=Draft"],
    ["task", "create", "New", "-sDraft"],
    ["draft", "edit", "DRAFT-1", "--status", " DRAFT "],
    ["browser"],
    ["task"],
    ["task", "remove", "TASK-1"],
    ["config", "set", "taskPrefix", "x"],
    ["task", "edit", "TASK-1", "-l", "tier:S"],
    ["task", "edit", "TASK-1", "-ltier:S"],
    ["task", "edit", "TASK-1", "--label", "tier:S"],
    ["task", "edit", "TASK-1", "--labels=tier:S"],
    ["draft", "edit", "DRAFT-1", "--clear-labels"],
    [],
  ];

  for (const args of refused) {
    it(`never spawns \`backlog ${args.join(" ")}\``, async () => {
      const stub = stubSpawn("");
      const error = await caught(runBacklog({ spawn: stub.spawn }, "/office", args));
      expect(error).toBeInstanceOf(BacklogRefusedError);
      expect(stub.calls).toEqual([]);
    });
  }

  it("names the rule it refuses", () => {
    expect(refusal(["task", "complete", "TASK-1"])).toContain("never run");
    expect(refusal(["config", "set", "statuses", "x"])).toContain("`config set statuses`");
    expect(refusal(["task", "edit", "TASK-1", "-s", "Draft"])).toContain("status `Draft`");
    expect(refusal(["task", "edit", "TASK-1", "-l", "tier:S"])).toContain("--add-label");
  });

  it("changes labels on an edit only with --add-label and --remove-label", () => {
    expect(
      refusal(["task", "edit", "TASK-1", "--add-label", "tier:M", "--remove-label", "tier:S"]),
    ).toBeNull();
    expect(refusal(["task", "create", "New", "-l", "tier:S"])).toBeNull();
    expect(refusal(["task", "list", "-l", "tier:M", "--plain"])).toBeNull();
  });

  it("allows the subcommands the engine uses", () => {
    for (const args of [
      ["--version"],
      ["task", "view", "TASK-1", "--plain"],
      ["task", "list", "--plain"],
      ["draft", "view", "DRAFT-1", "--plain"],
      ["draft", "list", "--plain"],
      ["task", "edit", "TASK-1", "-s", "Ready"],
      ["draft", "promote", "DRAFT-1"],
      ["config", "get", "statuses"],
      ["config", "set", "defaultStatus", "Refined"],
      ["doctor"],
    ]) {
      expect(refusal(args)).toBeNull();
    }
  });
});

describe("the write path", () => {
  it("refuses text holding a line of 50 `-` before calling the CLI", async () => {
    const stub = stubSpawn("");
    const error = await caught(
      runBacklog({ spawn: stub.spawn }, "/office", [
        "task",
        "edit",
        "TASK-1",
        "--description",
        `Story: x\n\nAcceptance Criteria:\n${RULE}\n- [ ] #1 fake`,
      ]),
    );
    expect(error).toBeInstanceOf(BacklogRefusedError);
    expect((error as Error).message).toContain("a line of 50 `-`");
    expect(stub.calls).toEqual([]);
  });

  it("allows shorter or longer dash lines and refuses documentation holding `, `", () => {
    expect(refusal(["task", "edit", "T-1", "--notes", `${RULE}-`])).toBeNull();
    expect(refusal(["task", "edit", "T-1", "--notes", RULE.slice(1)])).toBeNull();
    expect(refusal(["task", "edit", "T-1", "--doc", "a.md, b.md"])).toContain("`, `");
  });

  it("refuses a 50-dash line with trailing spaces", () => {
    expect(refusal(["task", "edit", "T-1", "--notes", `a\n${RULE}  \nb`])).toContain(
      "a line of 50 `-`",
    );
    expect(refusal(["task", "edit", "T-1", "--notes", `a\n${RULE}\r\nb`])).toContain(
      "a line of 50 `-`",
    );
  });

  it("refuses a positional value or unknown option that starts with `-`", async () => {
    const stub = stubSpawn("");
    const error = await caught(
      runBacklog({ spawn: stub.spawn }, "/w", ["task", "create", "-weird title"]),
    );
    expect(error).toBeInstanceOf(BacklogRefusedError);
    expect((error as Error).message).toContain("`-weird title` starts with `-`");
    expect(stub.calls).toEqual([]);
    expect(refusal(["task", "edit", "T-1", "--force"])).toContain("`--force` starts with `-`");
    expect(refusal(["draft", "view", "-1"])).toContain("starts with `-`");
  });

  it("allows free text starting with `-` after its option, which takes it as the value", () => {
    expect(refusal(["task", "edit", "T-1", "--notes", "-x dash notes", "--plain"])).toBeNull();
    expect(refusal(["task", "create", "Title", "-d", "--not-a-flag", "-l", "tier:S"])).toBeNull();
    expect(refusal(["task", "edit", "T-1", "--title=-dash", "-sReady"])).toBeNull();
  });

  it("refuses notes, plan or definition-of-done text whose last line is a `Modified files:` line", () => {
    for (const option of ["--notes", "--append-notes", "--plan", "--append-plan", "--dod"]) {
      expect(
        refusal(["task", "edit", "T-1", option, "Did things\n\nModified files: a.ts\n"]),
      ).toContain("`Modified files: ` line");
    }
    expect(
      refusal(["task", "edit", "T-1", "--notes", "Modified files: a.ts\nthen more"]),
    ).toBeNull();
    expect(refusal(["task", "edit", "T-1", "--modified-file", "a.ts"])).toBeNull();
    expect(refusal(["task", "edit", "T-1", "--final-summary", "Modified files: a.ts"])).toBeNull();
  });
});

describe("running the CLI", () => {
  it("spawns the configured command in the given directory with the environment", async () => {
    const stub = stubSpawn("1.53.0\n");
    const env = { PATH: "/bin" };
    const out = await runBacklog({ spawn: stub.spawn, command: ["bun", "cli.js"], env }, "/w", [
      "--version",
    ]);
    expect(out.stdout).toBe("1.53.0\n");
    // The CLI's output goes to files under the temp root, never a pipe (DIPO-333).
    const output = { to: "file" as const, tempRoot: process.env["DIPO_TMP"] || tmpdir() };
    expect(stub.calls).toEqual([
      { cmd: ["bun", "cli.js", "--version"], cwd: "/w", env, output, detached: true },
    ]);
  });

  it("passes only PATH and HOME of the given environment, never its other variables (DIPO-270)", async () => {
    const stub = stubSpawn("1.53.0\n");
    const env = { PATH: "/bin", HOME: "/h", SHELL: "/bin/zsh", OTHER: "x", UNSET: undefined };
    await runBacklog({ spawn: stub.spawn, env }, "/w", ["--version"]);
    expect(stub.calls[0]?.env).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(backlogEnv(env)).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(backlogEnv({ OTHER: "x" })).toEqual({});
  });

  it("takes PATH and HOME from the process when given no environment, never inheriting it", async () => {
    const stub = stubSpawn("1.53.0\n");
    await runBacklog({ spawn: stub.spawn }, "/w", ["--version"]);
    expect(stub.calls[0]?.env).toEqual(backlogEnv(process.env));
    expect(Object.keys(stub.calls[0]?.env ?? {}).toSorted()).toEqual(
      [...BACKLOG_ENV_KEYS].filter((key) => process.env[key] !== undefined).toSorted(),
    );
  });

  it("uses `backlog` from PATH by default", async () => {
    const stub = stubSpawn("1.53.0\n");
    await runBacklog({ spawn: stub.spawn }, "/w", ["--version"]);
    expect(stub.calls[0]?.cmd).toEqual(["backlog", "--version"]);
  });

  it("makes a non-zero exit an error carrying the command and output", async () => {
    const recording = readManifest().recordings.find((r) => r.name === "task-view-unknown");
    expect(recording?.exitCode).toBe(1);
    const stub = stubSpawn("", recording?.stderr ?? "", recording?.exitCode ?? 1);
    const error = await caught(runBacklog({ spawn: stub.spawn }, "/w", recording?.args ?? []));
    expect(error).toBeInstanceOf(BacklogCommandError);
    const failure = error as BacklogCommandError;
    expect(failure.command).toEqual(["backlog", "task", "view", "TASK-99", "--plain"]);
    expect(failure.exitCode).toBe(1);
    expect(failure.stderr).toContain("Task TASK-99 not found");
    expect(failure.message).toContain("`backlog task view TASK-99 --plain` exited 1");
    expect(failure.message).toContain("Task TASK-99 not found");
  });

  it("makes a `not found` line with exit 0 an error", async () => {
    const recording = readManifest().recordings.find((r) => r.name === "draft-view-unknown");
    expect(recording?.exitCode).toBe(0);
    const stub = stubSpawn("", recording?.stderr ?? "", 0);
    const error = await caught(runBacklog({ spawn: stub.spawn }, "/w", recording?.args ?? []));
    expect(error).toBeInstanceOf(BacklogCommandError);
    expect((error as Error).message).toContain("reported `not found`: Draft DRAFT-99 not found.");
    // On stdout too, as 1.48 printed it.
    const stdout = stubSpawn("Task TASK-7 not found.\n");
    expect(
      await caught(runBacklog({ spawn: stdout.spawn }, "/w", ["task", "view", "TASK-7"])),
    ).toBeInstanceOf(BacklogCommandError);
  });

  it("does not take `not found` inside a viewed task's own text for an error", async () => {
    const view = "File: /x.md\n\nTask T-1 - Handle the file not found case\n";
    const stub = stubSpawn(view);
    const out = await runBacklog({ spawn: stub.spawn }, "/w", ["task", "view", "T-1", "--plain"]);
    expect(out.stdout).toBe(view);
  });

  it("reads only the 1.53 `not found` shapes on stderr", async () => {
    const warning = stubSpawn(
      "Ready:\n  TASK-1 - One\n",
      "warning: config.yml key not found, using default\n",
    );
    const out = await runBacklog({ spawn: warning.spawn }, "/w", ["task", "list", "--plain"]);
    expect(out.stdout).toContain("TASK-1");
    for (const stderr of ["Task TASK-3 not found.\n", "draft DRAFT-2 not found.\n"]) {
      const stub = stubSpawn("", stderr);
      expect(
        await caught(runBacklog({ spawn: stub.spawn }, "/w", ["task", "view", "TASK-3"])),
      ).toBeInstanceOf(BacklogCommandError);
    }
  });

  it("reports a CLI that cannot start", async () => {
    const error = await caught(
      runBacklog(
        {
          spawn: () => {
            throw new Error("ENOENT: backlog");
          },
        },
        "/w",
        ["--version"],
      ),
    );
    expect(error).toBeInstanceOf(BacklogCommandError);
    expect((error as Error).message).toContain("could not start: ENOENT: backlog");
  });
});

// ---- the checkout gate (DIPO-434) ---------------------------------------------------------------

/** A config.yml without the CLI's defaults, as an office adopted from before dipo keeps it. */
const BARE_CONFIG = 'project_name: "fixture"\nstatuses: ["To Do", "Done"]\n';
/** The line the stand-in CLI adds to a config.yml that lacks it. */
const DEFAULTS = "max_column_width: 20\n";
const WHOLE_LIST = "To Do:\n  TASK-1 - One\n  TASK-2 - Two\n  TASK-3 - Three\n\n";
const ENTRIES = ["TASK-1", "TASK-2", "TASK-3"];

/** One step of a stand-in run: a call started or ended, by its arguments. */
type Step = `${"start" | "end"} ${string}`;

interface StandIn {
  readonly spawn: Spawn;
  readonly steps: Step[];
  /** The most calls that ran at the same time. */
  readonly most: () => number;
}

/**
 * A stand-in Backlog CLI over the checkout it runs in. Like Backlog.md 1.53 it rewrites a
 * config.yml that lacks its defaults on its read: it leaves the file half-written for `holdMs`
 * on a timer, then writes it whole and exits. A call that reads a half-written file sees no
 * tasks: an empty list, a count of 0, a view that is not found. Every call runs for `holdMs`.
 * `fail` makes the calls whose arguments it matches exit 1.
 */
function standIn(holdMs = 40, fail: (args: string) => boolean = () => false): StandIn {
  const steps: Step[] = [];
  let running = 0;
  let most = 0;
  const spawn: Spawn = ({ cmd, cwd }) => {
    const args = cmd.slice(1).join(" ");
    steps.push(`start ${args}`);
    running++;
    most = Math.max(most, running);
    const file = join(cwd ?? ".", "backlog", "config.yml");
    const config = existsSync(file) ? readFileSync(file, "utf8") : "";
    const whole = config.includes("statuses:");
    const rewrite = whole && !config.includes(DEFAULTS);
    if (rewrite) writeFileSync(file, config.slice(0, 10));
    const view = /^task view (\S+)/.exec(args)?.[1];
    let stdout = "";
    let stderr = "";
    if (view !== undefined) {
      if (whole) stdout = `File: /x/${view}.md\n\nTask ${view} - Story\n`;
      else stderr = `Task ${view} not found.\n`;
    } else if (args.includes("--count")) stdout = whole ? `${ENTRIES.length}\n` : "0\n";
    else stdout = whole ? WHOLE_LIST : "";
    const code = stderr !== "" || fail(args) ? 1 : 0;
    const exited = Bun.sleep(holdMs).then(() => {
      if (rewrite) writeFileSync(file, `${config}${DEFAULTS}`);
      running--;
      steps.push(`end ${args}`);
      return { code, signal: null };
    });
    return {
      pid: 4242,
      stdin: null,
      stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
      stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
      exited,
      kill: () => {},
    };
  };
  return { spawn, steps, most: () => most };
}

const VIEW = (id: string) => ["task", "view", id, "--plain"];

/** The error of a call whose deadline came while it waited at the gate. */
const gateTimedOut = () => new BacklogTimedOutError(["backlog", "task", "list"], 10);

/** A `Spawn` that cannot start the CLI. */
const unstartable: Spawn = () => {
  throw new Error("ENOENT: backlog");
};

describe("the checkout gate (DIPO-434)", () => {
  const dirs: string[] = [];
  /** A fresh checkout under the test temp root, so no gate state leaks between tests. */
  const checkout = (config: string | null = BARE_CONFIG): string => {
    const dir = makeTempDir();
    dirs.push(dir);
    mkdirSync(join(dir, "backlog", "tasks"), { recursive: true });
    if (config !== null) writeFileSync(join(dir, "backlog", "config.yml"), config);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeTempDir(dir);
  });

  it("lets calls at once on a config the CLI rewrites each see the whole backlog", async () => {
    const dir = checkout();
    const cli = standIn();
    const [first, list, second, third] = await Promise.all([
      runBacklog(cli, dir, VIEW("TASK-1")),
      listAll(cli, dir, "task"),
      runBacklog(cli, dir, VIEW("TASK-2")),
      runBacklog(cli, dir, VIEW("TASK-3")),
    ]);
    expect(list.entries.map((entry) => entry.id)).toEqual(ENTRIES);
    expect(first.stdout).toContain("Task TASK-1 - Story");
    expect(second.stdout).toContain("Task TASK-2 - Story");
    expect(third.stdout).toContain("Task TASK-3 - Story");
    expect(readFileSync(join(dir, "backlog", "config.yml"), "utf8")).toBe(
      `${BARE_CONFIG}${DEFAULTS}`,
    );
    // The call that rewrote the file ran alone; the rest ran at the same time after it.
    expect(cli.steps.slice(0, 2)).toEqual([
      "start task view TASK-1 --plain",
      "end task view TASK-1 --plain",
    ]);
    expect(cli.steps.slice(2, 6).every((step) => step.startsWith("start "))).toBe(true);
    expect(cli.most()).toBe(4);
  });

  it("runs calls on a settled config at the same time, after the first", async () => {
    const dir = checkout(`${BARE_CONFIG}${DEFAULTS}`);
    const cli = standIn();
    await runBacklog(cli, dir, VIEW("TASK-1"));
    expect(cli.most()).toBe(1);
    await Promise.all(["TASK-1", "TASK-2", "TASK-3"].map((id) => runBacklog(cli, dir, VIEW(id))));
    expect(cli.most()).toBe(3);
  });

  it("counts a config.yml as unchanged only when it was missing then too", async () => {
    const dir = checkout(null);
    // The project is configured in config.yaml, so the CLI runs there without a config.yml.
    writeFileSync(join(dir, "backlog", "config.yaml"), BARE_CONFIG);
    const cli = standIn();
    await runBacklog(cli, dir, VIEW("TASK-1")).catch(() => undefined);
    await Promise.all([
      runBacklog(cli, dir, VIEW("TASK-1")).catch(() => undefined),
      runBacklog(cli, dir, VIEW("TASK-2")).catch(() => undefined),
    ]);
    expect(cli.most()).toBe(2);
    writeFileSync(join(dir, "backlog", "config.yml"), `${BARE_CONFIG}${DEFAULTS}`);
    const steps = cli.steps.length;
    await Promise.all(["TASK-1", "TASK-2"].map((id) => runBacklog(cli, dir, VIEW(id))));
    expect(cli.steps.slice(steps, steps + 2)).toEqual([
      "start task view TASK-1 --plain",
      "end task view TASK-1 --plain",
    ]);
  });

  it("runs calls on different checkouts at the same time, even before they are settled", async () => {
    const cli = standIn();
    const [one, two] = [checkout(), checkout()];
    await Promise.all([runBacklog(cli, one, VIEW("TASK-1")), runBacklog(cli, two, VIEW("TASK-2"))]);
    expect(cli.most()).toBe(2);
  });

  it("makes the next call run alone again once a checkout changed its config.yml", async () => {
    const dir = checkout();
    const cli = standIn();
    await runBacklog(cli, dir, VIEW("TASK-1"));
    // A checkout of an old commit puts the config without the defaults back (`sideAt`).
    writeFileSync(join(dir, "backlog", "config.yml"), BARE_CONFIG);
    const steps = cli.steps.length;
    const [list, view] = await Promise.all([
      listAll(cli, dir, "task"),
      runBacklog(cli, dir, VIEW("TASK-2")),
    ]);
    expect(list.entries.map((entry) => entry.id)).toEqual(ENTRIES);
    expect(view.stdout).toContain("Task TASK-2 - Story");
    expect(cli.steps.slice(steps, steps + 2)).toEqual([
      "start task list --plain",
      "end task list --plain",
    ]);
  });

  it("releases the gate when a call fails, and when one never starts", async () => {
    const dir = checkout();
    const cli = standIn(40, (args) => args.includes("TASK-9"));
    const [failed, ...rest] = await Promise.allSettled([
      runBacklog(cli, dir, VIEW("TASK-9")),
      runBacklog(cli, dir, VIEW("TASK-1")),
      runBacklog(cli, dir, VIEW("TASK-2")),
    ]);
    expect(failed?.status).toBe("rejected");
    expect(rest.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);

    const other = checkout();
    const error = await caught(runBacklog({ spawn: unstartable }, other, VIEW("TASK-1")));
    expect((error as Error).message).toContain("could not start");
    // Nothing is remembered after a call that never started: the next call runs alone.
    const steps = cli.steps.length;
    await Promise.all(["TASK-1", "TASK-2"].map((id) => runBacklog(cli, other, VIEW(id))));
    expect(cli.steps.slice(steps, steps + 2)).toEqual([
      "start task view TASK-1 --plain",
      "end task view TASK-1 --plain",
    ]);
  });

  it("lets a call either run or leave when its deadline comes in the tick its pass does", async () => {
    const dir = checkout(`${BARE_CONFIG}${DEFAULTS}`);
    const gate = new CheckoutGate();
    const clock = new ManualClock();
    const alone = gate.enter(dir);
    if (typeof alone !== "function") throw new Error("expected the first call to pass at once");
    const waiting = gate.enter(dir);
    alone(true);
    await settle();
    // The pass is given, but the waiting call has not seen it yet when its deadline comes.
    expect(gate.running(dir)).toBe(1);
    const call = caught(waitAtGate(waiting as Promise<GateLeave>, clock, 10, gateTimedOut));
    clock.advance(10);
    expect(await call).toBeInstanceOf(BacklogTimedOutError);
    await settle();
    // It left once and never ran: no call holds the gate, and the next one passes at once.
    expect(gate.running(dir)).toBe(0);
    const next = gate.enter(dir);
    expect(typeof next).toBe("function");
    if (typeof next === "function") next(true);
    expect(gate.running(dir)).toBe(0);
  });

  it("releases the gate when a call times out, and times out a call waiting at it", async () => {
    const dir = checkout();
    const clock = new ManualClock();
    const later = standIn();
    // The first call hangs; the rest are answered by the stand-in.
    let first = true;
    const hang = hangingSpawn((options) => {
      if (first) {
        first = false;
        return null;
      }
      return later.spawn(options);
    });
    const cli = { spawn: hang.spawn, clock, env: {} };
    const hung = caught(runBacklog(cli, dir, VIEW("TASK-1")));
    const waiting = caught(runBacklog(cli, dir, VIEW("TASK-2")));
    await settle();
    expect(hang.calls).toHaveLength(1);
    clock.advance(CALL_DEADLINE_MS);
    // The waiting call fails at its own deadline, without starting the CLI.
    const waited = await waiting;
    expect(waited).toBeInstanceOf(BacklogTimedOutError);
    expect((waited as Error).message).toContain("`backlog task view TASK-2 --plain`");
    clock.advance(KILL_GRACE_MS);
    expect(await hung).toBeInstanceOf(BacklogTimedOutError);
    expect(hang.calls).toHaveLength(1);
    // The gate is free again.
    const out = await runBacklog(cli, dir, VIEW("TASK-3"));
    expect(out.stdout).toContain("Task TASK-3 - Story");
    expect(later.steps).toEqual(["start task view TASK-3 --plain", "end task view TASK-3 --plain"]);
  });
});
