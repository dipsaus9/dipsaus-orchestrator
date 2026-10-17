---
id: DIPO-115
title: Cut this repository over to dipo and let dipo deliver its first stories
status: Done
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-10-17 20:14'
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
  - .dipo/
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
- [x] #1 dipo office init has run on this repository with the maintainer present; its backlog PR merged and the new statuses and .dipo/.gitignore are on main. A .dipo/office.yaml is added in its own PR only when a setting the first runs need differs from the default.
- [x] #2 DIPO-105, DIPO-106 and DIPO-107 carry dipo field blocks, pass dipo gate, and were set Ready by the maintainer.
- [x] #3 dipo delivered each of the three to In Review on its own branch with verify green; the PRs were opened and merged by hand after the usual review, and the task notes record what dipo did and every place the maintainer had to step in.
- [x] #4 Every problem found during the cutover is a story, or a dated note in the relevant ADR with the maintainer's approval.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Closed 2026-10-17 by the maintainer, with the caveat on criterion 3 below.

What dipo did: dipo office init ran on this repository (office off_01M52H51ECE4R4WTMYFCRTHSB8, temp state under /tmp/dpo-cut), its backlog PR #153 merged as ba9ad45 and moved 15 To Do stories to Refined; .dipo/office.yaml adds ~/.nvm/versions/node to sandbox.toolchainReadPaths (#159) because oxfmt and oxlint run on node. DIPO-105, 106 and 107 got field blocks (#151, #154 reworded a criterion the R10 rule misread) and were set Ready (#157). dipo delivered DIPO-106 (32 turns, about $0.05) and DIPO-107 (34 turns, about $0.05) to In Review on their own branches with dipo's verify green.

Where the maintainer stepped in: DIPO-105's first run parked budget-exceeded after 61 turns (60-turn cap, about $0.78) because node was not readable in the worker sandbox, so verify could never pass; its source was sound and it was finished by hand in #160. So criterion 3 holds for DIPO-106 and 107 and not strictly for DIPO-105; the maintainer accepted that. Every PR (#160, #162, #163) was opened, reviewed and merged by hand from a separate branch on top of dipo's; dipo's own branches, worktrees and claims for DIPO-105, 106 and 107 remain (its Done poll only watches its own branch, DIPO-162). Inside the worker sandbox 10 tests failed that pass outside (fixed in DIPO-176, #175).

Every cutover problem is a story or an approved ADR note: stories DIPO-170 to DIPO-185 (#166, with the first M1a run's gaps), DIPO-135 to 137 (#161), the planned M1a stories for resume, discard and done-elsewhere release, and dated notes in 0007 and 0017 (#161) and 0007 and 0008 (#173). After the cutover dipo delivered M1 stories DIPO-123 (#167) and DIPO-126 (#169); DIPO-129 (#171) and DIPO-176 (#175) parked on sandbox limits and were finished by hand.
<!-- SECTION:NOTES:END -->
