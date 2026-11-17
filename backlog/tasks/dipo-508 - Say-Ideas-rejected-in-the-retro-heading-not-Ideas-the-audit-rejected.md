---
id: DIPO-508
title: 'Say Ideas rejected in the retro, not Ideas the audit rejected'
status: Done
assignee: []
created_date: '2026-11-10 14:23'
updated_date: '2026-11-17 15:05'
labels:
  - 'tier:S'
  - 'role:developer'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/records/retro.ts
  - packages/engine/test/records/retro.test.ts
  - packages/tui/src/retro.test.tsx
  - docs/decisions/0022-planning-sessions.md
modified_files:
  - docs/decisions/0022-planning-sessions.md
  - packages/engine/src/records/retro.ts
  - packages/engine/test/records/retro.test.ts
  - packages/tui/src/retro.test.tsx
type: bug
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the retro line on rejected ideas to say Ideas rejected so that it does not claim the audit rejected the ideas a code check turned down.

The retro writes the heading `Ideas the audit rejected: ${total}` (packages/engine/src/records/retro.ts:256), but the total counts every idea in state rejected (retro.ts:203), including the ones the code check rejected before any audit (0022 section 3, Code first). Each reason line already says which one rejected it. The old text is pinned by packages/engine/test/records/retro.test.ts:210 and packages/tui/src/retro.test.tsx:25.

- The heading becomes `Ideas rejected: ${total}`; the count and the reason lines are unchanged.
- Decision 0022 section 4 names the rejected ideas, by code or by the audit.

## What it does not do
- Does not split the count into code and audit totals.
- Does not change the Retro room's layout; that is DRAFT-21.

## ADR lines that change
- docs/decisions/0022-planning-sessions.md, 4. Retro: "and the ideas the audit rejected, with their reasons" becomes: and the ideas rejected, by code or by the audit, with their reasons

## Risks and choices
None.

```dipo
branch: "DIPO-508/say-ideas-rejected-retro-not-ideas-audit"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "A retro over one code-rejected and two audit-rejected ideas holds the line Ideas rejected: 3 and one reason line per reason"
    - kind: "automated"
      check: "The TUI Retro room renders the line Ideas rejected: 3 from the retro read"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The retro's heading line for rejected ideas reads Ideas rejected: N, where N counts every rejected idea, by code and by the audit.
- [x] #2 Each reason line under the heading still says which one, the code check or the audit, rejected it.
- [x] #3 No source or test file under packages holds the text Ideas the audit rejected.
- [x] #4 Decision 0022 section 4 says the retro shows the ideas rejected by code or by the audit, with their reasons.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-17 15:05 UTC
- Criteria met: 4 of 4 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 20,516 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
