---
id: DIPO-261
title: >-
  Give the temp guard the gh check's wrapper parsing and case-insensitive
  program names
status: Refined
assignee: []
created_date: '2026-10-21 01:03'
updated_date: '2026-10-21 09:21'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-242
references:
  - packages/engine/src/hooks/temp-guard.ts
  - packages/engine/src/hooks/gh-guard.ts
  - packages/engine/test/hooks/temp-guard.test.ts
  - packages/engine/test/hooks/gh-guard.test.ts
priority: medium
type: enhancement
ordinal: 250000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the temp guard of the Bash hook refuses a guarded temp variable (DIPO_TMP, TMPDIR and the like) that is set through a wrapper it does not parse today, or through a program name in another letter case: `ENV DIPO_TMP=/x bun test`, `/usr/bin/Env DIPO_TMP=/x ls`, `Sudo DIPO_TMP=/x ls`, `timeout 5 env DIPO_TMP=/x ls` and `doas -u me env DIPO_TMP=/x ls` are refused.

Context: found while finishing DIPO-242 (PR #299). These commands passed before DIPO-242 too, so this is no regression. commandRefusal in packages/engine/src/hooks/temp-guard.ts has its own prefix words and handles only sudo and xargs as wrappers, and it compares program names case-sensitively. On a case-insensitive file system (the macOS default) `ENV` runs env. DIPO-242 gave packages/engine/src/hooks/gh-guard.ts a WRAPPERS option table (sudo, doas, timeout, stdbuf, nice, time, exec, command, builtin, nohup, setsid, busybox), read through wrapperOptions in temp-guard.ts, and a backstop for options the table does not know. The two guards should share that table.

```dipo
branch: "DIPO-261/temp-guard-wrappers"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 commandRefusal in packages/engine/src/hooks/temp-guard.ts compares a program's basename case-insensitively, so `ENV DIPO_TMP=/x bun test`, `/usr/bin/Env DIPO_TMP=/x ls` and `Sudo DIPO_TMP=/x ls` are refused
- [ ] #2 The wrapper table of packages/engine/src/hooks/gh-guard.ts is shared with the temp guard, and both guards use it, so `timeout 5 env DIPO_TMP=/x ls`, `doas -u me env DIPO_TMP=/x ls`, `nice -n 5 env TMPDIR=/x ls` and `stdbuf -oL env DIPO_TMP=/x ls` are refused
- [ ] #3 Each case above is a row in packages/engine/test/hooks/temp-guard.test.ts, and every row before in temp-guard.test.ts and gh-guard.test.ts keeps its result
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Replaced by decision 0021 (worker isolation, DIPO-263, 2026-10-21): there are no per-call Bash guards inside the box (0021 section 7).
<!-- SECTION:NOTES:END -->
