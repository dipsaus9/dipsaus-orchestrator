---
id: DIPO-241
title: Decide whether the gh refusal of the Bash hook fails closed
status: To Do
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 18:35'
labels:
  - 'tier:S'
  - cutover
  - needs-info
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
Outcome: a gh call is never let through only because the Bash PreToolUse check failed to run, or that is a recorded, accepted limit.

Context: DIPO-195 (PR #281) dropped the Bash(gh) and Bash(gh *) deny rules when the hook relay is on, so the PreToolUse Bash check (packages/daemon/src/hook.ts runBash, gh-guard and the temp guard) is now the only barrier to a gh call. That hook is registered with no exit-2 fallback (packages/engine/src/workers/claude-cli/hooks.ts: "the Bash check fails open, so a broken check never blocks Bash"): if the check throws, the hook times out or the dipo binary cannot start, the call runs. Before DIPO-195 a fail-closed deny rule stopped gh. The gate hook (--gate, DIPO-164) already fails closed with exit 2 when it cannot print. The 0008 section 2 note of 2026-10-20 (DIPO-195) moves the refusal into the check but does not say the gh part now fails open. The sandbox still masks ~/.config/gh and GH_TOKEN.

```dipo
branch: "DIPO-241/gh-check-fails-closed"
unknowns:
  - q: "When the Bash check cannot run, should a command that names gh be refused? (a) yes: a second hook entry for the gh words (or the --bash call itself) exits 2 when the check throws or cannot start and the command text contains a gh word, so gh fails closed while every other Bash call still fails open; a dated 0008 section 2 note records it (recommended: the deny rule it replaced failed closed); (b) no: keep fail-open and record in a dated 0008 note that gh is then guarded only by the sandbox's credential masking."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) hook.test.ts: with the check made to throw, a command with a gh word gets the chosen answer ((a) exit 2 with a reason on stderr; (b) exit 0 and no output), and a command with no gh word exits 0 with no output"
    - kind: "automated"
      check: "(unit) hooks.test.ts: the planned PreToolUse Bash hook entry matches the chosen shape"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 As the unknown's answer picks, a Bash command that contains a gh word is refused with exit 2 and a reason on stderr when the Bash check throws or cannot print, or the fail-open stays and the hook comment in packages/engine/src/workers/claude-cli/hooks.ts says gh is then guarded only by the sandbox's credential masking
- [ ] #2 A Bash command with no gh word still fails open when the check throws: exit 0 and no output
- [ ] #3 packages/daemon/src/hook.test.ts and packages/engine/test/workers/hooks.test.ts cover the chosen behaviour
<!-- AC:END -->
