// The active tasks the Ready gate reads for R13, R14 and R19, from the mirror (DIPO-180). An index
// pass stores each task's dependencies and frozen branch on its `backlog_mirror` row together with
// the `_base` commit it read them at, so the gate does not run one Backlog CLI view per task.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeHandle } from "../../db/office";
import type { OfficeGit } from "../../git/office";
import type { GateTask } from "../types";

interface CachedRow {
  story_id: string;
  gate_sha: string | null;
  gate_dependencies: string | null;
  gate_branch: string | null;
}

const SHA = /^[0-9a-f]{40,64}$/;

/**
 * The commit the `_base` worktree at `path` is at, from the HEAD file of its administrative
 * directory (the worktree is detached, so HEAD holds the sha); null when it cannot be told. No git
 * step runs, so it also works inside a queue item that holds no session.
 */
export function baseSha(git: OfficeGit, path: string): string | null {
  const admin = git.adminDirOf(path);
  if (admin === null) return null;
  try {
    const head = readFileSync(join(admin, "HEAD"), "utf8").trim();
    return SHA.test(head) ? head : null;
  } catch {
    return null;
  }
}

/**
 * Every active task as the mirror holds it, when all of them were read at `sha`; null when none
 * was, or any was read at another commit or never read that way. The caller then brings the mirror
 * up to `sha` or reads the tasks itself.
 */
export function cachedGateTasks(office: OfficeHandle, sha: string): GateTask[] | null {
  const rows = office.all<CachedRow>(
    `select s.story_id, m.gate_sha, m.gate_dependencies, m.gate_branch
       from backlog_mirror m
       join stories s on s.office_id = m.office_id and s.key = m.key
      where m.office_id = $office_id and m.kind = 'task' and s.removed_at is null
      order by s.story_id`,
  );
  if (rows.length === 0) return null;
  const tasks: GateTask[] = [];
  for (const row of rows) {
    if (row.gate_sha !== sha || row.gate_dependencies === null) return null;
    tasks.push({
      id: row.story_id,
      dependencies: JSON.parse(row.gate_dependencies) as string[],
      ...(row.gate_branch === null ? {} : { branch: row.gate_branch }),
    });
  }
  return tasks;
}
