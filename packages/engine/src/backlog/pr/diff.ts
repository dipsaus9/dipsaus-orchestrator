// Gathers the diff of a backlog PR for the structural check (`check.ts`): the paths changed between
// the merge base and the head, and for each task or draft among them where it is on both sides and
// how the Backlog CLI shows it. Task files are never read directly (0010 section 1): the engine's
// backlog worktree `_backlog` is checked out at each side in turn and the CLI views the tasks there,
// then the worktree returns to what it had checked out. The caller runs this inside one item of the
// office git queue, so nothing else of the office uses `_backlog` meanwhile.

import { BASE_CHECKOUT_CONFIG, BASE_CHECKOUT_ENV, type GitLocation } from "../../git/hardened";
import type { GitSession } from "../../git/office";
import type { GitStepOptions } from "../../git/runner";
import { mapLimited, VIEW_CONCURRENCY } from "../../stories/read";
import { BacklogParseError, parseView } from "../plain";
import { type BacklogCli, BacklogCommandError, runBacklog } from "../runner";

import type { ParsedView, PrDiff, TaskChange, TaskSide } from "./check";

const CHECKOUT: GitStepOptions = { config: BASE_CHECKOUT_CONFIG, env: BASE_CHECKOUT_ENV };

/** Backlog.md directories that hold task and draft files, most specific first. */
const TASK_DIRS: readonly (readonly [string, TaskSide["where"]])[] = [
  ["backlog/archive/tasks/", "archived"],
  ["backlog/archive/drafts/", "archived"],
  ["backlog/completed/", "completed"],
  ["backlog/tasks/", "task"],
  ["backlog/drafts/", "draft"],
];

/** `<id> - <title>.md`, as Backlog.md names a task file. */
const TASK_FILE = /^([A-Za-z][A-Za-z0-9]*-\d+(?:\.\d+)*) - .*\.md$/;

/** The task id and where it is, for a task or draft file path; null for any other path. */
export function taskOfPath(
  path: string,
): { readonly id: string; readonly where: TaskSide["where"] } | null {
  for (const [dir, where] of TASK_DIRS) {
    if (!path.startsWith(dir)) continue;
    const rest = path.slice(dir.length);
    if (rest.includes("/")) return null;
    const match = TASK_FILE.exec(rest);
    return match?.[1] === undefined ? null : { id: match[1].toUpperCase(), where };
  }
  return null;
}

function nulSplit(output: string): string[] {
  return output.split("\0").filter((part) => part !== "");
}

export interface CollectOptions {
  readonly git: GitSession;
  /** The `_backlog` worktree. */
  readonly worktree: Extract<GitLocation, { kind: "worktree" }>;
  readonly cli: BacklogCli;
  /** The merge base of the head and the base branch. */
  readonly base: string;
  /** The PR's head commit. */
  readonly head: string;
}

/** Where every task id is in `commit`. */
async function locations(git: GitSession, commit: string): Promise<Map<string, TaskSide["where"]>> {
  const out = await git.ok(git.repository, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    commit,
    "--",
    "backlog/",
  ]);
  const found = new Map<string, TaskSide["where"]>();
  for (const path of nulSplit(out)) {
    const task = taskOfPath(path);
    // A task file in tasks/ wins over a leftover copy elsewhere.
    if (task !== null && (!found.has(task.id) || task.where === "task")) {
      found.set(task.id, task.where);
    }
  }
  return found;
}

async function view(cli: BacklogCli, cwd: string, kind: "task" | "draft", id: string) {
  try {
    const { stdout } = await runBacklog(cli, cwd, [kind, "view", id, "--plain"]);
    return { ok: true, task: parseView(stdout) } satisfies ParsedView;
  } catch (error) {
    if (error instanceof BacklogParseError) {
      return { ok: false, error: error.message } satisfies ParsedView;
    }
    if (error instanceof BacklogCommandError) {
      return {
        ok: false,
        error: `\`backlog ${kind} view\` failed: ${error.message.split("\n")[0] ?? ""}`,
      } satisfies ParsedView;
    }
    throw error;
  }
}

/** Checks out `commit` detached in the worktree and views the tasks of `ids` there. */
async function sideAt(
  options: CollectOptions,
  commit: string,
  ids: readonly string[],
): Promise<Map<string, TaskSide>> {
  const { git, worktree, cli } = options;
  const where = await locations(git, commit);
  const shown = ids.filter((id) => {
    const at = where.get(id);
    return at === "task" || at === "draft";
  });
  if (shown.length > 0) {
    await git.ok(
      worktree,
      ["checkout", "--quiet", "--force", "--no-recurse-submodules", "--detach", commit],
      CHECKOUT,
    );
    await git.ok(worktree, ["clean", "-fdq"]);
  }
  const views = new Map(
    await mapLimited(shown, VIEW_CONCURRENCY, async (id) => {
      const kind = where.get(id) === "draft" ? "draft" : "task";
      return [id, await view(cli, worktree.workTree, kind, id)] as const;
    }),
  );
  const sides = new Map<string, TaskSide>();
  for (const id of ids) {
    const at = where.get(id);
    const parsed = views.get(id);
    if (at === undefined) sides.set(id, { where: "absent" });
    else if ((at === "task" || at === "draft") && parsed !== undefined) {
      sides.set(id, { where: at, view: parsed });
    } else if (at === "archived" || at === "completed") sides.set(id, { where: at });
    else sides.set(id, { where: "absent" });
  }
  return sides;
}

/** The PR diff between `base` and `head`; the worktree is back on its own checkout afterwards. */
export async function collectPrDiff(options: CollectOptions): Promise<PrDiff> {
  const { git, worktree, base, head } = options;
  const paths = nulSplit(
    await git.ok(git.repository, ["diff", "--name-only", "-z", "--no-renames", base, head]),
  );
  const ids = [
    ...new Set(paths.map((path) => taskOfPath(path)?.id).filter((id) => id !== undefined)),
  ].toSorted();

  const branch = await git.step(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const original =
    branch.code === 0 && branch.stdout.trim() !== ""
      ? { branch: branch.stdout.trim() }
      : { sha: (await git.ok(worktree, ["rev-parse", "--verify", "HEAD"])).trim() };
  try {
    const before = await sideAt(options, base, ids);
    const after = await sideAt(options, head, ids);
    const tasks: TaskChange[] = ids.map((id) => ({
      id,
      before: before.get(id) ?? { where: "absent" },
      after: after.get(id) ?? { where: "absent" },
    }));
    return { paths, tasks };
  } finally {
    await git.ok(
      worktree,
      [
        "checkout",
        "--quiet",
        "--force",
        "--no-recurse-submodules",
        ...("branch" in original ? [original.branch] : ["--detach", original.sha]),
      ],
      CHECKOUT,
    );
    await git.ok(worktree, ["clean", "-fdq"]);
  }
}
