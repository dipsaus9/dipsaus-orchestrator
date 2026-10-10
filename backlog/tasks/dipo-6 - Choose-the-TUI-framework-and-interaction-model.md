---
id: DIPO-6
title: Choose the TUI framework and interaction model
status: To Do
assignee: []
created_date: '2026-10-09 19:17'
updated_date: '2026-10-10 10:16'
labels:
  - architecture
milestone: m-0
dependencies:
  - DIPO-1
priority: high
type: spike
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR choosing the TUI technology (constrained by DIPO-1) and defining the manager's overview of one office, plus switching between offices. The overview must answer at any moment: who is working on what (agent, role, story, phase); how it is going (progress against acceptance criteria, loops, verify results, reviewer verdicts, trouble signs such as repeated failures or a stalled agent); what needs to be done (queue by lifecycle state, Ready, blocked and why, waiting for the maintainer); and whether it is cost efficient (usage per story, role and tier against budget, trends). The maintainer must be able to step into running work from the TUI (answer, steer, pause, resume, reassign, stop) and see the parked triage list and testing checklist. The TUI is a thin client on the command and event model (DIPO-2). Include how a web or desktop client could follow. See docs/vision.md section 8 and docs/decisions/0011-office-model.md item 10.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0009-tui.md records options, choice and why
- [ ] #2 ADR sketches the views: office switcher, office overview (who, what, health, cost), live agent detail, queue, parked triage, testing checklist
- [ ] #3 ADR maps every intervention (answer, steer, pause, resume, reassign, stop) to a command from DIPO-2
- [ ] #4 ADR confirms the TUI uses only the public command and event interface
- [ ] #5 Maintainer approved the decision
- [ ] #6 Every overview value carries an evidence label (for example reported, observed, inferred, unknown; final names chosen in this ADR) (research idea 2)
- [ ] #7 ADR defines a fixed set of health states derived from facts and timeouts (research idea 9)
- [ ] #8 Overview, triage list and digests are built by code from facts, with no model call (research idea 20)
<!-- AC:END -->
