// The lane-b operation kind `init` (0010): each step of office init is one
// journaled operation with a target state, applied through the Backlog CLI in the engine's backlog
// worktree and committed as `backlog: init <step>`. Every step reads what the worktree holds and
// changes only what differs, so a step whose target is already there changes nothing and the lane
// commits nothing for it.
//
// Steps, in the order office init journals them:
//   statuses        rewrite only the `statuses:` line of `backlog/config.yml`, checked with
//                   `config get statuses`; once no task uses `To Do`, again with the 0012
//                   list alone;
//   defaultStatus   `config set defaultStatus Refined`;
//   settings        `checkActiveBranches: true`, `remoteOperations: true`, `autoCommit: false`
//                   (the office checks); before the migration, so a CLI that would commit by
//                   itself (`autoCommit: true`) does not commit the migration's edits;
//   migrate         every `To Do` task gets `task edit -s Refined`, except those in progress on
//                   their own branch;
//   roles           write `.dipo/roles/developer.md` (version 1, a purpose, the bundled developer
//                   instructions as the body) while the base holds no role file (0017);
//   roleLabels      `task edit --add-label role:developer` on every task that is not Done and has
//                   no `role:` label, while the base holds no role file;
//   gitignore       add `.dipo/.gitignore` holding `office.local.yaml` when it is absent (0007);
//                   the only path outside `backlog/` the kind may change.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { ApplyContext, ApplyOutcome, LaneOpKind } from "../lane/ops";
import { listAll } from "../list";
import { parseView } from "../plain";
import { type BacklogCli, runBacklog } from "../runner";
import { DONE_STATUS } from "../../merge/close-out";
import developerInstructions from "../../prompts/roles/developer.md" with { type: "text" };
import { ROLE_FILE_VERSION, ROLES_DIR } from "../../roles/parse";
import { ROLE_PREFIX, readLabels } from "../../story-store/fields/labels";

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

/** The office checks at load (0010): Backlog.md settings and the value dipo needs. */
export const OFFICE_SETTINGS: readonly { readonly key: string; readonly value: string }[] = [
  { key: "checkActiveBranches", value: "true" },
  { key: "remoteOperations", value: "true" },
  { key: "autoCommit", value: "false" },
];

/** The role file init seeds, relative to the repository root, and the role it names (0017). */
export const SEED_ROLE = "developer";
export const SEED_ROLE_FILE = `${ROLES_DIR}/${SEED_ROLE}.md`;
export const SEED_ROLE_PURPOSE = "Implements one story in this repository.";

/** The text of the seeded role file: frontmatter, then the bundled developer instructions. */
export function seedRoleText(): string {
  return `---\nversion: ${ROLE_FILE_VERSION}\npurpose: ${SEED_ROLE_PURPOSE}\n---\n\n${developerInstructions.trim()}\n`;
}

export const InitTarget = z.discriminatedUnion("step", [
  z
    .object({
      step: z.literal("statuses"),
      /** True once no task on the base uses `To Do`: the 0012 list alone. */
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
  z.object({ step: z.literal("roles") }).strict(),
  z.object({ step: z.literal("roleLabels") }).strict(),
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
  roles: SEED_ROLE_FILE,
  roleLabels: `${ROLE_PREFIX}${SEED_ROLE} labels`,
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

/** The ids of the tasks `task list --plain` shows under `status`, from the whole list (DIPO-323). */
export async function tasksWithStatus(
  cli: BacklogCli,
  cwd: string,
  status: string,
): Promise<string[]> {
  return (await listAll(cli, cwd, "task")).entries
    .filter((entry) => entry.group === status)
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
  // Added only if absent; an existing file is never changed (0007, 0010).
  if (existsSync(file)) return { applies: true };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, DIPO_GITIGNORE_TEXT);
  return { applies: true };
}

function applyRoles(ctx: ApplyContext): ApplyOutcome {
  const file = join(ctx.cwd, SEED_ROLE_FILE);
  // Written only if absent; an existing file is never changed.
  if (existsSync(file)) return { applies: true };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, seedRoleText());
  return { applies: true };
}

/** The ids of the tasks that are not Done and carry no `role:` label, from their views. */
async function tasksWithoutRole(cli: BacklogCli, cwd: string): Promise<string[]> {
  const open = (await listAll(cli, cwd, "task")).entries.filter(
    (entry) => entry.group !== DONE_STATUS,
  );
  const ids: string[] = [];
  for (const entry of open) {
    const { stdout } = await runBacklog(cli, cwd, ["task", "view", entry.id, "--plain"]);
    if (readLabels(parseView(stdout).labels).roles.length === 0) ids.push(entry.id);
  }
  return ids;
}

async function applyRoleLabels(ctx: ApplyContext): Promise<ApplyOutcome> {
  const label = `${ROLE_PREFIX}${SEED_ROLE}`;
  const missing = await tasksWithoutRole(ctx.cli, ctx.cwd);
  for (const id of missing) {
    await runBacklog(ctx.cli, ctx.cwd, ["task", "edit", id, "--add-label", label]);
  }
  const still = new Set(await tasksWithoutRole(ctx.cli, ctx.cwd));
  const stuck = missing.filter((id) => still.has(id));
  if (stuck.length > 0) {
    return { applies: false, reason: `${stuck.join(", ")} still read back without a role label` };
  }
  return { applies: true };
}

/** The `init` kind. */
export function initKind(): LaneOpKind {
  return {
    kind: INIT_KIND,
    paths: [DIPO_GITIGNORE, SEED_ROLE_FILE],
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
        case "roles":
          return applyRoles(ctx);
        case "roleLabels":
          return applyRoleLabels(ctx);
        case "gitignore":
          return applyGitignore(ctx);
      }
    },
  };
}
