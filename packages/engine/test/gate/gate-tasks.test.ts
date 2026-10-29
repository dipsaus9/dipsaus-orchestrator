// The Ready gate reads the other active tasks from the mirror (DIPO-180): a story.gate read makes
// a number of Backlog CLI calls that does not grow with the backlog and gives the rule results of
// reading every view, and task data read at another `_base` commit is brought up to the gate's
// base before the gate uses it.

import { describe, expect, it } from "bun:test";

import type { Spawn } from "@dipsaus-orchestrator/contract";

import type { BacklogCli } from "../../src/backlog/runner";
import { cachedGateTasks, evaluateGate, readGateInput } from "../../src/gate";
import { applyIndex, applyStory } from "../../src/stories/apply";
import { storyRead } from "../../src/backlog/read";
import { storyFromRead } from "../../src/stories/read";
import type { BacklogStory } from "../../src/stories/read";
import { DEFAULT_CONFIG, block } from "./fixtures";
import { storyRows, withOffice } from "../stories/helpers";
import { removeStory } from "../../src/stories/keys";
import { backlogStoryStore } from "../../src/backlog/store";

interface FakeTask {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly branch?: string;
}

const TASKS = 200;
const SHARED = "DIPO-1/shared-branch";

/** 200 tasks. DIPO-1 (the target) depends on DIPO-2, which depends back on it (a cycle), and on
 * DIPO-900 (not an active task); DIPO-3 and DIPO-4 use the target's branch. */
function backlog(): FakeTask[] {
  const tasks: FakeTask[] = [];
  for (let n = 1; n <= TASKS; n++) {
    const id = `DIPO-${n}`;
    if (n === 1) tasks.push({ id, dependencies: ["DIPO-2", "DIPO-900"], branch: SHARED });
    else if (n === 2) tasks.push({ id, dependencies: ["DIPO-1"], branch: "DIPO-2/second" });
    else if (n === 3 || n === 4) tasks.push({ id, dependencies: [], branch: SHARED });
    else tasks.push({ id, dependencies: n > 10 ? ["DIPO-5"] : [], branch: `${id}/work` });
  }
  return tasks;
}

function viewText(task: FakeTask): string {
  const depends = task.dependencies.map((dep, i) => {
    const mark = i === task.dependencies.length - 1 ? "└─" : "├─";
    return dep === "DIPO-900"
      ? `${mark} ${dep} - unknown task ID`
      : `${mark} ${dep} - Task ${dep} [Refined]`;
  });
  return [
    `File: /fixture/backlog/tasks/${task.id}.md`,
    "",
    `Task ${task.id} - Task ${task.id}`,
    "==================================================",
    "",
    "Status: ○ Refined",
    "Created: 2026-10-12 11:28 (UTC)",
    "",
    "Dependency Graph:",
    "--------------------------------------------------",
    ...(depends.length === 0
      ? []
      : [`Depends on (${depends.length} direct, ${depends.length} total):`, ...depends]),
    "",
    "Description:",
    "--------------------------------------------------",
    "Outcome: the fixture task.",
    "",
    block(`branch: "${task.branch ?? ""}"`),
    "",
  ].join("\n");
}

/** A Backlog CLI over `tasks` that records every call. */
function fakeCli(tasks: readonly FakeTask[]): { cli: BacklogCli; calls: string[][] } {
  const calls: string[][] = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const spawn: Spawn = ({ cmd }) => {
    const args = cmd.slice(1);
    calls.push(args);
    let stdout = "";
    const [group, sub, id] = args;
    if (group === "task" && sub === "list" && args.includes("--count")) {
      stdout = `${tasks.length}\n`;
    } else if (group === "task" && sub === "list") {
      stdout = `Refined:\n${tasks.map((task) => `  ${task.id} - Task ${task.id} (ac: 0/0)`).join("\n")}\n`;
    } else if (group === "task" && sub === "view") {
      const task = byId.get(id ?? "");
      if (task !== undefined) stdout = viewText(task);
    } else if (group === "milestone") {
      stdout = "Active milestones (1):\n  m-0: M0 (0/0 done)\n";
    }
    return {
      pid: 1,
      stdin: null,
      stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
      stderr: new Response("").body as ReadableStream<Uint8Array>,
      exited: Promise.resolve({ code: 0, signal: null }),
      kill: () => {},
    };
  };
  return { cli: { spawn }, calls };
}

/** What an index pass reads of every task: its view, as `readBacklog` turns it into a story. */
function indexed(tasks: readonly FakeTask[]): BacklogStory[] {
  return tasks.map((task) =>
    storyFromRead(
      storyRead("task", viewText(task), { id: task.id, title: task.id, status: "Refined" }),
    ),
  );
}

