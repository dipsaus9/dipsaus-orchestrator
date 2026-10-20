---
id: DIPO-243
title: Read a quoted keyword as a plain word in the Bash command splitter
status: Done
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 23:16'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/hooks/temp-guard.ts
  - packages/engine/test/hooks/temp-guard.test.ts
priority: low
type: bug
ordinal: 243000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: simpleCommands treats a quoted or escaped `if`, `fi`, `do`, `done`, `case`, `esac`, `{` or `}` as a plain word, as bash does, so a quoted keyword can no longer leave a stray group that hides a later refusal.

Context: advisory of the DIPO-237 review (PR #276). simpleCommands in packages/engine/src/hooks/temp-guard.ts strips quotes and backslashes before it sees a word, so `'if'` counts as an opening keyword and `'fi'` as a closer. Bash does not treat a quoted reserved word as one. Probed: `{ 'if' x; bash; } <<'EOF'` with a DIPO_TMP body passes, because a stray if group sits above the `{` group and the `}` closer does not match; `'if' true; then bash; fi` and `{ bash; 'fi'; }` are still refused. The gh check (gh-guard.ts) uses simpleCommands too. The refused and passed tables are in packages/engine/test/hooks/temp-guard.test.ts.

```dipo
branch: "DIPO-243/quoted-keywords-plain"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) temp-guard.test.ts refused row: { 'if' x; bash; } <<'EOF' with a DIPO_TMP body; passed rows: echo 'fi' and echo \\done"
    - kind: "automated"
      check: "(unit) every row of the refused and passed tables before keeps its result, and gh-guard.test.ts still passes"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 simpleCommands in packages/engine/src/hooks/temp-guard.ts records for each word whether any part of it was quoted or escaped, and a word with quoting never counts as an opening keyword, a closing `fi`, `done` or `esac`, or a `{` or `}` group word
- [x] #2 `{ 'if' x; bash; } <<'EOF'` with a here-doc body `export DIPO_TMP=/x` is refused, and `echo 'fi'` and `echo \done` pass
- [x] #3 Each case of the criterion before is a row in the refused or passed table of packages/engine/test/hooks/temp-guard.test.ts, every row there before keeps its result, and packages/engine/test/hooks/gh-guard.test.ts passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5DRQ8RZJJHC6FJKKV21246V (Haiku, 17 turns, about $0.02), verified and reviewed by dipo (its reviewer, Opus, approved round 1 with no findings), with no denied call and no write outside the References. The Bash command splitter (simpleCommands in hooks/temp-guard.ts, also used by gh-guard.ts) marks a word that held quoting or an escape, and such a word never opens or closes a compound or group: 'if', \\if, "done" and i'f' are plain words, as in bash. Independent review passed: a 40-command before-and-after comparison found only four lost refusals, all shell syntax errors no shell runs (such as 'if' true; then bash; fi), and eleven gained ones (quoted closers inside real compounds); no gh call inside a compound lost its refusal. Follow-ups: ANSI-C quoting ($'gh') is not decoded, so $'gh' pr merge runs gh unrefused (an existing gap, added to DIPO-242); a passed-table row could document why 'if' true; then bash; fi passes. Verify outside the sandbox: exit 0, 4210 tests; DIPO_TEST_CI=1 hooks tests pass (220).
<!-- SECTION:NOTES:END -->
