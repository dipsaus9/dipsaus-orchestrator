// The lane-b operation kind `init` (0010 sections 2 and 6): each step of office init is one
// journaled operation with a target state, applied through the Backlog CLI in the engine's backlog
// worktree and committed as `backlog: init <step>`. Every step reads what the worktree holds and
// changes only what differs, so a step whose target is already there changes nothing and the lane
// commits nothing for it.
//
// Steps, in the order office init journals them:
//   statuses        rewrite only the `statuses:` line of `backlog/config.yml`, checked with
//                   `config get statuses` (step 1, and step 4 once no task uses `To Do`);
//   defaultStatus   `config set defaultStatus Refined` (step 2);
//   settings        `checkActiveBranches: true`, `remoteOperations: true`, `autoCommit: false`
//                   (the office checks); before the migration, so a CLI that would commit by
//                   itself (`autoCommit: true`) does not commit the migration's edits;
//   migrate         every `To Do` task gets `task edit -s Refined`, except those in progress on
//                   their own branch (step 3);
//   gitignore       add `.dipo/.gitignore` holding `office.local.yaml` when it is absent (0007
//                   section 2); the only path outside `backlog/` the kind may change.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { ApplyContext, ApplyOutcome, LaneOpKind } from "../../backlog/lane/ops";
import { parseList } from "../../backlog/plain";
import { type BacklogCli, runBacklog } from "../../backlog/runner";

import {
  CONFIG_FILE,
  DEFAULT_STATUS,
  LEGACY_STATUS,
  readStatuses,
  rewriteStatusesLine,
  targetStatuses,
} from "./statuses";

/** The lane operation kind of office init. */
export const INIT_KIND = "init";

/** `.dipo/.gitignore`, relative to the repository root, and the one line it holds (0017). */
export const DIPO_GITIGNORE = ".dipo/.gitignore";
export const DIPO_GITIGNORE_TEXT = "office.local.yaml\n";

/** The office checks at load (0010 section 6): Backlog.md settings and the value dipo needs. */
export const OFFICE_SETTINGS: readonly { readonly key: string; readonly value: string }[] = [
  { key: "checkActiveBranches", value: "true" },
  { key: "remoteOperations", value: "true" },
  { key: "autoCommit", value: "false" },
];

export const InitTarget = z.discriminatedUnion("step", [
  z
    .object({
      step: z.literal("statuses"),
      /** True once no task on the base uses `To Do`: the 0012 list alone (step 4). */
      final: z.boolean(),
      /** Statuses outside the 0012 list that tasks on the base still use; a final list keeps them. */
      inUse: z.array(z.string()),
    })
    .strict(),
  z.object({ step: z.literal("defaultStatus") }).strict(),
  z.object({ step: z.literal("settings") }).strict(),
  z
    .object({
      step: z.literal("migrate"),
      /** `To Do` task ids left alone: a branch <ID>/... exists for each. */
      leave: z.array(z.string()),
    })
    .strict(),
  z.object({ step: z.literal("gitignore") }).strict(),
]);
export type InitTarget = z.infer<typeof InitTarget>;
export type InitStep = InitTarget["step"];

/** The commit subject of each step: `backlog: init <subject>`. */
export const STEP_SUBJECTS: Readonly<Record<InitStep, string>> = {
  statuses: "statuses",
  defaultStatus: "defaultStatus",
  settings: "settings",
  migrate: "To Do tasks",
  gitignore: DIPO_GITIGNORE,
};

/** `backlog config get <key>`, trimmed. */
export async function configGet(cli: BacklogCli, cwd: string, key: string): Promise<string> {
  const { stdout } = await runBacklog(cli, cwd, ["config", "get", key]);
  return stdout.trim();
}

/** Sets `key` to `value` when it differs, then reads it back; a mismatch is the reason it failed. */
async function ensureSetting(
  cli: BacklogCli,
  cwd: string,
  key: string,
  value: string,
): Promise<string | null> {
  if ((await configGet(cli, cwd, key)) === value) return null;
  await runBacklog(cli, cwd, ["config", "set", key, value]);
  const back = await configGet(cli, cwd, key);
  return back === value ? null : `${key} read back as ${JSON.stringify(back)}, not ${value}`;
}

