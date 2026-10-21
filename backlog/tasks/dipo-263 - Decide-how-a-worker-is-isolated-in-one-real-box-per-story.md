---
id: DIPO-263
title: Decide how a worker is isolated in one real box per story
status: Done
assignee: []
created_date: '2026-10-21 09:15'
updated_date: '2026-10-21 09:22'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - docs/decisions/0021-worker-isolation.md
  - docs/decisions/
priority: high
type: spike
ordinal: 252000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a decision record that defines the worker as a whole Claude Code session in its own real box (Apple container, one VM per story), what it does, what it can reach, and the messages it exchanges with dipo, replacing the Bash-only sandbox, the References write fence and the per-call guards.

Context: the security review and its audit of 2026-10-21 (N-1 and V-1 confirmed live), the dipo run research of 2026-10-20 and the maintainer interview of 2026-10-21.

```dipo
branch: "DIPO-263/worker-isolation-adr"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/decisions/0021-worker-isolation.md records the maintainer's interview decisions of 2026-10-21, the design, the amendments to 0001, 0008, 0010, 0012, 0014, 0019 and 0020, and the backlog impact
- [x] #2 Each amended ADR carries a dated amendment entry that points to 0021
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decision 0021 accepted by the maintainer on 2026-10-21 after the interview (log of 20 decisions in the ADR). Amendment entries added to 0001, 0008, 0010, 0012, 0014, 0019 and 0020. The security and architecture reviews and their audit stay local until N-1 and V-1 are closed (maintainer, 2026-10-21). Verify outside the sandbox: exit 0, 4241 tests.
<!-- SECTION:NOTES:END -->
