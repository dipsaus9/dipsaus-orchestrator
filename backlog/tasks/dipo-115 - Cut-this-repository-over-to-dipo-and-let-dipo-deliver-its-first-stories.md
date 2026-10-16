---
id: DIPO-115
title: Cut this repository over to dipo and let dipo deliver its first stories
status: Refined
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-10-16 14:16'
labels:
  - 'tier:M'
milestone: m-1
dependencies:
  - DIPO-108
  - DIPO-109
  - DIPO-114
  - DIPO-118
  - DIPO-130
references:
  - docs/plan.md
  - backlog/config.yml
  - packages/engine/src/office/init/
  - packages/engine/src/gate/
  - docs/decisions/0012-story-standard.md
  - backlog/tasks/
priority: high
type: chore
ordinal: 105000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: this repository is a dipo office, and dipo has delivered DIPO-105, DIPO-106 and DIPO-107 to In Review on it, so docs/plan.md step 4 (cutover) is done and M1 stories can be delivered by dipo itself.

Context: backlog/config.yml still has To Do, In Progress and Done, there is no .dipo/, and work.run refuses such a base. DIPO-58 onward were planned as built by dipo itself but were delivered by hand. 29 of the 31 stories from DIPO-77 on have no dipo field block, which the Ready gate needs (0012). dipo office init rewrites backlog/config.yml statuses, moves To Do stories to Refined and opens a backlog PR the merge slot auto-merges. Every live worker run on this repository needs the maintainer's approval first; they are not covered by the scratch repository approval. Found by both milestone reviews (TL;DR 1).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo office init has run on this repository with the maintainer present; its backlog PR merged and the new statuses and .dipo/.gitignore are on main. A .dipo/office.yaml is added in its own PR only when a setting the first runs need differs from the default.
- [ ] #2 DIPO-105, DIPO-106 and DIPO-107 carry dipo field blocks, pass dipo gate, and were set Ready by the maintainer.
- [ ] #3 dipo delivered each of the three to In Review on its own branch with verify green; the PRs were opened and merged by hand after the usual review, and the task notes record what dipo did and every place the maintainer had to step in.
- [ ] #4 Every problem found during the cutover is a story, or a dated note in the relevant ADR with the maintainer's approval.
<!-- AC:END -->
