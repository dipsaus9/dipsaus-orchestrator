---
id: DIPO-132
title: Decide how parked stories resume and how the maintainer steers work
status: Done
assignee: []
created_date: '2026-10-16 14:39'
updated_date: '2026-10-17 12:54'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies: []
references:
  - docs/decisions/0020-park-and-resume.md
  - docs/decisions/
priority: high
type: spike
ordinal: 122000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an approved ADR, docs/decisions/0020-park-and-resume.md, decides how every parked story gets going again and how the maintainer steers work, so dipo resume works for each park reason and a plain-text dipo desk shows what needs the maintainer.

Context: M1a, the first slice of M1 (maintainer decision 2026-10-16). M0 resumes only needs-permission parks and plan-limit holds. story.hold, story.drop, work.discard, work.steer, work.pause, work.reassign, gate.approve and gate.reject exist in the contract as provisional and unregistered (packages/contract/src/office.ts). The answer-before-park wait for worker questions is deferred to M1 (packages/engine/src/run/control.ts). Context packs are written by recordContextPack (packages/engine/src/context/pack.ts) and worker notes by recordWorkerNotes (packages/engine/src/prompts/notes.ts); neither is called in production, and the handoff a resumed story gets depends on them. New M1 commands inherit the async command path the code already uses, which 0005 does not describe yet. Found by the 2026-10-16 milestone review (docs/reviews/, not committed) and 0005, 0008 section 6, 0010 section 2a and 0014.

Already decided by the maintainer (2026-10-16), to record in the ADR:
- budget-exceeded: resume only with an explicit top-up (dipo resume <id> --budget +50% or a fixed token amount), recorded as a fact with who and why, resuming the same session; a plain resume is refused for this reason with a message naming the option; never topped up silently.

Questions the ADR answers:
- The resume matrix for all 11 park reasons: target state, new session or --resume, first message (note, answer, feedback), and the loop or round count after resume.
- Whether resume needs a note, and how it reaches the worker (0014 L5 template).
- The handoff for a new session: which context pack and worker notes are written, when and by whom, and what a resumed or restarted story reads.
- The answer-before-park wait for worker questions.
- hold, drop and discard (lane b, 0010 section 2a), steer and pause (0008 section 6), and their CLI confirmations.
- What hold, drop and discard do to an open story PR and its branch.
- The plain-text dipo desk: what it lists (parks, questions, review-blocked, conflicts, merges waiting on the maintainer), in which order, and its CLI form.
- The structured summary written back to the story on park and close (0001).
- Any ParkReason or SkipReason additions, and a dated 0005 note on the async command path.
- How a worker asks for more than its story gives (maintainer, 2026-10-16): (a) extra write paths as a scope request, granted by code when small and collision-free, else on dipo desk; (b) more input or research, for example on architecture; (c) improvements beyond the story, filed as proposed follow-up stories; which code decides, which wait for the maintainer, and how each shows on dipo desk.

```dipo
branch: "DIPO-132/park-and-resume"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/decisions/0020-park-and-resume.md answers each question in the description, with the options weighed and a decision for each
- [x] #2 The maintainer decision of 2026-10-16 on budget-exceeded resume is recorded in the ADR as decided, and a dated note on 0005's async command path is proposed for approval
- [x] #3 Maintainer approved the decision
- [x] #4 Implementation stories for the decision are filed in m-1 with the label slice:m1a
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
ADR docs/decisions/0020-park-and-resume.md accepted by the maintainer on 2026-10-17, with amendment notes in 0005 (including the waiting command path), 0007, 0008, 0009, 0010, 0012 and 0014. Implementation stories filed in m-1 with slice:m1a: DIPO-138 (1), DIPO-143 (2), DIPO-154 (3), DIPO-155 (4), DIPO-156 (5), DIPO-157 (6), DIPO-159 (7), DIPO-160 (8), DIPO-161 (9), DIPO-162 (10), DIPO-163 (11), DIPO-158 (12), DIPO-165 (13), DIPO-166 (14), DIPO-167 (15), DIPO-168 (16), DIPO-164 (17). Follow-up DIPO-169 (18, Refine worker research access) is filed in m-1 without a slice label; the maintainer sets its slice.
<!-- SECTION:FINAL_SUMMARY:END -->
