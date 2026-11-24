---
id: DIPO-511
title: Check a Ready story in pickup mode in the Queue preview
status: Done
assignee: []
created_date: '2026-11-16 14:31'
updated_date: '2026-11-24 07:52'
labels:
  - 'tier:S'
  - 'role:developer'
milestone: m-6
dependencies: []
references:
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/gate/rules.ts
  - packages/tui/src/queue.tsx
  - packages/engine/test/gate/story-gate.test.ts
  - packages/tui/src/queue.test.tsx
  - docs/decisions/0009-tui.md
modified_files:
  - docs/decisions/0009-tui.md
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/test/gate/gate.test.ts
  - packages/engine/test/gate/story-gate.ci.test.ts
  - packages/engine/test/gate/story-gate.test.ts
type: bug
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the Queue preview of a Ready story to show its gate as the pickup check sees it so that a Ready story never shows a false R01a failure and a real pickup failure shows before dipo picks it up.

The read story.gate always evaluates in ready mode (packages/engine/src/gate-decisions/feature.ts:324, checkReady at :132-133) and returns ruleCount("ready") (:330). R01a fails every story that is not Refined (packages/engine/src/gate/rules.ts:106), so the Queue preview (packages/tui/src/queue.tsx:258-264) shows a failed R01a for every Ready story. The pickup mode checks R01b, status Ready, instead (rules.ts:110; 0012 line 76).

- story.gate evaluates a Ready story in pickup mode and any other story in ready mode, and returns the rule count of the mode it used.
- It still stores nothing (feature.ts:9-10).
- The TUI is unchanged: it shows what the read returns.

## What it does not do
- Does not change what the pickup check inside work.run does or stores.
- Does not change the Queue's groups or reason column.

## ADR lines that change
- docs/decisions/0009-tui.md, The chain and the gate: "The Queue reads `story.gate` for the selected story: passed or not, the rule count, the failures and the files it touches." becomes: The Queue reads `story.gate` for the selected story, in pickup mode for a Ready story and ready mode otherwise (0012): passed or not, the rule count, the failures and the files it touches.

## Risks and choices
None.

```dipo
branch: "DIPO-511/check-ready-story-pickup-mode-queue"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "story.gate on a Ready story with a dependency not yet Done returns passed with its waiting-on list and no R01a failure"
    - kind: "automated"
      check: "story.gate on a Ready story with an empty Story line returns the failure of that rule and the pickup rule count"
    - kind: "automated"
      check: "story.gate on a Refined story returns the ready mode's result and rule count, as before"
    - kind: "automated"
      check: "No gate decision row is written by either read"
    - kind: "automated"
      check: "The Queue preview of a passing Ready story shows the gate met with its rule count"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 story.gate on a Ready story that passes the pickup check returns passed, and the Queue preview shows no R01a failure for it.
- [x] #2 story.gate on a Ready story returns the rule count of the pickup mode.
- [x] #3 story.gate on a Ready story that fails a pickup rule returns that rule's failure, and the Queue preview shows it.
- [x] #4 story.gate on a Refined story evaluates in ready mode and returns the same result as before.
- [x] #5 story.gate stores no gate decision in either mode.
- [x] #6 Decision 0009 says the Queue checks a Ready story in pickup mode and any other story in ready mode.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-24 07:52 UTC
- Criteria met: 6 of 6 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 66,294 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
