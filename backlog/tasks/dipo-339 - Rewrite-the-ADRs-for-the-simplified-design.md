---
id: DIPO-339
title: Rewrite the ADRs for the simplified design
status: Done
assignee: []
created_date: '2026-10-24 16:42'
updated_date: '2026-10-24 16:43'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - docs/decisions/
  - docs/vision.md
  - docs/concepts.md
  - CLAUDE.md
  - docs/research/2026-10-24-simplification-audit.md
type: docs
ordinal: 319000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every ADR describes the simplified design that dipo is pruned toward, without amendment logs, so a reader learns what holds from one document.

From the simplification audit of 2026-10-24 (docs/research/2026-10-24-simplification-audit.md): the maintainer and Claude decided the target in questions 1 to 9 and 14 proposals, then rewrote the ADRs in place and merged overlapping ones (0006 into 0005, 0011 and 0015 into 0001, 0019 into 0002, 0021 into 0008). vision.md, concepts.md and the ADR citations in CLAUDE.md follow. Code is not changed here; the prune plan comes next.

```dipo
branch: "DIPO-339/rewrite-adrs-simplified-design"
unknowns: []
test_plan:
  not_applicable: "Documentation only; no code or behaviour changes in this story."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every ADR in docs/decisions/ describes the current decision with a short Replaced list and no amendment log
- [x] #2 0006, 0011, 0015, 0019 and 0021 are one-line pointers to the ADR that absorbed them
- [x] #3 docs/vision.md, docs/concepts.md and CLAUDE.md use the vocabulary of the rewritten ADRs and cite ADRs by number only
- [x] #4 docs/research/2026-10-24-simplification-audit.md records every maintainer answer and every derived choice
<!-- AC:END -->
