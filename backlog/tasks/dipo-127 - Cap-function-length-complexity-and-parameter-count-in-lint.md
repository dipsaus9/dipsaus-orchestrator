---
id: DIPO-127
title: 'Cap function length, complexity and parameter count in lint'
status: Done
assignee: []
created_date: '2026-10-16 13:06'
updated_date: '2026-10-23 17:10'
labels:
  - 'tier:S'
milestone: m-1
dependencies:
  - DIPO-113
references:
  - '- .oxlintrc.json'
  - .oxlintrc.json
  - test/lint-boundaries
  - test/lint-boundaries/fixtures/complex-function-at-cap.ts
  - test/lint-boundaries/fixtures/complex-function.ts
  - test/lint-boundaries/fixtures/long-function-at-cap.ts
  - test/lint-boundaries/fixtures/long-function.ts
  - test/lint-boundaries/fixtures/many-params-at-cap.ts
  - test/lint-boundaries/fixtures/many-params.ts
  - test/lint-boundaries/lint-function-caps.test.ts
priority: medium
type: chore
ordinal: 117000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: new code cannot add functions over 100 lines, over complexity 20 or with more than 5 parameters, outside a listed set of files that only shrinks as they are split.

Context: .oxlintrc.json has no max-lines-per-function, complexity or max-params rule. At these limits the 2026-10-16 milestone review counted 41, 46 and 18 functions over them (section 1c). bun run lint is oxlint --deny-warnings, so a warn level fails verify too: today's offending files need overrides that switch the rules off for them. Per-rule override blocks keep a file exempt only from the rules it breaks. DIPO-113 edited the same file. DIPO-128 and DIPO-129 split the run code later and keep the list from growing. Found by the 2026-10-16 milestone review, section 1c.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 max-lines-per-function 100, complexity 20 and max-params 5 are on in .oxlintrc.json for packages/*/src (tests may be excluded or given looser limits, stated in the config)
- [x] #2 Today's offending files are listed by path in one override block per rule, each exempt only from the rules it breaks, with a comment that the lists only shrink; bun run verify passes
- [x] #3 A fixture in test/lint-boundaries/ proves each rule fires outside the exception lists
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (all 3 criteria met). The maintainer chose the light version: caps on with exception lists that only shrink, no refactoring. Lists regenerated against main at merge time: max-lines-per-function 57 files, complexity 62, max-params 29. Review advisories for a follow-up: assert no other override turns a cap off, own-line comments only in .oxlintrc.json, detect a stale list entry, test the *.test.tsx exclusion.
<!-- SECTION:NOTES:END -->
