---
id: DIPO-155
title: 'Resume every parked story, top up a budget, and clear stale park records'
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-22 18:15'
labels:
  - 'tier:M'
  - 'slice:m1a'
  - needs-refinement
  - cutover
milestone: m-1
dependencies:
  - DIPO-138
  - DIPO-143
  - DIPO-154
  - DIPO-142
  - DIPO-144
  - DIPO-284
  - DIPO-290
  - DIPO-149
  - DIPO-292
  - DIPO-294
  - DIPO-299
  - DIPO-152
  - DIPO-219
  - DIPO-205
  - DIPO-148
  - DIPO-281
  - DIPO-150
  - DIPO-160
  - DIPO-163
references:
  - docs/decisions/
  - packages/cli/src/
  - packages/contract/schema/
  - packages/contract/src/
  - packages/engine/src/backlog/fields/
  - packages/engine/src/commands/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/merge-slot/
  - packages/engine/src/prompts/feedback/
  - packages/engine/src/reads/describe.ts
  - packages/engine/src/reconcile/reconcile.ts
  - packages/engine/src/retention/
  - packages/engine/src/run/
  - packages/engine/src/story-pr/
  - packages/engine/test/commands/
  - packages/engine/test/db/
  - packages/engine/test/merge-slot/
  - packages/engine/test/reads/
  - packages/engine/test/reconcile/
  - packages/engine/test/run/
priority: high
type: feature
ordinal: 144000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo resume <id> [--note] resumes every parked story as the ADR 0020 matrix says, from the parks that need no grant to the capped, conflicted and review-loop parks where each noted resume adds one round as a grant; dipo resume <id> --budget tops up a budget-exceeded story after confirmation; every waiting office command is shown safe to re-run after a crash; and a park block on a story that is not Parked is reported by reconcile and removed by the close-out commit.

Context: implements ADR 0020 section 1 (the resume path), the matching rows of the section 2 matrix with its rules for every row, section 3 (notes and how they reach the worker), and the work.resume and parks changes of sections 14 to 16. Today every park except needs-permission answers work.resume with story.notPausedOrParked (0020 fact 2). The policy reads parks.cause, which DIPO-142 adds.

From DIPO-156: implements ADR 0020 section 4 (budget top-up; maintainer decision on budget-exceeded resume and spike answer 1) and the budget-exceeded rows of section 2. DIPO-105 parked on its turn cap with no way back in M0 (0020, real cases from the cutover).

From DIPO-157: implements the cap, conflict and review-loop rows of the ADR 0020 section 2 matrix and its rule that every resume with a note adds exactly one round of the limit that fired (spike answer 6b), for the parks 0019 causes (0019 sections 4, 8, 9 and 10).

DIPO-142 built the worker place and the reviewer place (packages/engine/src/run/places.ts) and wired only the resume starter (packages/engine/src/run/compose.ts). A resume that finds its place taken is queued (Resumption returns queued: true and a run.queued notice), but the work.answer reply does not say so yet; the resume replies of this story say when a resume was queued. The review-resume starter registers for the reviewer place.

DIPO-205 adds the park verify-failing with cause capped: a run whose cap-crossing turn carried a done report took the done path, and its verify failed with no turn left. Its resume (0020 Amendments, 2026-10-19, DIPO-205) needs a note, like the loops and ci causes, and grants the section 4 top-up: all three caps grow by 50% of the starting caps as one budget grant recorded with who and why. Writing the note is the explicit act, so no further confirmation is asked; the reply names the grant. The first message is the verify failure from the park detail (nothing stores it in feedback_items, since no feedback turn was sent), then the note; without a note it answers resume.noteRequired.

From DIPO-168: implements the 0005 note of 2026-10-17 recorded in ADR 0020 (Amends): every waiting handler must be target-state under a re-run, and each waiting command has a test that injects a crash between a commit and the requests row. Today four commands use the waiting path and 0005 does not describe it (0020 fact 8).

From DIPO-190: DIPO-129 merged to main as Done with "park: reason ambiguous-spec" from its parked run still in its field block, after the maintainer finished it by hand. 0012 F16 and the 0010 section 3 field table say the park record exists only while Parked. Status Done wins (0020), but the task file states a false fact, and nothing flags it. Reconcile step 4 (reconcilePark in packages/engine/src/reconcile/reconcile.ts) records any F16 block with no open park row as a park "recorded by hand", whatever the story's status. The resume path already removes F16 (gitUnparkWriter, 0020 section 1).

