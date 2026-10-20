---
id: DIPO-243
title: Read a quoted keyword as a plain word in the Bash command splitter
status: In Review
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 23:04'
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
