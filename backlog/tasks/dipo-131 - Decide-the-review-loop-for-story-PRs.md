---
id: DIPO-131
title: Decide the review loop for story PRs
status: Refined
assignee: []
created_date: '2026-10-16 14:39'
updated_date: '2026-10-16 14:48'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies: []
references:
  - docs/decisions/0019-review-loop.md
  - docs/decisions/
priority: high
type: spike
ordinal: 121000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an approved ADR, docs/decisions/0019-review-loop.md, decides how dipo takes a delivered story from In Review to merged without the maintainer: it opens the story PR, a reviewer session reviews it, CI, review and conflict feedback go back to the worker, and an approved PR merges through the merge slot.

Context: M1a, the first slice of M1 (maintainer decision 2026-10-16). M0 stops at In Review with the branch pushed; 0010 section 7 says "The PR opens in M1". A review run kind and a review-round column exist but nothing writes them; the Verdict type carries only the ready and pickup gate decisions (packages/engine/src/views/feature.ts), so no review verdict is written yet; GhHost.createPr is used for backlog PRs only (packages/engine/src/platform/host.ts); the merge slot's checks are hard-coded (packages/engine/src/merge-slot/checks.ts). Found by the 2026-10-16 milestone review (docs/reviews/, not committed) and 0010 section 7.

Already decided by the maintainer (2026-10-16), to record in the ADR:
- Merge authority: dipo merges a story PR by itself after reviewer approval and green CI, through the merge slot; an office setting switches auto-merge off; a story flagged test-before-merge (0002, 0012) always waits for the maintainer; never a PR labelled autorelease: pending, never a deployment approval.
- Reviewer defaults: a review block in .dipo/office.yaml, default Opus, effort high, at most 3 review rounds per story; after round 3 fails the story parks review-blocked (shown on dipo desk); the reviewer is read-only; its cost counts toward the story's budget.
- Conflicts: checked before In Review and before each merge; when main moved, a plain merge of main into the branch, never rebase or force-push; on conflict the worker gets the conflicting files as feedback, resolves them in the same session, runs verify and goes back to review; after 2 failed attempts the story parks conflict (shown on dipo desk).

Questions the ADR answers:
- When the story PR opens and what its title and body carry (from code: outcome, criteria, test plan); draft or ready.
- The reviewer report schema: verdict, per-criterion met with evidence, findings with blocking or advisory, file:line and quoted line; how scope findings relate to the engine's own scope check.
- The reviewer's tools, sandbox and hygiene (DIPO-108 plugins, DIPO-130 skills), budget and turn cap, and failure handling (crash, cap, invalid report).
- What counts as a review round; review keyed on the commit; when re-review is skipped.
- Send-once feedback: signature inputs per source, storage, attempt budget, same-failure.
- CI feedback: which runs and logs, size caps, polling cost, auth through the engine's gh.
- Per-office required check names and the autorelease: pending guard.
- Where verdicts show: story.detail, the TUI, dipo desk, gate events.
- Which contract commands and events this adds.
- How the maintainer releases or rejects a merge that waits for them (auto-merge switched off, or a story flagged test-before-merge while the test-story command is M1b): the contract command (gate.approve and gate.reject, or a hand merge on GitHub picked up by the Done poll), its CLI form, the merge gate's waitingOn, its events, and the dipo desk action.
- Building-time sync for riskier stories (tier L or flagged), with a dated 0010 note confirming or amending the DIPO-49 deferral of the conflict check.
- Whether a conflict fix counts as a loop or a review round.
- How review runs count for capacity and plan-limit holds.

```dipo
branch: "DIPO-131/review-loop"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 docs/decisions/0019-review-loop.md answers each question in the description, with the options weighed and a decision for each
- [ ] #2 The maintainer decisions of 2026-10-16 on merge authority, reviewer defaults and conflicts are recorded in the ADR as decided
- [ ] #3 Maintainer approved the decision
- [ ] #4 Implementation stories for the decision are filed in m-1 with the label slice:m1a
<!-- AC:END -->
