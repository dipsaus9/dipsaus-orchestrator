---
id: DIPO-409
title: Refuse a story whose References name a protected path before its run starts
status: Refined
assignee: []
created_date: '2026-10-31 10:18'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/parts.ts
  - packages/engine/src/run/
  - packages/cli/src/
priority: medium
type: bug
ordinal: 387000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo run` refuses a story that names files the box protects, at once and with the reason, instead of parking it after a whole worker session.

Gap G20, 2026-10-31: DIPO-405 listed `.dipo/office.yaml` in its References and asked in criterion 3 for an edit to it. dipo ran the story for about 20 minutes in a box, then parked it as a scope violation ("changes protected files: dipo's configuration (.dipo/)"), as it should; but it knew from the story's References before the run that the change could never be delivered. The protected paths are `PROTECTED_TEXT` and its path check in packages/engine/src/box/parts.ts. Reuse that check; never a second list (0001). 0008, 0010, 0012.

```dipo
branch: "DIPO-409/refuse-protected-references"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) work.run refuses, before any box or worker starts, a story whose References name a path the box protects"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `work.run` refuses a story whose References name a path the box's protected-path check protects (any kind in PROTECTED_TEXT, folded as that check folds), before it claims the story or starts a box or worker, with a refusal code and a message naming the path and its kind, and that a builder or the maintainer takes such a story
- [ ] #2 The refusal uses the same path check as the scope-violation park, shown by a test that a path the park would flag is refused and one it would not flag is not (for example `.dipo/office.yaml`, `.github/workflows/ci.yml`, a look-alike form, and `packages/engine/src/x.ts`)
- [ ] #3 A story whose References name only unprotected paths runs as before, and the scope-violation park after a run stays as it is
<!-- AC:END -->
