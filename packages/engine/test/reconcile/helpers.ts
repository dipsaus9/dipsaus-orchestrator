// Shared setup for the reconcile tests (DIPO-56): the Backlog fixture on a bare `origin`, opened
// and loaded as an office with real git, the story index and (optionally) more features, but with
// a scripted Backlog CLI. `_base` answers from a task table; any other checkout (the branch read's
// scratch directory) answers from the story's own task file there, which these tests write as
// JSON. So a test sets what the base and a story branch say without the real CLI, and stays fast.
// Claims are real git worktrees with a claim commit and their rows written directly, as a claim
// records them; `setBranch` commits on the branch, `editWorktree` changes the file uncommitted.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ChildProcess,
  type OfficeId,
  RunId,
  type Spawn,
  type SpawnOptions,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import type { FeatureModule } from "../../src/commands/registry";
import type { OfficeHandle } from "../../src/db/office";
import { EngineGit } from "../../src/git";
import { readWorktreeSnapshot } from "../../src/git/snapshot";
import { systemSpawn } from "../../src/platform/process";
import { insertRun } from "../../src/run/records";
import { StoryIndex } from "../../src/stories/feature";
import { type ClaimRecord, insertClaim, liveClaimOf } from "../../src/worktree/records";
import { BACKLOG_FIXTURE, type OfficeSetup, officeSetup, resultOf, send } from "../office/helpers";

/** A task as the scripted CLI prints it. */
export interface FakeTask {
  readonly id: string;
  readonly title?: string;
  readonly status: string;
  readonly labels?: readonly string[];
  /** The field block's lines after `branch`, for example a `park:` line. */
  readonly fields?: readonly string[];
  /** Criteria as `[checked, text]`. */
  readonly criteria?: readonly (readonly [boolean, string])[];
}

/** The task table of `_base` (key `BASE`). */
export type Tables = Map<string, Map<string, FakeTask>>;

export const BASE = "base";

const ICONS: Readonly<Record<string, string>> = { "In Progress": "◒", Done: "✔" };

export function branchOf(id: string): string {
  return `${id}/a-story`;
}

/** `task view --plain` of a fake task. */
export function viewText(task: FakeTask): string {
  const criteria = task.criteria ?? [[false, "It works"]];
  return [
    `File: /office/backlog/tasks/${task.id.toLowerCase()} - Story.md`,
    "",
    `Task ${task.id} - ${task.title ?? `Story ${task.id}`}`,
    "=".repeat(50),
    "",
    `Status: ${ICONS[task.status] ?? "○"} ${task.status}`,
    "Created: 2026-10-12 11:28 (UTC)",
    `Labels: ${(task.labels ?? ["tier:S"]).join(", ")}`,
    "",
    "Description:",
    "-".repeat(50),
    `Outcome: ${task.id} works.`,
    "",
    "```dipo",
    `branch: "${branchOf(task.id)}"`,
    ...(task.fields ?? []),
    "```",
    "",
    "Acceptance Criteria:",
    "-".repeat(50),
    ...criteria.map(([checked, text], i) => `- [${checked ? "x" : " "}] #${i + 1} ${text}`),
    "",
  ].join("\n");
}

function listText(tasks: Iterable<FakeTask>): string {
  const groups = new Map<string, FakeTask[]>();
  for (const task of tasks) groups.set(task.status, [...(groups.get(task.status) ?? []), task]);
  const lines: string[] = [];
  for (const [status, members] of groups) {
    lines.push(`${status}:`);
    for (const task of members) lines.push(`  ${task.id} - ${task.title ?? `Story ${task.id}`}`);
    lines.push("");
  }
  return lines.join("\n");
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body ?? new ReadableStream();
}

function child(stdout: string, stderr = "", code = 0): ChildProcess {
  return {
    pid: 4242,
    stdin: null,
    stdout: stream(stdout),
    stderr: stream(stderr),
    exited: Promise.resolve({ code, signal: null }),
    kill: () => {},
  };
}

/**
 * A Backlog CLI `Spawn` answering `task list`, `task view` and `draft list` from `tables`: the
 * `_base` worktree reads `tables.get(BASE)`, any other worktree its own table by canonical path.
 */
