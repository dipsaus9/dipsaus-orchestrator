---
id: DIPO-438
title: >-
  Let dipo recover alone from a reset loop and a claim cut short, and split the
  TUI's main screen
status: Refined
assignee: []
created_date: '2026-11-03 09:54'
updated_date: '2026-11-03 09:54'
labels:
  - 'tier:L'
milestone: m-2
dependencies: []
references:
  - packages/client/src/store/office-store.ts
  - packages/client/test/unit/office-store.test.ts
  - packages/engine/src/worktree/claim.ts
  - packages/engine/test/worktree/claim.test.ts
  - packages/tui/src/
priority: low
type: enhancement
ordinal: 411000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to recover by itself from a reload loop and from a crash in the middle of a claim, and the TUI's main screen split into one part per mode, so that a glitch never needs my hands and new screens stay easy to add.

Three low findings of the M1 close-out review (2026-11-02), filed together.

- Reload loop (M1-10, a risk the review did not show can happen): on stream.resetRequired the office store in packages/client/src/store/office-store.ts reloads and resubscribes at once, with no backoff and no cap. A daemon that keeps answering resetRequired, for example after a cursor bug, makes the TUI loop on round trips at full speed: the client-side twin of DIPO-422. The fix uses the store's existing retry backoff (#scheduleRetry) for a second reset within a short window.
- Claim cut short (M1-11): when the daemon dies between the claim commit and updateClaim in packages/engine/src/worktree/claim.ts, the branch keeps the claim commit. At the next start the interrupted-setup rollback finds a tip past startSha, leaves the branch, posts claim.leftover and holds the story out until the maintainer clears it. The fix treats a tip whose only commit past startSha is dipo's own claim commit for this story as made by this claim, and resets it (design choice, not a maintainer decision; the maintainer may change it before a run).
- TUI main screen (M1-14): packages/tui/src/app.tsx is one component of about 1,264 lines with 21 useState calls, and every M2 view adds to its one key handler. The fix splits it into one component per mode with a mode reducer; key bindings and screens do not change.

```dipo
branch: "DIPO-438/reset-backoff-claim-crash-tui-split"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) office-store.test.ts: one reset reloads at once; repeated resets within the window wait with growing backoff instead of looping"
    - kind: "automated"
      check: "(unit) claim.test.ts: a daemon stop after the claim commit and before the claim is recorded is rolled back at the next start with no notice; a branch with a foreign commit still gets claim.leftover"
    - kind: "automated"
      check: "(unit) the TUI tests pass unchanged after the split, and a reducer test covers each mode change"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A second stream.resetRequired within a short window makes the office store wait with its retry backoff before it reloads, and the wait grows with each further reset; a single reset still reloads at once
- [ ] #2 After a daemon stop between the claim commit and the recorded claim, the next start rolls the claim back without the maintainer: a branch whose only commit past its start is dipo's claim commit for this story is reset or deleted, with no claim.leftover notice
- [ ] #3 A branch with any other commit past its start is still left for the maintainer with the claim.leftover notice
- [ ] #4 The TUI's main screen is one component per mode with a mode reducer, app.tsx keeps only the wiring, and the existing TUI tests pass unchanged
<!-- AC:END -->