The close-out commit that sets Done (0019 section 9 step 1) comes with DIPO-150, so this story depends on it. DIPO-162 releases a claim whose story is Done on the base through another branch and writes nothing to the backlog; a stale park block there gets this story's reconcile notice and stays for the maintainer to remove. DIPO-155 resumes parks and does not touch Done stories. 0007 section 6's reconcile table says, in the row for the current park state: "F16 with no DB park: record a park from Backlog with detail 'recorded by hand'", with no status condition. The narrowing in this story reads that row together with 0012 F16 and 0010 section 3, which allow F16 only while Parked: an F16 block on any other status is a stale fact, not a park. The 0007 section 6 note of 2026-10-20 (DIPO-190) says so; this story does not edit docs/decisions/.

```dipo
branch: "DIPO-155/resume-parked-stories"
unknowns:
  - q: "0007 section 6's reconcile row says an F16 with no DB park is recorded as a park by hand, with no status condition. Does 0007 section 6 get a dated note that this applies only to a Parked story, and that an F16 block on any other status is reported as stale instead?"
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): yes; the 0007 section 6 note of 2026-10-20 (DIPO-190) says an F16 park block with no database park is recorded as a park by hand only when the story's status is Parked, and on any other status reconcile reports the block as stale with a notice."
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
    - kind: "automated"
      check: "(engine) a top-up resume of a budget-exceeded/build park that a reopened fix round hit before any worker session sends that round's stored feedback_items first, then feedback/topup.md"
    - kind: "automated"
      check: "(unit) +50% on a tier S run adds 150,000 tokens and grows turns and minutes by half, recorded as one grant"
    - kind: "automated"
      check: "(unit) a plain resume answers resume.topUpRequired and a too small top-up answers resume.topUpTooSmall with the smallest share"
    - kind: "automated"
      check: "(unit) commands.describe lists confirmWhen budget for work.resume"
    - kind: "automated"
      check: "(unit) a review-cause top-up starts a fresh review, not a developer session"
    - kind: "automated"
      check: "(unit) loops, ci, conflictHandoff and reviewRound resumes each record exactly one grant and send the stored item first"
    - kind: "automated"
      check: "(integration, real git) a merge-in-progress resume continues the kept merge, and after a base move aborts and merges again"
    - kind: "automated"
      check: "(unit) slot-refused re-enters the slot without a session and pr-closed opens a new PR naming the old one"
    - kind: "automated"
      check: "(unit) a review-cap resume grows the reviewer cap by 50% as a grant"
    - kind: "automated"
      check: "(unit) one crash-and-retry test per waiting command asserting no repeated effect"
    - kind: "automated"
      check: "(unit) a duplicate request during a running handler gets the same reply"
    - kind: "automated"
      check: "(unit) reconcile on a Done story with an F16 block emits the stale-park notice and writes no parks row; a Parked story with F16 and no row is recorded by hand"
    - kind: "automated"
      check: "(integration, real git) the close-out commit on a branch whose task file holds F16 sets Done and leaves no park key in the field block"
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
- [ ] #7 (from DIPO-156) dipo resume <id> --budget +N% or +<tokens> with --note records a budget grant in run_grants (note, origin, client name, time, caps before and after) and raises tokens, turns and minutes by the same share of the run's starting caps; a fixed amount is tokens and turns and minutes grow by its share of the starting budget
- [ ] #8 (from DIPO-156) A resume of a budget-exceeded park without --budget answers resume.topUpRequired naming --budget and the cap that fired, and a top-up after which that cap would still be reached answers resume.topUpTooSmall naming the smallest share that clears it
- [ ] #9 (from DIPO-156) commands.describe gains confirmWhen and work.resume declares it for budget; the CLI shows the caps before and after and asks yes or no unless --yes is given
- [ ] #10 (from DIPO-156) Cause build resumes the developer session (native when the 0014 section 6 checks pass, else a handoff) with feedback/topup.md first; cause review starts a fresh reviewer session on the same head in the reviewer place, and that round is not counted as failed
- [ ] #11 (from DIPO-156) The CLI --max-turns backstop of the resumed session gets the remaining turns of the raised cap
- [ ] #12 (from DIPO-156) A top-up resume of a budget-exceeded park that a reopened round hit before any worker session (DIPO-205) sends that round's undelivered feedback first, read from the run's feedback_items rows that no delivered intent carried, then feedback/topup.md
- [ ] #13 (from DIPO-157) verify-failing/loops and verify-failing/ci resume with a required note, the first message being the last verify or CI item from feedback_items, and record one loop or ciAttempt grant
- [ ] #14 (from DIPO-157) conflict/merge-in-progress continues the kept merge with its conflict item when the base has not moved and aborts and merges again when it moved, recording one conflictHandoff grant; conflict/unwritable-path merges the base again and parks at once if an unwritable path still conflicts
- [ ] #15 (from DIPO-157) conflict/push-rejected fetches the remote branch and merges it into the local branch through the 0019 hand-off, never by force, and the worker gets the commits that were only on the remote; conflict/slot-refused returns to In Review and re-enters the merge slot with a fresh per-stay count and no model session
- [ ] #16 (from DIPO-157) review-blocked/rounds with a note returns to In Review and then In Progress as a fix round with the blocking findings first, recording one reviewRound grant
- [ ] #17 (from DIPO-157) stopped/pr-closed returns to In Review and opens a new story PR for the same head whose body names the closed one; stopped/review and worker-failed/review start a fresh reviewer session of the same round on the same head; worker-failed/review-cap does the same and grows the cap that fired by 50% as a reviewCap grant
- [ ] #18 (from DIPO-157) No resume raises a cap without a recorded grant, shown by a test that checks every cap change against a grant row
- [ ] #19 (from DIPO-157) verify-failing/capped (DIPO-205) resumes only with a note, grows all three caps by 50% of the starting caps as one budget grant recorded with who and why, with no confirmation beyond the note, and starts with the verify failure from the park detail, then the note; a resume without a note answers resume.noteRequired
- [ ] #20 (from DIPO-168) For each waiting office command (work.run, work.stop, work.answer, work.resume, story.hold, story.drop, work.discard, work.steer, work.pause) a test injects a crash after a handler commit and before the requests row, then retries the command
- [ ] #21 (from DIPO-168) Each retry repeats no effect: no second commit, push, PR close, message to the worker or grant
- [ ] #22 (from DIPO-168) A duplicate request that arrives while the first one runs waits for the same reply, shown by a test
- [ ] #23 (from DIPO-190) Reconcile (reconcilePark in packages/engine/src/reconcile/reconcile.ts) records a park from an F16 block with no open park row only when the story's status is Parked
- [ ] #24 (from DIPO-190) For a story with an F16 block whose status is not Parked, reconcile writes no parks row and emits one warn engine.notice per pass with a new RECONCILE_NOTICES code, naming the story, its status and the park reason
- [ ] #25 (from DIPO-190) The merge slot's close-out commit (DIPO-150, packages/engine/src/merge-slot/) removes the F16 block through the single field write path in the same commit that sets Done, and a test shows a task file that held F16 at close-out has no park key after it
- [ ] #26 (from DIPO-190) A test replays the DIPO-129 case: a Done story with an ambiguous-spec F16 block gets the notice and no parks row, while a Parked story with F16 and no row is still recorded as a park by hand
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: park and resume keep the story's box (0021 section 6).

Carried from DIPO-157: Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: park and resume keep the story's box (0021 section 6).

From the first box run (DIPO-275 on DIPO-248, 2026-10-22): a dipo steer sent to a story that then parks as verify-failing (loops) is held, and the park offers only story.drop, so the steer waits for this story's resume. The steer reply should also say when the park has no resume yet.

From DIPO-299 (2026-10-22): a box run whose branch tip moved at done now parks interrupted with cause build, not verify-failing with cause refused.

2026-10-22: combined from DIPO-156, DIPO-157, DIPO-168, DIPO-190 (maintainer, M1 speed-up)

2026-10-22: dropped the dependencies on DIPO-159 (which now holds DIPO-289) and DIPO-161 (a dependency of DIPO-168) to break a dependency cycle left by the M1 combine; those stories now come after this one.
<!-- SECTION:NOTES:END -->
