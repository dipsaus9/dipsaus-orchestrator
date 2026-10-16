---
id: DIPO-127
title: 'Cap function length, complexity and parameter count in lint'
status: Refined
assignee: []
created_date: '2026-10-16 13:06'
updated_date: '2026-10-16 14:17'
labels:
  - 'tier:S'
milestone: m-1
dependencies:
  - DIPO-113
references:
  - .oxlintrc.json
  - test/lint-boundaries
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
- [ ] #1 max-lines-per-function 100, complexity 20 and max-params 5 are on in .oxlintrc.json for packages/*/src (tests may be excluded or given looser limits, stated in the config)
- [ ] #2 Today's offending files are listed by path in one override block per rule, each exempt only from the rules it breaks, with a comment that the lists only shrink; bun run verify passes
- [ ] #3 A fixture in test/lint-boundaries/ proves each rule fires outside the exception lists
<!-- AC:END -->
