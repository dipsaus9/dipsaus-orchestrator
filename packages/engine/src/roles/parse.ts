// A role file (`.dipo/roles/<name>.md`, 0017): YAML frontmatter and the role's instructions as the
// Markdown body. Strict like the office file: an unknown key is an error naming the file and the
// key path. A refused file never throws; the result is a value with one message naming the file.

import { RoleId } from "@dipsaus-orchestrator/contract";
import { z } from "zod";

import { parseYamlDocument } from "../platform/yaml";

export const ROLES_DIR = ".dipo/roles";

/** Roles that stay engine code (0001); a file with one of these names is an error. */
export const RESERVED_ROLES: readonly string[] = ["reviewer", "planner", "auditor", "scanner"];

/** The role file format version this dipo reads (0017). */
export const ROLE_FILE_VERSION = 1;

const roleFrontmatter = z
  .object({
    version: z.number().int(),
    purpose: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).optional(),
  })
  .strict();

/** A role loaded from its file. Every file role is a code role until M4 adds the others. */
export interface Role {
  readonly name: string;
  readonly purpose: string;
  readonly instructions: string;
  /** Overrides the tier's model and effort for this role (vision), used by a later story. */
  readonly model?: string;
  readonly effort?: string;
}

export type RoleParse =
  | { readonly ok: true; readonly role: Role }
  | { readonly ok: false; readonly message: string };

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

function refuse(path: string, problem: string): RoleParse {
  return { ok: false, message: `${path}: ${problem}` };
}

function issueText(issue: z.core.$ZodIssue): string {
  const key = issue.path.join(".") || "(top level)";
  if (issue.code === "unrecognized_keys") {
    return `unknown key ${issue.keys.map((k) => `\`${k}\``).join(", ")}; the key may need a newer dipo`;
  }
  return `key \`${key}\`: ${issue.message}`;
}

/** Parses the role file at `path` (repo-relative, `.dipo/roles/<name>.md`) from its `text`. */
export function parseRoleFile(path: string, text: string): RoleParse {
  const file = path.slice(path.lastIndexOf("/") + 1);
  if (!file.endsWith(".md")) return refuse(path, "a role file ends in .md");
  const name = file.slice(0, -3);
  if (!RoleId.safeParse(name).success) {
    return refuse(
      path,
      `\`${name}\` is not a valid role name (lowercase letters, digits, hyphens)`,
    );
  }
  if (RESERVED_ROLES.includes(name)) {
    return refuse(path, `\`${name}\` is a reserved role name; that role stays engine code`);
  }
  const split = FRONTMATTER.exec(text);
  if (split === null) return refuse(path, "no YAML frontmatter between --- lines at the top");
  const yaml = parseYamlDocument(split[1] ?? "");
  if (!yaml.ok) return refuse(path, `frontmatter: ${yaml.message}`);
  const parsed = roleFrontmatter.safeParse(yaml.value);
  if (!parsed.success) {
    return refuse(path, parsed.error.issues.map(issueText).join("; "));
  }
  if (parsed.data.version !== ROLE_FILE_VERSION) {
    return refuse(
      path,
      `key \`version\`: expected ${ROLE_FILE_VERSION}, found ${parsed.data.version}; the file may need a newer dipo`,
    );
  }
  const instructions = (split[2] ?? "").trim();
  if (instructions === "")
    return refuse(path, "the instructions (the body after the frontmatter) are empty");
  const { purpose, model, effort } = parsed.data;
  return {
    ok: true,
    role: {
      name,
      purpose,
      instructions,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    },
  };
}
