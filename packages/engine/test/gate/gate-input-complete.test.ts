// The gate decides only on a whole input (DIPO-323): a `task list` whose output lost its last lines,
// or that printed an entry the parser skips, is read once more; when it is still short, the read
// fails loudly instead of leaving a Done dependency out of the active tasks (a false R13). A view
// that fails fails the read with the CLI's error; a slow view is waited for.

import { describe, expect, it } from "bun:test";

import type { Spawn } from "@dipsaus-orchestrator/contract";

import { BacklogListIncompleteError } from "../../src/backlog/list";
import { BacklogCommandError, type BacklogCli } from "../../src/backlog/runner";
import { evaluateGate } from "../../src/gate";
import { readGateInput } from "../../src/gate-decisions";
import { DEFAULT_CONFIG } from "./fixtures";
import { backlogStoryStore } from "../../src/backlog/store";

interface FakeTask {
  readonly id: string;
  readonly status: string;
  readonly dependencies: readonly string[];
}

/** DIPO-1 depends on DIPO-2 (Refined) and DIPO-9 (Done, printed last by `task list`). */
const TASKS: readonly FakeTask[] = [
  { id: "DIPO-1", status: "Ready", dependencies: ["DIPO-2", "DIPO-9"] },
  { id: "DIPO-2", status: "Refined", dependencies: [] },
  { id: "DIPO-3", status: "Refined", dependencies: [] },
  { id: "DIPO-9", status: "Done", dependencies: [] },
];

function viewText(task: FakeTask): string {
  const depends = task.dependencies.map(
    (dep, i) =>
      `${i === task.dependencies.length - 1 ? "└─" : "├─"} ${dep} - Task ${dep} [completed]`,
  );
  return [
    `File: /fixture/backlog/tasks/${task.id}.md`,
    "",
    `Task ${task.id} - Task ${task.id}`,
    "=".repeat(50),
    "",
    `Status: ○ ${task.status}`,
    "Created: 2026-10-12 11:28 (UTC)",
    "",
    ...(depends.length === 0
      ? []
      : [
          "Dependency Graph:",
          "-".repeat(50),
          `Depends on (${depends.length} direct, ${depends.length} total):`,
          ...depends,
          "",
        ]),
    "Description:",
    "-".repeat(50),
    "Outcome: the fixture task.",
    "",
  ].join("\n");
}

/** `task list --plain` as 1.53 prints it: one group per status, a blank line after each. */
function listText(tasks: readonly FakeTask[]): string {
  const groups = [...new Set(tasks.map((task) => task.status))];
  return groups
    .map((group) =>
      [
        `${group}:`,
        ...tasks
          .filter((task) => task.status === group)
          .map((task) => `  ${task.id} - Task ${task.id}`),
        "",
      ].join("\n"),
    )
    .join("\n");
}

interface Answer {
  readonly stdout: string;
  readonly stderr?: string;
  readonly code?: number;
  /** Set: the output arrives and the process exits only once this settles (a slow call). */
  readonly after?: Promise<unknown>;
}

function streamOf(text: string, after: Promise<unknown>): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      await after;
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * A Backlog CLI over `TASKS`; `override` replaces the answer to one call, by its arguments, and
 * gets the exits of every process spawned before it.
 */
function fakeCli(
  override: (
    args: readonly string[],
    earlier: readonly Promise<unknown>[],
  ) => Answer | undefined = () => undefined,
): {
  cli: BacklogCli;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exits: Promise<unknown>[] = [];
  const byId = new Map(TASKS.map((task) => [task.id, task]));
  const answer = (args: readonly string[]): Answer => {
    const [group, sub, id] = args;
    if (group === "task" && sub === "list") {
      return { stdout: args.includes("--count") ? `${TASKS.length}\n` : listText(TASKS) };
    }
    if (group === "task" && sub === "view") {
      const task = byId.get(id ?? "");
      return task === undefined
        ? { stdout: "", stderr: `Task ${id} not found.\n`, code: 1 }
        : { stdout: viewText(task) };
    }
    if (group === "milestone") return { stdout: "Active milestones (1):\n  m-0: M0 (0/0 done)\n" };
    return { stdout: "" };
  };
  const spawn: Spawn = ({ cmd }) => {
    const args = cmd.slice(1);
    calls.push(args);
    const reply = override(args, [...exits]) ?? answer(args);
    const after = reply.after ?? Promise.resolve();
    const exited = after.then(() => ({ code: reply.code ?? 0, signal: null }));
    exits.push(exited);
    return {
      pid: 1,
      stdin: null,
      stdout: streamOf(reply.stdout, after),
      stderr: streamOf(reply.stderr ?? "", after),
      exited,
      kill: () => {},
    };
  };
  return { cli: { spawn }, calls };
}

const isList = (args: readonly string[]) =>
  args[0] === "task" && args[1] === "list" && !args.includes("--count");

