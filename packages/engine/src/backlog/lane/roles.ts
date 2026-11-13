// The lane-b kinds `role-add`, `role-edit` and `role-remove` (DIPO-474; 0010, 0022): what a planning
// session's confirmed role proposals change, the files `.dipo/roles/<name>.md` (0017). Each is a
// target state applied to the `_backlog` worktree's files, and each checks again when it applies:
//
// - `role-add`: the file exists with the fields. An existing file is never overwritten, so a role
//   file that appeared after the confirm makes the change not apply (an identical one holds it).
// - `role-edit`: the file reads with the fields given, every other field and line kept. A role
//   whose file is gone, or an edit whose result no longer loads, does not apply.
// - `role-remove`: the file is gone. A role whose file is gone does not apply, and neither does a
//   removal while a story that is not Done has the role's label.
//
// The kinds change files under `.dipo/roles/` only (`dirs`); the lane drops anything else outside
// `backlog/`.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseRoleFile, ROLES_DIR } from "../../roles/parse";
import { editRoleFile, renderRoleFile, roleFilePath } from "../../roles/file";
import { readLabels } from "../../story-store/fields/labels";
import {
  ROLE_ADD_KIND,
  ROLE_EDIT_KIND,
  ROLE_REMOVE_KIND,
  RoleAddTarget,
  RoleEditTarget,
  RoleRemoveTarget,
} from "../../story-store/planning";
import { viewStory } from "../fields/write";
import { listAll } from "../list";

import type { ApplyContext, ApplyOutcome, LaneOpKind } from "./ops";

export { ROLE_ADD_KIND, ROLE_EDIT_KIND, ROLE_REMOVE_KIND };

const DIRS = [`${ROLES_DIR}/`];

/** The stories that are not Done, drafts included, that carry the label `role:<name>`. */
export async function openStoriesOfRole(ctx: ApplyContext, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const kind of ["task", "draft"] as const) {
    const list = await listAll(ctx.cli, ctx.cwd, kind);
    for (const entry of list.entries) {
      if (entry.group === "Done") continue;
      const view = await viewStory({ cli: ctx.cli, cwd: ctx.cwd, id: entry.id, kind }, false);
      if (view.status === "Done") continue;
      if (readLabels(view.labels).roles.includes(name)) found.push(entry.id);
    }
  }
  return found;
}

function invalid(what: string, error: { readonly message: string }): ApplyOutcome {
  return { applies: false, reason: `the target is not a valid ${what}: ${error.message}` };
}

/** Writes `text` to the role file `path` unless it holds it already. */
function write(cwd: string, path: string, text: string): void {
  const file = join(cwd, path);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export const roleAddKind: LaneOpKind = {
  kind: ROLE_ADD_KIND,
  dirs: DIRS,
  async apply(ctx, raw) {
    const parsed = RoleAddTarget.safeParse(raw);
    if (!parsed.success) return invalid("role to add", parsed.error);
    const { name, purpose, model, effort, instructions } = parsed.data;
    const path = roleFilePath(name);
    const text = renderRoleFile({ purpose, model, effort, instructions });
    const loaded = parseRoleFile(path, text);
    if (!loaded.ok) return { applies: false, reason: loaded.message };
    const file = join(ctx.cwd, path);
    if (existsSync(file) && readFileSync(file, "utf8") !== text) {
      return { applies: false, reason: `the role file ${path} exists now` };
    }
    write(ctx.cwd, path, text);
    return { applies: true };
  },
};

export const roleEditKind: LaneOpKind = {
  kind: ROLE_EDIT_KIND,
  dirs: DIRS,
  async apply(ctx, raw) {
    const parsed = RoleEditTarget.safeParse(raw);
    if (!parsed.success) return invalid("role edit", parsed.error);
    const { run: _run, proposal: _proposal, name, ...changes } = parsed.data;
    const path = roleFilePath(name);
    const file = join(ctx.cwd, path);
    if (!existsSync(file)) {
      return { applies: false, reason: `the role file ${path} no longer exists` };
    }
    const text = editRoleFile(readFileSync(file, "utf8"), changes);
    if (text === null) {
      return {
        applies: false,
        reason: `${path}: no YAML frontmatter between --- lines at the top`,
      };
    }
    const loaded = parseRoleFile(path, text);
    if (!loaded.ok) return { applies: false, reason: loaded.message };
    write(ctx.cwd, path, text);
    return { applies: true };
  },
};

export const roleRemoveKind: LaneOpKind = {
  kind: ROLE_REMOVE_KIND,
  dirs: DIRS,
  async apply(ctx, raw) {
    const parsed = RoleRemoveTarget.safeParse(raw);
    if (!parsed.success) return invalid("role removal", parsed.error);
    const { name } = parsed.data;
    const path = roleFilePath(name);
    const file = join(ctx.cwd, path);
    if (!existsSync(file)) {
      return { applies: false, reason: `the role file ${path} no longer exists` };
    }
    const stories = await openStoriesOfRole(ctx, name);
    if (stories.length > 0) {
      return {
        applies: false,
        reason: `${stories.join(", ")} ${stories.length === 1 ? "has" : "have"} the label role:${name} and ${stories.length === 1 ? "is" : "are"} not Done`,
      };
    }
    rmSync(file);
    return { applies: true };
  },
};