export function fakeBacklog(tables: Tables): { spawn: Spawn; calls: SpawnOptions[] } {
  const calls: SpawnOptions[] = [];
  const spawn: Spawn = (options) => {
    calls.push(options);
    const cwd = options.cwd ?? "";
    const [kind, verb, id] = options.cmd.slice(1);
    if (kind === "draft") return child("");
    if (!cwd.endsWith("/_base")) {
      const file = id === undefined ? undefined : taskFileIn(cwd, id);
      if (verb !== "view" || file === undefined) return child("", `Task ${id ?? ""} not found.`, 1);
      return child(viewText(readFakeTask(readFileSync(file, "utf8"))));
    }
    const table = tables.get(BASE);
    if (table === undefined) return child("", `no table for ${cwd}`, 1);
    if (verb === "list") return child(listText(table.values()));
    const task = id === undefined ? undefined : table.get(id);
    if (verb === "view" && task !== undefined) return child(viewText(task));
    return child("", `Task ${id ?? ""} not found.`, 1);
  };
  return { spawn, calls };
}

/** The task file of `id` in the checkout `dir`, or undefined. */
function taskFileIn(dir: string, id: string): string | undefined {
  const tasks = join(dir, "backlog", "tasks");
  const name = readdirSync(tasks).find((n) => n.toLowerCase().startsWith(`${id.toLowerCase()} - `));
  return name === undefined ? undefined : join(tasks, name);
}

/**
 * A fake task file: a front matter block holding only the id, as a real task file opens, then the
 * task as JSON, which the fake CLI reads.
 */
function fakeTaskFile(task: FakeTask): string {
  return `---\nid: ${task.id}\n---\n${JSON.stringify(task)}`;
}

function readFakeTask(text: string): FakeTask {
  return JSON.parse(text.slice(text.indexOf("\n---\n") + 5)) as FakeTask;
}

/** Writes `task` over its task file in the worktree, in the fake task file format. */
export function editWorktree(claimed: Pick<ClaimRecord, "worktree">, task: FakeTask): string {
  const path =
    taskFileIn(claimed.worktree, task.id) ??
    join(claimed.worktree, "backlog", "tasks", `${task.id.toLowerCase()} - Story.md`);
  writeFileSync(path, fakeTaskFile(task));
  return path;
}