function r13(input: Awaited<ReturnType<typeof readGateInput>>): string[] {
  return evaluateGate(input, "pickup")
    .failures.map((failure) => failure.message)
    .filter((message) => message.includes(" R13: "));
}

describe("the gate input is whole or the read fails", () => {
  it("reads every listed task and finds no R13 failure on a whole listing", async () => {
    const { cli, calls } = fakeCli();
    const input = await readGateInput(backlogStoryStore(cli), "/base", "DIPO-1", DEFAULT_CONFIG);
    expect(input.activeTasks.map((task) => task.id).toSorted()).toEqual(
      TASKS.map((task) => task.id).toSorted(),
    );
    expect(r13(input)).toEqual([]);
    expect(calls).toContainEqual(["task", "list", "--plain", "--count"]);
  });

  it("fails loudly when the listing lost its last lines, never with a false R13", async () => {
    // The tail of the output is gone, as seen on CI: the Done dependency printed last is missing.
    const whole = listText(TASKS);
    const cut = whole.slice(0, whole.indexOf("Done:"));
    const { cli, calls } = fakeCli((args) => (isList(args) ? { stdout: cut } : undefined));
    const read = readGateInput(backlogStoryStore(cli), "/base", "DIPO-1", DEFAULT_CONFIG);
    await expect(read).rejects.toBeInstanceOf(BacklogListIncompleteError);
    await expect(read).rejects.toThrow(/printed 3 entries, but its --count says 4/);
    // The error is a CLI error, so every caller that reports a CLI failure reports this one.
    await expect(read).rejects.toBeInstanceOf(BacklogCommandError);
    // Cut twice: read once more, then failed; no task was viewed past the story itself.
    expect(calls.filter(isList)).toHaveLength(2);
    expect(calls.filter((args) => args[1] === "view")).toEqual([
      ["task", "view", "DIPO-1", "--plain"],
    ]);
  });

  it("reads the list once more when the first one was cut, and decides on the whole one", async () => {
    const whole = listText(TASKS);
    let lists = 0;
    const { cli, calls } = fakeCli((args) =>
      isList(args) && lists++ === 0
        ? { stdout: whole.slice(0, whole.indexOf("Done:")) }
        : undefined,
    );
    const input = await readGateInput(backlogStoryStore(cli), "/base", "DIPO-1", DEFAULT_CONFIG);
    expect(calls.filter(isList)).toHaveLength(2);
    expect(input.activeTasks.map((task) => task.id)).toContain("DIPO-9");
    expect(r13(input)).toEqual([]);
  });

  it("fails loudly when the listing holds an entry line the parser skips", async () => {
    const garbled = listText(TASKS).replace("  DIPO-9 - Task DIPO-9", "  DIPO-9 Task DIPO-9");
    const { cli } = fakeCli((args) => (isList(args) ? { stdout: garbled } : undefined));
    await expect(
      readGateInput(backlogStoryStore(cli), "/base", "DIPO-1", DEFAULT_CONFIG),
    ).rejects.toBeInstanceOf(BacklogListIncompleteError);
  });

  it("fails loudly when the count does not come through", async () => {
    const { cli } = fakeCli((args) => (args.includes("--count") ? { stdout: "" } : undefined));
    await expect(
      readGateInput(backlogStoryStore(cli), "/base", "DIPO-1", DEFAULT_CONFIG),
    ).rejects.toThrow(/--count printed no number/);
  });

  it("fails with the CLI's error when one view fails", async () => {
    const { cli } = fakeCli((args) =>
      args[1] === "view" && args[2] === "DIPO-9"
        ? { stdout: "", stderr: "fatal: cannot lock ref\n", code: 128 }
        : undefined,
    );
    const read = readGateInput(backlogStoryStore(cli), "/base", "DIPO-1", DEFAULT_CONFIG);
    await expect(read).rejects.toBeInstanceOf(BacklogCommandError);
    await expect(read).rejects.toThrow(/cannot lock ref/);
  });

  it("waits for a slow view and still reads every task", async () => {
    const answered: string[] = [];
    const { cli } = fakeCli((args, earlier) => {
      if (args[1] !== "view") return undefined;
      const id = args[2] ?? "";
      const task = TASKS.find((t) => t.id === id) as FakeTask;
      // DIPO-9's view answers only after every call spawned before it has exited.
      const after = (id === "DIPO-9" ? Promise.all(earlier) : Promise.resolve()).then(() => {
        answered.push(id);
      });
      return { stdout: viewText(task), after };
    });
    const input = await readGateInput(backlogStoryStore(cli), "/base", "DIPO-1", DEFAULT_CONFIG);
    expect(answered.at(-1)).toBe("DIPO-9");
    expect(input.activeTasks.map((task) => task.id)).toContain("DIPO-9");
    expect(r13(input)).toEqual([]);
  });
});
