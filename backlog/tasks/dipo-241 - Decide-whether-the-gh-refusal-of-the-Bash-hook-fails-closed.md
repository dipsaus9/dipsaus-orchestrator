---
id: DIPO-241
title: Fail the gh part of the Bash hook closed when the check cannot run
status: Done
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 23:34'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/hooks.ts
  - packages/daemon/src/hook.ts
  - packages/daemon/src/hook.test.ts
  - packages/engine/test/workers/hooks.test.ts
  - packages/engine/test/workers/plan.test.ts
priority: medium
type: enhancement
ordinal: 241000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a gh call is never let through only because the Bash PreToolUse check failed to run: when the check throws or cannot start and the command text contains a gh word, the hook exits 2, while every other Bash call still fails open.

Context: DIPO-195 (PR #281) dropped the Bash(gh) and Bash(gh *) deny rules when the hook relay is on, so the PreToolUse Bash check (packages/daemon/src/hook.ts runBash, gh-guard and the temp guard) is now the only barrier to a gh call. That hook is registered with no exit-2 fallback (packages/engine/src/workers/claude-cli/hooks.ts: "the Bash check fails open, so a broken check never blocks Bash"): if the check throws, the hook times out or the dipo binary cannot start, the call runs. Before DIPO-195 a fail-closed deny rule stopped gh. The gate hook (--gate, DIPO-164) already fails closed with exit 2 when it cannot print. The 0008 section 2 note of 2026-10-20 (DIPO-195) moves the refusal into the check but does not say the gh part now fails open. The sandbox still masks ~/.config/gh and GH_TOKEN.

Review note (2026-10-21): packages/engine/test/workers/plan.test.ts asserts the Bash hook command ends with ` hook PreToolUse --bash`, so a fallback appended to that command changes the test. `dipo hook` reads the payload from stdin, so a shell fallback that must see the command after dipo crashed has to keep a copy of stdin before it pipes it to dipo. A hook that times out is run by the Claude CLI anyway; that case stays fail-open, the residual risk the hooks.ts header already records for the web gate.

```dipo
branch: "DIPO-241/gh-check-fails-closed"
unknowns:
  - q: "When the Bash check cannot run, should a command that names gh be refused? (a) yes: a second hook entry for the gh words (or the --bash call itself) exits 2 when the check throws or cannot start and the command text contains a gh word, so gh fails closed while every other Bash call still fails open; a dated 0008 section 2 note records it (recommended: the deny rule it replaced failed closed); (b) no: keep fail-open and record in a dated 0008 note that gh is then guarded only by the sandbox's credential masking."
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): approved; the 0008 section 2 note of 2026-10-20 (DIPO-241): when the PreToolUse Bash check cannot run, a command that names gh is denied with exit 2, so the gh refusal fails closed as the Bash(gh *) deny rule did, while every other Bash call still fails open."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) hook.test.ts: with the check made to throw, a command with a gh word exits 2 with the reason on stderr, and a command with no gh word exits 0 with no output"
    - kind: "automated"
      check: "(unit) hooks.test.ts: the planned PreToolUse Bash hook entry carries the fallback that exits 2 for a gh word when dipo hook cannot start, and exits 0 otherwise"
    - kind: "automated"
      check: "(unit) a fallback run with a payload naming /usr/local/bin/gh pr list exits 2, and one with echo gh-free exits 0"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 When `dipo hook PreToolUse --bash` throws while it checks a command whose text contains a gh word (a word whose basename is gh), it prints nothing on stdout, writes a reason naming the engine and the code host on stderr and exits 2, so the call does not run
- [x] #2 The Bash hook entry planned in packages/engine/src/workers/claude-cli/hooks.ts has a fallback for a dipo that cannot start or crashes: it exits 2 when the hook payload's command contains a gh word and exits 0 otherwise, and its comment says the gh part fails closed while the rest fails open
- [x] #3 A Bash command with no gh word still fails open when the check throws or cannot start: exit 0 and no output
- [x] #4 packages/daemon/src/hook.test.ts covers a throwing check with and without a gh word, and packages/engine/test/workers/hooks.test.ts covers the planned entry and its fallback
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5DRAPDWXZEEQT7AGT81B3Z3 (Haiku, 33 turns, about $0.27). dipo's own reviewer (Opus) BLOCKED round 1 on a real gap (the shell fallback grepped the JSON payload, where a newline before gh is the escape \\n, so a gh call on a later line was missed); no fix round exists yet (DIPO-148), so it was fixed by hand over three independent review rounds. Result, per the 0008 section 2 note of 2026-10-20 (DIPO-241): when the PreToolUse Bash check throws, the daemon exits 2 with a reason naming the engine and the code host if the command names gh, and 0 otherwise; a payload it cannot read or parse exits 3; the planned hook command keeps dipo's exit 0 and 2, and on any other status (dipo missing, crashed, or exit 3) a shell fallback greps the payload for a gh word and exits 2 for gh, 0 otherwise. Both sides decode backslash pairs left to right as the shell does (a backslash-newline is a continuation, an escaped backslash keeps its line break), drop quotes and backslashes, and ignore case; it errs toward refusing. The last review ran a differential fuzz of over 11,000 commands through sh and zsh with a fake gh: every command that ran gh was refused by both the fallback and the daemon. Advisories, not done: \\uXXXX escapes are not decoded (canonical JSON.stringify never uses them for printable letters; stated in a comment); the daemon and engine hold the reason and the gh-word pattern twice. Normal-path bypasses found here ($'gh', GH) moved to DIPO-242. Verify outside the sandbox: exit 0, 4201 tests; DIPO_TEST_CI=1 workers and daemon tests pass.
<!-- SECTION:NOTES:END -->
