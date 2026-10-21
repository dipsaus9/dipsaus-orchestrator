---
id: DIPO-155
title: Resume a parked story with dipo resume
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-21 09:20'
labels:
  - 'tier:M'
  - 'slice:m1a'
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-138
  - DIPO-143
  - DIPO-154
  - DIPO-142
  - DIPO-144
references:
  - packages/contract/src/
  - packages/contract/schema/
  - packages/engine/src/run/
  - packages/engine/src/prompts/feedback/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/
  - packages/cli/src/
  - packages/engine/test/run/
  - packages/engine/test/db/
priority: high
type: feature
ordinal: 144000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo resume <id> [--note] resumes the park rows that need no grant and no review loop (stopped by the maintainer, interrupted, developer worker-failed, verify refused, scope paths, backstop and hand change with a new snapshot), refuses tampered git links, and applies required notes and note templates, storing each resume note on the park; a resume whose place is taken is queued.

Context: implements ADR 0020 section 1 (the resume path), the matching rows of the section 2 matrix with its rules for every row, section 3 (notes and how they reach the worker), and the work.resume and parks changes of sections 14 to 16. Today every park except needs-permission answers work.resume with story.notPausedOrParked (0020 fact 2). The policy reads parks.cause, which DIPO-142 adds.

```dipo
branch: "DIPO-155/dipo-resume-for-parked-stories"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) each resumed row returns to its park.from with the matrix's first message and session choice"
    - kind: "automated"
      check: "(unit) tampered answers resume.notResumable and a missing required note answers resume.noteRequired"
    - kind: "automated"
      check: "(unit) a resume with the worker place taken is queued and starts when the place frees"
    - kind: "automated"
      check: "(unit, cli) dipo resume sends work.resume with the note and prints the queued reply"
    - kind: "automated"
      check: "(migration) parks.resolved_note exists and holds the note after a resume"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 parks gains resolved_note through a migration, and a resume writes the maintainer's note on the park it resolves
- [ ] #2 work.resume follows the section 1 path (checks without writes, intent first, lift on the branch, one transaction, next session of the same run) for stopped/maintainer, interrupted, worker-failed of a developer session, verify-failing/refused and scope-violation/paths
- [ ] #3 scope-violation/backstop and hand-change resume with a note after the git-link check, take a new backstop snapshot and start a handoff session; scope-violation/tampered answers resume.notResumable naming dipo discard
- [ ] #4 A required note that is missing answers resume.noteRequired, and worker-failed is refused while the adapter hold that caused it is set, naming the hold
- [ ] #5 The first message is the reason's delta followed by feedback/maintainer-note.md built from L5 templates, so maintainer text never starts a message
- [ ] #6 A resume whose place is taken is accepted with its intent stored and the reply says queued; dipo resume <id> [--note <text>] exists, and the contract carries the queued result of work.resume and the resume.* errors used here
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: park and resume keep the story's box (0021 section 6).
<!-- SECTION:NOTES:END -->
