---
id: DIPO-161
title: Discard a story's work
status: Refined
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-17 13:10'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-160
  - DIPO-144
references:
  - packages/contract/src/office.ts
  - packages/engine/src/worktree/
  - packages/engine/src/run/
  - packages/engine/src/backlog/lane/
  - packages/engine/src/features.ts
  - packages/daemon/src/
  - packages/cli/src/
  - packages/engine/test/worktree/
priority: high
type: feature
ordinal: 150000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo discard <id> lists what is lost, then ends the run, removes the worktree and branch, closes the PR and returns the story to Refined, so a story that went wrong can start over from the backlog.

Context: implements the work.discard row of ADR 0020 section 8 and its dirty-worktree option, on the waiting command path of the 0005 note of 2026-10-17. In M0 work.discard is unregistered, so DIPO-105's parked work could not be cleaned up from dipo (0020, real cases from the cutover).

```dipo
branch: "DIPO-161/discard-story-work"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration, real git) discard of a parked story with uncommitted files removes worktree and branch and writes Refined"
    - kind: "automated"
      check: "(unit) a merged story PR refuses discard and a remote tip the engine did not push keeps the remote branch with a notice"
    - kind: "automated"
      check: "(unit, cli) dipo discard prints the loss list and sends the command only after the typed id"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dipo discard <id> --note <text> lists the commits not on the base and the uncommitted and untracked files, then asks for the typed story id; commands.describe marks work.discard irreversible
- [ ] #2 Discard stops an active run as work.stop does, releases the claim, removes the worktree with --force, deletes the branch locally and remotely, closes open questions, frees the slot, closes the open story PR with a comment naming the discard, resolves an open park as discard and writes Refined in lane b
- [ ] #3 Discard refuses a story whose PR in story_prs is merged, and a remote branch whose tip the engine did not push is not deleted (a notice) while the other steps go on
- [ ] #4 Discard also works on the leftovers of a story Done on the base, writing nothing to the backlog, and on a story whose PR head changed outside dipo
- [ ] #5 work.discard is registered with its since on the waiting command path
<!-- AC:END -->
