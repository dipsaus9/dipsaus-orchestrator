// Skills in worker sessions (0008 section 2; DIPO-130). No worker session has skill grants until
// DIPO-116, so no session loads a skill:
//
// - the plan passes `--disable-slash-commands` to every session, the self-test included. Without
//   it a user message that starts with `/<name>` expands a project skill from the worktree's
//   `.claude/skills` with no permission check, even without the Skill tool, and registers the
//   skill's frontmatter hooks, which run outside the sandbox (DIPO-116 probe p16c, Claude Code
//   2.1.301). Whether a bundled skill expands the same way is unverified. Steer and answer text
//   goes to the worker verbatim (`encode.ts`), so a steer that starts with `/` could do it. With
//   the flag nothing expands and `system/init` lists `skills: []` (probe p17b; recording
//   `safety-slash-skill`);
// - the parser reads `skills` from `system/init` as the backstop: a session that lists any skill
//   is stopped at its `system/init` (`startRefused`) and ends `startFailed` naming them.

/** The Claude Code flag that turns off skills and slash commands for the session. */
export const DISABLE_SLASH_COMMANDS = "--disable-slash-commands";

/** The `startFailed` detail of a session whose `system/init` lists skills. */
export function skillRefusal(skills: readonly string[]): string {
  const names = skills.join(", ");
  return `system/init lists ${skills.length === 1 ? "skill" : "skills"} ${names}, although the plan passed ${DISABLE_SLASH_COMMANDS}: a worker session has no skill grants, and a skill's hooks run outside the sandbox, so the session refuses to run (DIPO-130)`;
}
