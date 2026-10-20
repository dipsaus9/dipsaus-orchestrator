---
id: DIPO-241
title: Decide whether the gh refusal of the Bash hook fails closed
status: Refined
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 18:50'
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
priority: medium
type: enhancement
ordinal: 241000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a gh call is never let through only because the Bash PreToolUse check failed to run: when the check throws or cannot start and the command text contains a gh word, the hook exits 2, while every other Bash call still fails open.

Context: DIPO-195 (PR #281) dropped the Bash(gh) and Bash(gh *) deny rules when the hook relay is on, so the PreToolUse Bash check (packages/daemon/src/hook.ts runBash, gh-guard and the temp guard) is now the only barrier to a gh call. That hook is registered with no exit-2 fallback (packages/engine/src/workers/claude-cli/hooks.ts: "the Bash check fails open, so a broken check never blocks Bash"): if the check throws, the hook times out or the dipo binary cannot start, the call runs. Before DIPO-195 a fail-closed deny rule stopped gh. The gate hook (--gate, DIPO-164) already fails closed with exit 2 when it cannot print. The 0008 section 2 note of 2026-10-20 (DIPO-195) moves the refusal into the check but does not say the gh part now fails open. The sandbox still masks ~/.config/gh and GH_TOKEN.

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
- [ ] #1 When `dipo hook PreToolUse --bash` throws while it checks a command whose text contains a gh word (a word whose basename is gh), it prints nothing on stdout, writes a reason naming the engine and the code host on stderr and exits 2, so the call does not run
- [ ] #2 The Bash hook entry planned in packages/engine/src/workers/claude-cli/hooks.ts has a fallback for a dipo that cannot start or crashes: it exits 2 when the hook payload's command contains a gh word and exits 0 otherwise, and its comment says the gh part fails closed while the rest fails open
- [ ] #3 A Bash command with no gh word still fails open when the check throws or cannot start: exit 0 and no output
- [ ] #4 packages/daemon/src/hook.test.ts covers a throwing check with and without a gh word, and packages/engine/test/workers/hooks.test.ts covers the planned entry and its fallback
<!-- AC:END -->