/** The ids of the tasks `task list --plain` shows under `status`. */
export async function tasksWithStatus(
  cli: BacklogCli,
  cwd: string,
  status: string,
): Promise<string[]> {
  const { stdout } = await runBacklog(cli, cwd, ["task", "list", "--plain"]);
  return parseList(stdout)
    .entries.filter((entry) => entry.group === status)
    .map((entry) => entry.id);
}

async function applyStatuses(
  ctx: ApplyContext,
  target: Extract<InitTarget, { step: "statuses" }>,
): Promise<ApplyOutcome> {
  const file = join(ctx.cwd, CONFIG_FILE);
  if (!existsSync(file)) return { applies: false, reason: `${CONFIG_FILE} does not exist` };
  const text = readFileSync(file, "utf8");
  const read = readStatuses(text);
  if (!read.ok) return { applies: false, reason: read.reason };
  const next = targetStatuses(read.statuses, target);
  if (next === null) return { applies: true };
  const rewritten = rewriteStatusesLine(text, next);
  if (rewritten === null) {
    return {
      applies: false,
      reason: `${CONFIG_FILE} has no one-line \`statuses: [...]\` entry to rewrite`,
    };
  }
  writeFileSync(file, rewritten);
  const back = await configGet(ctx.cli, ctx.cwd, "statuses");
  if (back !== next.join(", ")) {
    return {
      applies: false,
      reason: `\`config get statuses\` read back ${JSON.stringify(back)}, not ${JSON.stringify(next.join(", "))}`,
    };
  }
  return { applies: true };
}

async function applyMigrate(
  ctx: ApplyContext,
  target: Extract<InitTarget, { step: "migrate" }>,
): Promise<ApplyOutcome> {
  const leave = new Set(target.leave.map((id) => id.toUpperCase()));
  const moving = (await tasksWithStatus(ctx.cli, ctx.cwd, LEGACY_STATUS)).filter(
    (id) => !leave.has(id.toUpperCase()),
  );
  if (moving.length === 0) return { applies: true };
  for (const id of moving) {
    await runBacklog(ctx.cli, ctx.cwd, ["task", "edit", id, "-s", DEFAULT_STATUS]);
  }
  const still = new Set(await tasksWithStatus(ctx.cli, ctx.cwd, LEGACY_STATUS));
  const stuck = moving.filter((id) => still.has(id));
  if (stuck.length > 0) {
    return { applies: false, reason: `${stuck.join(", ")} still read back as ${LEGACY_STATUS}` };
  }
  return { applies: true };
}

function applyGitignore(ctx: ApplyContext): ApplyOutcome {
  const file = join(ctx.cwd, DIPO_GITIGNORE);
  // Added only if absent; an existing file is never changed (0007 section 2, 0010 section 11).
  if (existsSync(file)) return { applies: true };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, DIPO_GITIGNORE_TEXT);
  return { applies: true };
}

/** The `init` kind. */
export function initKind(): LaneOpKind {
  return {
    kind: INIT_KIND,
    paths: [DIPO_GITIGNORE],
    async apply(ctx, raw) {
      const parsed = InitTarget.safeParse(raw);
      if (!parsed.success) {
        return {
          applies: false,
          reason: `the target is not an init step: ${parsed.error.message}`,
        };
      }
      const target = parsed.data;
      switch (target.step) {
        case "statuses":
          return applyStatuses(ctx, target);
        case "defaultStatus": {
          const failed = await ensureSetting(ctx.cli, ctx.cwd, "defaultStatus", DEFAULT_STATUS);
          return failed === null ? { applies: true } : { applies: false, reason: failed };
        }
        case "settings": {
          const failed: string[] = [];
          for (const { key, value } of OFFICE_SETTINGS) {
            const reason = await ensureSetting(ctx.cli, ctx.cwd, key, value);
            if (reason !== null) failed.push(reason);
          }
          return failed.length === 0
            ? { applies: true }
            : { applies: false, reason: failed.join("; ") };
        }
        case "migrate":
          return applyMigrate(ctx, target);
        case "gitignore":
          return applyGitignore(ctx);
      }
    },
  };
}