const byId = (a: { id: string }, b: { id: string }) =>
  a.id.localeCompare(b.id, "en", { numeric: true });

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("the gate's other tasks from the mirror", () => {
  it("makes the same few CLI calls for 200 tasks and gives the failures of reading every view", () =>
    withOffice(async (t, office) => {
      const tasks = backlog();
      const slow = fakeCli(tasks);
      const everyView = await readGateInput(
        backlogStoryStore(slow.cli),
        "/base",
        "DIPO-1",
        DEFAULT_CONFIG,
      );
      // The list, a view per task (the story's own is the one it read first) and the milestones.
      expect(slow.calls.length).toBeGreaterThan(TASKS);

      office.immediate(() => {
        applyIndex(office, t.ids, indexed(tasks), {
          at: t.clock.now(),
          source: "base",
          sha: SHA_A,
        });
      });
      const others = cachedGateTasks(office, SHA_A);
      expect(others).toHaveLength(TASKS);

      const fast = fakeCli(tasks);
      const fromMirror = await readGateInput(
        backlogStoryStore(fast.cli),
        "/base",
        "DIPO-1",
        DEFAULT_CONFIG,
        others ?? [],
      );
      expect(fast.calls).toEqual([
        ["task", "view", "DIPO-1", "--plain"],
        ["milestone", "list", "--show-completed", "--plain"],
      ]);
      // A smaller backlog makes the same calls.
      const small = fakeCli(tasks.slice(0, 10));
      await readGateInput(
        backlogStoryStore(small.cli),
        "/base",
        "DIPO-1",
        DEFAULT_CONFIG,
        (others ?? []).slice(0, 10),
      );
      expect(small.calls).toEqual(fast.calls);

      const slowResult = evaluateGate(everyView, "pickup");
      const fastResult = evaluateGate(fromMirror, "pickup");
      expect(fastResult.failures).toEqual(slowResult.failures);
      const messages = fastResult.failures.map((failure) => failure.message);
      expect(messages).toContain(
        "ready DIPO-1 failed R13: dependency DIPO-900 is not an active task",
      );
      expect(messages).toContain(
        "ready DIPO-1 failed R14: dependency cycle: DIPO-1 -> DIPO-2 -> DIPO-1",
      );
      expect(messages).toContain(
        `ready DIPO-1 failed R19: branch "${SHARED}" is already used by DIPO-3`,
      );
      expect(messages).toContain(
        `ready DIPO-1 failed R19: branch "${SHARED}" is already used by DIPO-4`,
      );
      // The mirror lists the tasks by id, the CLI by status; the rules do not depend on the order.
      expect(fromMirror.activeTasks.toSorted(byId)).toEqual(everyView.activeTasks.toSorted(byId));
    }));

  it("is used only for the commit every task was read at", () =>
    withOffice(async (t, office) => {
      const tasks = backlog().slice(0, 6);
      const pass = (sha: string, read: BacklogStory[]) =>
        office.immediate(() => {
          applyIndex(office, t.ids, read, { at: t.clock.now(), source: "base", sha });
        });
      pass(SHA_A, indexed(tasks));
      expect(cachedGateTasks(office, SHA_A)).toHaveLength(6);
      // Read at another commit: not used for this one.
      expect(cachedGateTasks(office, SHA_B)).toBeNull();

      // A later pass moves every task to the new commit, with the changed data.
      const changed = tasks.map((task) =>
        task.id === "DIPO-3" ? { ...task, dependencies: ["DIPO-4"] } : task,
      );
      pass(SHA_B, indexed(changed));
      expect(cachedGateTasks(office, SHA_A)).toBeNull();
      const now = cachedGateTasks(office, SHA_B);
      expect(now?.find((task) => task.id === "DIPO-3")).toEqual({
        id: "DIPO-3",
        dependencies: ["DIPO-4"],
        branch: SHARED,
      });

      // A read of one story leaves what a pass stored as it is.
      const [first] = indexed(tasks);
      if (first === undefined) throw new Error("fixture has tasks");
      const key = storyRows(office)[0]?.key;
      if (key === undefined) throw new Error("the pass keyed the stories");
      office.immediate(() => {
        applyStory(office, key as never, first, { at: t.clock.now(), source: "base" });
      });
      expect(cachedGateTasks(office, SHA_B)).toHaveLength(6);

      // A task that left the backlog does not hold the mirror back.
      office.immediate(() => removeStory(office, key as never, t.clock.now()));
      expect(cachedGateTasks(office, SHA_B)).toHaveLength(5);
    }));
});
