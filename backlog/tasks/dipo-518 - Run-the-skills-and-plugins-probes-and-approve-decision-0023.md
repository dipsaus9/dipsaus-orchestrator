---
id: DIPO-518
title: Run the skills and plugins probes and approve decision 0023
status: Ready
assignee: []
created_date: '2026-11-26 14:50'
updated_date: '2026-11-27 14:53'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-4
dependencies:
  - DIPO-519
references:
  - docs/decisions/0023-skills-and-plugins.md
  - tools/box-probe/probe.sh
  - packages/engine/src/workers/claude-cli/skills.ts
  - packages/engine/src/workers/claude-cli/plugins.ts
  - packages/engine/src/workers/claude-cli/box-plan.ts
type: spike
ordinal: 479000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: We need to decide whether the skills and plugins grant proposed in decision 0023 holds in every kind of session when measured by live probes so that the implementation stories rest on measured behaviour and not on documentation.

Split off DIPO-116 on 2026-11-26. The maintainer or a builder takes this story, not a dipo worker: its probes need a developer box, a read-only reviewer or planning box and the scan session on the Mac, which a worker in a box cannot start. The roster has only the developer role, so the role label is developer; park it by hand when it is filed, as DIPO-514 is.

Steps:
- Run P1, P2 and P3 from the Probes section of docs/decisions/0023-skills-and-plugins.md on the scratch repository, as written there.
- Record each in 0023: the date, the Claude Code version, the commands run and the outcome against the expected result.
- Where an outcome contradicts a recommendation in 0023, rewrite that answer and say why. Clear every unmeasured mark the probes settle.
- The maintainer approves the wording, and 0023's status becomes accepted.
- File the implementation stories for the decision in milestone m-4 through a planning session. Those stories change 0008, 0017, 0014 and 0001 in the PRs that change the code.

## What it does not do
- Does not change any code or any decision but 0023
- Does not build the grant; the implementation stories do

## ADR lines that change
- docs/decisions/0023-skills-and-plugins.md, Status: new line: Status: accepted on the date of the maintainer's approval, with the probes P1 to P3 recorded.

## Risks and choices
- other: Its role is developer only because the roster has no other; once DIPO-116 is Done, dipo may start it in a box by itself (DIPO-499), so park it by hand when filed.
- spend: The probes run live claude -p sessions on your subscription, outside dipo's caps.

```dipo
branch: "DIPO-518/run-skills-plugins-probes-approve"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A recorded probe in docs/decisions/0023-skills-and-plugins.md shows a granted skill and a granted plugin loading and usable in a claude -p session in a developer box, and an ungranted one not loading
- [ ] #2 A recorded probe in 0023 shows a granted skill loading in a read-only reviewer or planning box while the plan check still refuses every flag the grant does not need
- [ ] #3 A recorded probe in 0023 shows that a granted skill or plugin cannot run a command on the Mac outside the guard 0023 names for the scan session
- [ ] #4 No claim in 0023 is still marked unmeasured, and the maintainer's approval of 0023 is recorded with its date
- [ ] #5 Implementation stories for decision 0023 are filed in milestone m-4
<!-- AC:END -->
