// The protected paths of 0021: the paths only dipo or the maintainer writes. One check for
// every guard that asks, the box's parts (`box/parts.ts`), its collisions (`box/collisions.ts`) and
// the pickup gate's References (R31, `gate/rules.ts`), so they never disagree. It lives beside the
// story folders it protects, since the gate (band 2) may not import the box (band 3, 0004).

import { foldName, inStoryFolder } from "./paths";

/** What makes a path protected: written only by dipo or the maintainer. */
export type ProtectedKind =
  | "git"
  | "backlog"
  | "dipo"
  | "ci"
  | "claude"
  | "gitConfig"
  | "backlogConfig"
  | "bunConfig"
  | "mcpConfig"
  | "link";

/** The fixed text of each kind, for the park detail. */
export const PROTECTED_TEXT: Readonly<Record<ProtectedKind, string>> = {
  git: "git's own folder (.git)",
  backlog: "the story store's folder, with the story's task file",
  dipo: "dipo's configuration (.dipo/)",
  ci: "CI configuration (.github/)",
  claude: "the Claude settings (.claude/settings.json)",
  gitConfig: "git's attributes or submodules (.gitattributes, .gitmodules)",
  backlogConfig: "the Backlog CLI's configuration (backlog.config.yml)",
  bunConfig: "Bun's configuration (bunfig.toml)",
  mcpConfig: "Claude Code's MCP server configuration (.mcp.json)",
  link: "a symlink or hard link",
};

/** `text` folded harder: compatibility forms (`ｂ`), combining marks dropped, then `foldName`. */
function lookAlike(text: string): string {
  return foldName(text.normalize("NFKD").replace(/\p{M}/gu, ""));
}

/**
 * The protected kind of the repo-relative `path`, or null. Compared folded (`foldName`), as an
 * APFS volume finds files; and, as a second layer, a path with characters outside ASCII is also
 * protected when its look-alike fold (`.gitattributeſ`, `ｂacklog/`) names a protected file.
 * `folders` are the story folders (`StoryStore.storyFolders`): a path in one is the `backlog` kind.
 */
export function protectedKind(path: string, folders: readonly string[]): ProtectedKind | null {
  const kind = protectedOf(foldName(path), folders);
  if (kind !== null) return kind;
  if (!/[^\p{ASCII}]/u.test(path)) return null;
  return protectedOf(lookAlike(path), folders.map(lookAlike));
}

function protectedOf(key: string, folders: readonly string[]): ProtectedKind | null {
  const parts = key.split("/");
  if (parts.includes(".git")) return "git";
  if (inStoryFolder(key, folders)) return "backlog";
  if (parts[0] === ".dipo") return "dipo";
  if (parts[0] === ".github") return "ci";
  if (key === ".claude/settings.json" || key === ".claude/settings.local.json") return "claude";
  const name = parts.at(-1);
  if (name === ".gitattributes" || name === ".gitmodules") return "gitConfig";
  return toolConfigOf(key, parts);
}

// The configuration of the tools dipo runs on checkouts of the repository (0021):
// after a story merges, dipo runs the Backlog CLI (a program built with Bun) and Bun in
// checkouts of the base, and the reviewer, a Claude Code session, runs on a copy of the story's
// commit. A part may not add, change or delete a file any of them reads its configuration from.
// The story folders themselves are the `backlog` kind.

/** The protected tool-configuration kind of the folded `key` (split into `parts`), or null. */
function toolConfigOf(key: string, parts: readonly string[]): ProtectedKind | null {
  // Backlog.md 1.53, README section "Configuration": the project configuration is
  // `backlog.config.yml` at the project root when present, otherwise the one in a folder it keeps
  // its stories in, which the store names (`storyFolders`, the `backlog` kind). dipo runs the CLI
  // at the repository root.
  if (key === "backlog.config.yml") return "backlogConfig";
  // Bun: https://bun.sh/docs/runtime/bunfig (Bun reads `bunfig.toml` in the folder it runs in;
  // `.bunfig.toml` is the name of its user-level file, protected too). In any folder, as a
  // workspace script runs Bun in its package's folder.
  const name = parts.at(-1);
  if (name === "bunfig.toml" || name === ".bunfig.toml") return "bunConfig";
  // Claude Code: https://docs.claude.com/en/docs/claude-code/mcp (project-scoped servers live in
  // `.mcp.json` at the project's root).
  if (key === ".mcp.json") return "mcpConfig";
  return null;
}
