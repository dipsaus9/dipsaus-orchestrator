// The gate decides only on a whole input (DIPO-323, DIPO-494): the other active tasks come from one
// pass over the checkout's task files, so a task file that does not parse fails the read loudly
// instead of leaving a Done dependency out of the active tasks (a false R13) or counting a task
// with no dependencies or branch. A view that fails fails the read with the CLI's error. The read
// without a mirror makes at most three CLI calls however many tasks there are, and logs how long
// each part took at DEBUG.

import { describe, expect, it } from "bun:test";

import type { Spawn } from "@dipsaus-orchestrator/contract";

import { BacklogCommandError, type BacklogCli } from "../../src/backlog/runner";
import { evaluateGate } from "../../src/gate";
import { readGateInput } from "../../src/gate-decisions";
import { StoryParseError } from "../../src/story-store/errors";
import { DEFAULT_CONFIG } from "./fixtures";
import { backlogStoryStore } from "../../src/backlog/store";
import { type FileTask, withBacklog } from "./task-files";

interface FakeTask {
  readonly id: string;
  readonly status: string;
  readonly dependencies: readonly string[];
}

/** DIPO-1 depends on DIPO-2 (Refined) and DIPO-9 (Done). */
const TASKS: readonly FakeTask[] = [
  { id: "DIPO-1", status: "Ready", dependencies: ["DIPO-2", "DIPO-9"] },
  { id: "DIPO-2", status: "Refined", dependencies: [] },
  { id: "DIPO-3", status: "Refined", dependencies: [] },
  { id: "DIPO-9", status: "Done", dependencies: [] },
];

const FILES: readonly FileTask[] = TASKS.map((task) => ({
  id: task.id,
  status: task.status,
  dependencies: `[${task.dependencies.join(", ")}]`,
}));

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
    "Story: As maintainer I want the fixture task to exist so that the gate has a story to read.",
    "",
  ].join("\n");
}

interface Answer {
  readonly stdout: string;
  readonly stderr?: string;
  readonly code?: number;
}

/** A Backlog CLI that answers the story's view and the milestones; any other call is a failure. */
function fakeCli(override: (args: readonly string[]) => Answer | undefined = () => undefined): {
  cli: BacklogCli;
  calls: string[][];
} {
  const calls: string[][] = [];
  const byId = new Map(TASKS.map((task) => [task.id, task]));
  const answer = (args: readonly string[]): Answer => {
    const [group, sub, id] = args;
    if (group === "task" && sub === "view") {
      const task = byId.get(id ?? "");
      return task === undefined
        ? { stdout: "", stderr: `Task ${id} not found.\n`, code: 1 }
        : { stdout: viewText(task) };
    }
    if (group === "milestone") return { stdout: "Active milestones (1):\n  m-0: M0 (0/0 done)\n" };
    return { stdout: "", stderr: `unexpected call ${args.join(" ")}\n`, code: 1 };
  };
  const spawn: Spawn = ({ cmd }) => {
    const args = cmd.slice(1);
    calls.push(args);
    const reply = override(args) ?? answer(args);
    return {
      pid: 1,
      stdin: null,
      stdout: new Response(reply.stdout).body as ReadableStream<Uint8Array>,
      stderr: new Response(reply.stderr ?? "").body as ReadableStream<Uint8Array>,
      exited: Promise.resolve({ code: reply.code ?? 0, signal: null }),
      kill: () => {},
    };
  };
  return { cli: { spawn }, calls };
}

function r13(input: Awaited<ReturnType<typeof readGateInput>>): string[] {
  return evaluateGate(input, "pickup")
    .failures.map((failure) => failure.message)
    .filter((message) => message.includes(" R13: "));
}

describe("the gate input is whole or the read fails", () => {
  it("reads every task file and finds no R13 failure on a whole backlog", () =>
    withBacklog(FILES, async (dir) => {
      const { cli, calls } = fakeCli();
      const input = await readGateInput(backlogStoryStore(cli), dir, "DIPO-1", DEFAULT_CONFIG);
      expect(input.activeTasks.map((task) => task.id).toSorted()).toEqual(
        TASKS.map((task) => task.id).toSorted(),
      );
      expect(r13(input)).toEqual([]);
      // The story's view and the milestones: no list, no view of another task.
      expect(calls).toEqual([
        ["task", "view", "DIPO-1", "--plain"],
        ["milestone", "list", "--show-completed", "--plain"],
      ]);
    }));

  it("fails loudly when another task's file does not parse, never with a false R13", () =>
    withBacklog(
      [...FILES.slice(0, 3), { id: "DIPO-9", text: "---\ntitle: Done task\nstatus: Done\n---\n" }],
      async (dir) => {
        const { cli } = fakeCli();
        const read = readGateInput(backlogStoryStore(cli), dir, "DIPO-1", DEFAULT_CONFIG);
        await expect(read).rejects.toBeInstanceOf(StoryParseError);
        await expect(read).rejects.toThrow(/dipo-9 - Task\.md: its front matter has no id/);
      },
    ));

  it("fails with the CLI's error when the story's view fails", () =>
    withBacklog(FILES, async (dir) => {
      const { cli } = fakeCli((args) =>
        args[1] === "view"
          ? { stdout: "", stderr: "fatal: cannot lock ref\n", code: 128 }
          : undefined,
      );
      const read = readGateInput(backlogStoryStore(cli), dir, "DIPO-1", DEFAULT_CONFIG);
      await expect(read).rejects.toBeInstanceOf(BacklogCommandError);
      await expect(read).rejects.toThrow(/cannot lock ref/);
    }));

  it("makes at most three CLI calls however many tasks there are, and logs each part at DEBUG", () => {
    const many: FileTask[] = Array.from({ length: 120 }, (_, i) => ({ id: `DIPO-${i + 10}` }));
    return withBacklog([...FILES, ...many], async (dir) => {
      const { cli, calls } = fakeCli();
      const lines: { message: string; fields: Record<string, unknown> }[] = [];
      let tick = 0;
      const input = await readGateInput(
        backlogStoryStore(cli),
        dir,
        "DIPO-1",
        DEFAULT_CONFIG,
        undefined,
        undefined,
        {
          now: () => (tick += 5),
          debug: (message, fields) => lines.push({ message, fields }),
        },
      );
      expect(input.activeTasks).toHaveLength(TASKS.length + many.length);
      expect(calls.length).toBeLessThanOrEqual(3);
      expect(lines).toEqual([
        {
          message: "gate input read",
          fields: {
            story: "DIPO-1",
            tasks: "files",
            storyMs: 5,
            tasksMs: 5,
            milestonesMs: 5,
            foldersMs: 5,
          },
        },
      ]);
    });
  });
});
