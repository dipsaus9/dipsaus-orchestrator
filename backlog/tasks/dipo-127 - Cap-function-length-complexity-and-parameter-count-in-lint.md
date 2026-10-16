---
id: DIPO-127
title: 'Cap function length, complexity and parameter count in lint'
status: To Do
assignee: []
created_date: '2026-10-16 13:06'
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
Outcome: new code cannot add functions over 100 lines, over complexity 20 or with more than 5 parameters, while today's offenders are listed by name until they are split.

Context: .oxlintrc.json has no max-lines-per-function, complexity or max-params rule. At these limits the 2026-10-16 milestone review counted 41, 46 and 18 functions over them (section 1c). bun run lint is oxlint --deny-warnings, so a warn level fails verify too: today's offending files need an overrides block that switches the rules off for them. DIPO-113 edits the same file. Found by the 2026-10-16 milestone review, section 1c.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 max-lines-per-function 100, complexity 20 and max-params 5 are on in .oxlintrc.json for packages/*/src (tests may be excluded or given looser limits, stated in the config)
- [ ] #2 Today's offending files are listed by path in one overrides block with a comment that the list only shrinks; bun run verify passes
- [ ] #3 A fixture in test/lint-boundaries/ proves each rule fires outside the exception list
<!-- AC:END -->