/** Commits `task` as the story's task file on its branch, as the claim and park commits do. */
export async function setBranch(
  o: Pick<ReconcileOffice, "repo">,
  claimed: Pick<ClaimRecord, "worktree">,
  task: FakeTask,
): Promise<string> {
  const path = editWorktree(claimed, task);
  for (const args of [
    ["git", "add", "--", path],
    ["git", "commit", "--quiet", "--no-verify", "-m", `${task.id}: status ${task.status}`],
  ] as const) {
    const result = await o.repo.run(args, claimed.worktree);
    if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr}`);
  }
  return (await o.repo.run(["git", "rev-parse", "HEAD"], claimed.worktree)).stdout.trim();
}

export interface ReconcileOffice {
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly engineGit: EngineGit;
  readonly index: StoryIndex;
  readonly tables: Tables;
  /** Sets the base table; takes effect at the next index pass. */
  setBase(tasks: readonly FakeTask[]): void;
}

export interface ReconcileOfficeOptions {
  /** The base table at load; TASK-1 Ready by default. */
  readonly base?: readonly FakeTask[];
  /** More feature modules, registered after the git and the story index (the reconciler). */
  readonly features?: (parts: {
    readonly engineGit: EngineGit;
    readonly index: StoryIndex;
    readonly setup: () => OfficeSetup;
  }) => readonly FeatureModule[];
  /** Runs before the office loads (claims, runs and parks written directly). */
  readonly beforeLoad?: (
    o: Omit<ReconcileOffice, "office" | "officeId">,
    office: OfficeHandle,
  ) => void | Promise<void>;
}

/** The Backlog fixture on a bare `origin`, loaded as an office with the scripted CLI. */
export function withReconcileOffice(
  options: ReconcileOfficeOptions,
  fn: (o: ReconcileOffice) => Promise<void>,
): Promise<void> {
  return withBareRemote(
    async (repo) => {
      await repo.commitAll("fixture");
      await repo.git("push", "--quiet", "-u", "origin", "main");
      await repo.git("remote", "set-head", "origin", "main");
      const tables: Tables = new Map([
        [BASE, tableOf(options.base ?? [{ id: "TASK-1", status: "Ready" }])],
      ]);
      const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
      let setup: OfficeSetup | undefined;
      const index = new StoryIndex({
        git: engineGit,
        cli: { spawn: fakeBacklog(tables).spawn },
        offices: {
          get: (office) => setup?.manager.get(office),
          config: (office) => setup?.manager.config(office),
        },
      });
      const more =
        options.features?.({
          engineGit,
          index,
          setup: () => {
            if (setup === undefined) throw new Error("the office setup is not built yet");
            return setup;
          },
        }) ?? [];
      const s = await officeSetup(repo.root, {
        features: [engineGit.feature, index.feature, ...more],
      });
      setup = s;
      try {
        const { office: officeId } = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        );
        const partial = {
          repo,
          s,
          engineGit,
          index,
          tables,
          setBase: (tasks: readonly FakeTask[]) => tables.set(BASE, tableOf(tasks)),
        };
        if (options.beforeLoad !== undefined) {
          await options.beforeLoad(partial, s.state.office(officeId));
        }
        const access = await s.manager.load(officeId);
        if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);
        await fn({ ...partial, officeId, office: access.office });
      } finally {
        index.stop();
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}

export function tableOf(tasks: readonly FakeTask[]): Map<string, FakeTask> {
  return new Map(tasks.map((task) => [task.id, task]));
}

/** The story key of `id`. */
export function keyOf(office: OfficeHandle, id: string): StoryKey {
  const row = office.get<{ key: string }>(
    "select key from stories where office_id = $office_id and story_id = $id and removed_at is null",
    { id },
  );
  if (row === null) throw new Error(`${id} has no key`);
  return row.key as StoryKey;
}

export interface ClaimOptions {
  /** The run is active (not ended); true by default. */
  readonly active?: boolean;
  /** What the claim commit writes on the branch; the story In Progress by default. */
  readonly task?: FakeTask;
}

/**
 * Claims `id` as a claim records it: a real worktree on its branch from `origin/main`, the
 * snapshot pinned on the office git, the claim (with its claim commit) and its run. The
 * worktree's table answers what the branch says.
 */
export async function claim(
  o: Pick<ReconcileOffice, "repo" | "s" | "engineGit" | "tables">,
  office: OfficeHandle,
  id: string,
  key: StoryKey,
  options: ClaimOptions = {},
): Promise<ClaimRecord> {
  const worktree = join(o.repo.root, "trees", id);
  await o.repo.git("worktree", "add", "--quiet", "-b", branchOf(id), worktree, "origin/main");
  const sha = (await o.repo.git("rev-parse", "origin/main")).trim();
  // The claim commit: the story's task file as the branch now holds it.
  const claimSha = await setBranch(o, { worktree }, options.task ?? { id, status: "In Progress" });
  const adminDir = (
    await o.repo.run(["git", "rev-parse", "--absolute-git-dir"], worktree)
  ).stdout.trim();
  const snapshot = readWorktreeSnapshot(worktree, adminDir);
  const runId = RunId.parse(o.s.ids.next("run"));
  // Locked as a claim locks it (0010 section 7).
  await o.repo.git("worktree", "lock", "--reason", `dipo ${runId}`, worktree);
  office.immediate(() => {
    insertClaim(office, {
      runId,
      key,
      story: id,
      branch: branchOf(id),
      worktree,
      base: "main",
      baseSha: sha,
      startSha: sha,
      claimSha,
      reused: false,
      snapshot,
      firstFeedback: null,
      claimedAt: o.s.clock.now(),
    });
    insertRun(office, {
      runId,
      kind: "story",
      key,
      story: id,
      tier: "S",
      role: "developer",
      model: "haiku",
      startSha: sha,
      branch: branchOf(id),
      worktree,
      slot: null,
      budgetUnit: "tokens",
      budgetLimit: 300_000,
      loopCap: 3,
      reviewRoundCap: null,
      configHash: "hash",
      overrideKeys: null,
      runProfileId: null,
      startedAt: o.s.clock.now(),
    });
    if (options.active === false) {
      office.run(
        "update runs set ended_at = $at, end_kind = 'stopped' where office_id = $office_id and run_id = $run",
        { run: runId, at: o.s.clock.now() },
      );
    }
  });
  o.engineGit.forOffice(office.officeId)?.pinWorktree(snapshot);
  const record = liveClaimOf(office, key);
  if (record === null || !existsSync(worktree)) throw new Error("the claim was not recorded");
  return record;
}

/** The `engine.notice` codes written after `afterSeq`, with their keys. */
export function noticesAfter(
  office: OfficeHandle,
  afterSeq = 0,
): { code: string; key: string | null; text: string }[] {
  return office
    .all<{ key: string | null; delta: string }>(
      "select key, delta from change_log where office_id = $office_id and seq > $after and type = 'engine.notice' order by seq",
      { after: afterSeq },
    )
    .map((row) => {
      const delta = JSON.parse(row.delta) as { code: string; text: string };
      return { code: delta.code, key: row.key, text: delta.text };
    });
}
