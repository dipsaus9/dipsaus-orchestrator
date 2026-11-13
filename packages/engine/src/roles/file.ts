// Role files written by code (DIPO-474, 0017): a new file from a role's fields, and an edit that
// rewrites only the fields it names and keeps every other line of the file. Pure.

import { ROLE_FILE_VERSION, ROLES_DIR } from "./parse";

/** The repo-relative path of the role file of `name`. */
export function roleFilePath(name: string): string {
  return `${ROLES_DIR}/${name}.md`;
}

/** The fields of a role file; `model` and `effort` are optional in the file. */
export interface RoleFields {
  readonly purpose: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly instructions: string;
}

/** The fields an edit changes: each given replaces the file's. */
export interface RoleChanges {
  readonly purpose?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly instructions?: string | undefined;
}

// A JSON string is a YAML double-quoted scalar, so any one-line text is written safely.
const scalar = (text: string): string => JSON.stringify(text.trim());

/** The text of a new role file. */
export function renderRoleFile(fields: RoleFields): string {
  const lines = [
    "---",
    `version: ${ROLE_FILE_VERSION}`,
    `purpose: ${scalar(fields.purpose)}`,
    ...(fields.model === undefined ? [] : [`model: ${scalar(fields.model)}`]),
    ...(fields.effort === undefined ? [] : [`effort: ${scalar(fields.effort)}`]),
    "---",
    "",
    fields.instructions.trim(),
    "",
  ];
  return lines.join("\n");
}

const FRONTMATTER = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*)(?:(\r?\n)([\s\S]*))?$/;

/**
 * `text` with the changed fields rewritten: a changed frontmatter key replaces its line (and the
 * indented lines that continue it) or is added before the closing line, and changed instructions
 * replace the body. Everything else stays byte for byte. Null when the text has no frontmatter.
 */
export function editRoleFile(text: string, changes: RoleChanges): string | null {
  const split = FRONTMATTER.exec(text);
  if (split === null) return null;
  const [, open = "", front = "", close = "", newline = "", body = ""] = split;
  let lines = front.split(/\r?\n/);
  for (const key of ["purpose", "model", "effort"] as const) {
    const value = changes[key];
    if (value === undefined) continue;
    const line = `${key}: ${scalar(value)}`;
    const at = lines.findIndex((candidate) => candidate.startsWith(`${key}:`));
    if (at < 0) {
      lines.push(line);
      continue;
    }
    let end = at + 1;
    while (end < lines.length && /^[ \t]/.test(lines[end] ?? "")) end += 1;
    lines = [...lines.slice(0, at), line, ...lines.slice(end)];
  }
  const rest =
    changes.instructions === undefined
      ? `${newline}${body}`
      : `\n\n${changes.instructions.trim()}\n`;
  return `${open}${lines.join("\n")}${close}${rest}`;
}
