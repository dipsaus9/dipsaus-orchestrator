---
id: DIPO-497
title: Ending a planning session lists the stories that stayed Refined
status: In Progress
assignee: []
created_date: '2026-11-13 09:28'
updated_date: '2026-11-13 13:02'
labels:
  - 'tier:S'
milestone: m-3
dependencies:
  - DIPO-495
references:
  - packages/tui/src/planning.tsx
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/keys.ts
  - packages/contract/src/office.ts
  - packages/contract/src/work.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/test/run/planning-ready.test.ts
  - docs/decisions/0009-tui.md
priority: high
type: feature
ordinal: 468000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want ending a planning session to end it and tell me which of its stories stayed Refined and why, instead of opening a Ready step, so that I have one way to make a planned story Ready, the confirm, and know what is left.

M3 (0022), the second half of the maintainer's "Confirm = Ready" decision (2026-11-13). DIPO-495 files a confirmed story Ready when the gate passes; after it, the end-of-session Ready step has nothing left to do for the stories a confirm filed, and keeping it would be a second way to the same thing (0001).

On main: `/end` opens the Ready step (packages/tui/src/planning.tsx:25-29, `END_COMMAND` :299), which lists the session's filed and edited stories not yet Ready, all ticked, and `Y` sends `planning.ready` and then `planning.end`. `planning.ready` (contract packages/contract/src/office.ts:571-590, engine `ready` in packages/engine/src/run/planning-session.ts:855-920) calls `readyStories` for the session's own stories, and the view carries `ready` (`PlanningReadyView`, packages/contract/src/work.ts:759-767). The footer keys of the step live in packages/tui/src/keys.ts.

The fix:
- `/end` then Enter asks to end; on a yes it sends `planning.end` and shows each story the session filed or edited that stayed Refined, with the gate's first message and how to set it Ready later (`space` and `Y` in the Queue, or `dipo ready <ID>`). With none it just ends.
- `planning.ready`, the view's `ready` field and `PlanningReadyView`, the Ready step's keys and their footer entries are removed. `readyStories` stays for `story.ready`.

Replaces: the `/end` Ready step and `planning.ready` (DIPO-451, DIPO-487).

Needs DIPO-495: before it, the Ready step is the only way a planned story gets Ready from the session.

Not a guard: it removes a second path to Ready and adds no rule; who may set Ready is unchanged (R30 does not apply).

ADR 0009 section 3, the **Planning** line (line 50): "`/end` opens the Ready step: ..." becomes: `/end` ends the session after a yes and lists the stories that stayed Refined with why. One Replaced line: the Ready step on `/end` (2026-11-13). ADR 0022 needs no further line: DIPO-495 rewrites its Ready line.

Tier S: one TUI step replaced by a list, one command and one view field removed.

```dipo
branch: "DIPO-497/end-lists-refined-stories"
unknowns:
  - q: "May the ADR 0009 change go in as proposed: the Planning line in section 3. Views describes /end as ending the session with the list of stories that stayed Refined, and one Replaced line dated 2026-11-13 records the Ready step on /end as replaced (DIPO-497)?"
    status: "resolved"
    answer: "Yes, as proposed."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, planning.test) /end then Enter asks to end; y sends planning.end and shows the session's stories that stayed Refined with the gate's first message and how to set them Ready; with none it only ends"
    - kind: "automated"
      check: "(unit) planning.ready is no registered command, the planning view has no ready field, and the footer lists no Ready step key"
    - kind: "automated"
      check: "(unit) story.ready still sets a Refined story Ready through readyStories"
    - kind: "manual"
      check: "On the scratch repository, in a planning session confirm one story that passes and one that lacks a test plan, then type /end and answer y"
      expect: "The session ends and lists the second story as Refined with the reason and how to set it Ready; no Ready step opens"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 /end then Enter asks to end; on a yes it ends the session and lists each story the session filed or edited that stayed Refined, with the gate's first message and how to set it Ready later
- [ ] #2 planning.ready, the view's ready field and PlanningReadyView, the Ready step and its footer keys are removed
- [ ] #3 story.ready still sets a Refined story Ready through readyStories
- [ ] #4 ADR 0009's Planning line describes /end without the Ready step, with one Replaced line
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-13 12:43 UTC: budget-exceeded
- Detail: no part handed; turn cap (--max-turns) after 91 turns
- Run: run_01M7AENFG02Q9Q7CWQANPG0JER
- Criteria met: 0 of 4 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 200,786 of 300,000 tokens; 91 of 90 turns; 5 of 45 minutes
- Last good commit: e70969b10fc8ed5f22705f1e88565478bafb1c36

Resumed 2026-11-13 12:46 UTC; grants: budget +150,000 tokens, +45 turns, +23 minutes; note: Turn cap at 91 turns with no part handed: removing planning.ready, PlanningReadyView and the /end Ready step spans engine, contract and TUI, more than tier S. Resume with +50%.

Parked 2026-11-13 12:49 UTC: ambiguous-spec
- Detail: May the ADR 0009 change go in as proposed: the Planning line in section 3. Views describes /end as ending the session with the list of stories that stayed Refined, and one Replaced line dated 2026-11…
- Run: run_01M7AENFG02Q9Q7CWQANPG0JER
- Criteria met: 3 of 4 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 273,121 of 450,000 tokens; 131 of 135 turns; 8 of 68 minutes
- Last good commit: d038755350a6ac11fca819a6c0daab0023fc5cf9

Resumed 2026-11-13 13:01 UTC; grants: none; note: Yes, as proposed.

Parked 2026-11-13 13:01 UTC: budget-exceeded
- Detail: turn cap (--max-turns) after 5 turns
- Run: run_01M7AENFG02Q9Q7CWQANPG0JER
- Criteria met: 3 of 4 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 307,331 of 450,000 tokens; 136 of 135 turns; 8 of 68 minutes
- Last good commit: 48432c5033e75b42dfb59b3cb71cbe6cd47e3116

Resumed 2026-11-13 13:02 UTC; grants: budget +300,000 tokens, +90 turns, +45 minutes; note: Continue
<!-- SECTION:NOTES:END -->
