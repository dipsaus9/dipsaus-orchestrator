---
id: DIPO-120
title: >-
  Show the daemon's state truthfully: why it is recovering, the real active run
  count, and the command that frees a port slot
status: Refined
assignee: []
created_date: '2026-10-16 11:52'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-240
  - DIPO-284
  - DIPO-295
  - DIPO-161
  - DIPO-197
  - DIPO-302
references:
  - docs/decisions/0009-tui.md
  - packages/cli/src/daemon-commands.test.ts
  - packages/cli/src/daemon-commands.ts
  - packages/client/src/recovery.ts
  - packages/client/src/store
  - packages/client/test
  - packages/contract/src/errors.ts
  - packages/daemon/src/control.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/test
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/views/summary.ts
  - packages/engine/src/worktree/setup.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/engine/test/worktree/setup.test.ts
  - packages/tui/src
priority: medium
type: feature
ordinal: 110000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon's state reads true: when the daemon is held in recovering because its database is unavailable (DIPO-111), the TUI banner says so with the reason and the newest backup; dipo daemon status shows how many runs are active across the loaded offices instead of always 0; the slots refusal and the port slot setup failure say that dipo discard <id> frees a story's slot; and dipo run --dry-run --box shows what a box run would do.

Context: DIPO-111 holds the daemon in recovering and answers reads with the non-retryable code database.unavailable (DatabaseUnavailableDetails { reason, backup? }, packages/contract/src/errors.ts). That code ends the retry in packages/client/src/recovery.ts and in the office store (whose retry runs on a RECOVERY_POLL_MS timer). The store keeps the failed read's EngineError in OfficeStoreState.error, details untyped, until the next success, but not daemon.status stateReason. The TUI never renders state.error, and bannerLines in packages/tui/src/views.tsx only switches on the daemon state. 0009 section 7 fixes the recovering banner text, so this needs a dated 0009 note. Found while delivering DIPO-111.

From DIPO-125: packages/daemon/src/control.ts sets activeRuns: 0 with the comment "Runs are DIPO-48; until then the count is 0", but DIPO-48 is Done. activeRunCount(office) exists in packages/engine/src/views/summary.ts. packages/cli/src/daemon-commands.ts prints the field. Found by the 2026-10-16 milestone review, section 1c CC2.

From DIPO-199: the follow-up of DIPO-197, split from it in the review of PR #194. Tonight `dipo run DIPO-177` failed at setup because all 20 port slots were held, and the message gave no way out. DIPO-197 makes work.preview and work.run (packages/engine/src/run/work-run.ts) refuse before the claim with check slots and lists each holder in the refusal and in the setup failure (setupWorktree, packages/engine/src/worktree/setup.ts). M0 has no command that frees a slot: teardown frees it when dipo removes a worktree at Done (DIPO-58). DIPO-161 adds dipo discard <id>, which removes a story's worktree and frees its slot, so this story depends on DIPO-161 and on DIPO-197. DIPO-162's release runs on the Done poll without a command, so it is not a dependency.

```dipo
branch: "DIPO-120/daemon-status-texts"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the slots refusal of work.preview and work.run names dipo discard <id> after the list of holders"
    - kind: "automated"
      check: "(unit) the port slot setup failure names dipo discard <id> after the list of holders"
    - kind: "manual"
      check: "(live) with a temp DIPO_HOME and worktree.maxSlots set to 1 on the scratch repo, run one story, run dipo run --dry-run for another, then dipo discard the first and run the dry run again"
      expect: "the first dry run names dipo discard <id> under the holder list, and after the discard the dry run says it would start the second story"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 While the daemon answers database.unavailable, the banner shows a database line with the reason and, when given, the newest backup path, in place of the reconcile line
- [ ] #2 The ordinary recovering banner (reconcile after a start) is unchanged
- [ ] #3 The client store exposes the database line as typed state (DatabaseUnavailableDetails parsed from the error's details) that the TUI reads; with no office selected, a daemon reporting recovering gets one office read from the store so the details arrive; the line survives an office switch; no UI imports engine internals
- [ ] #4 The database line clears when the daemon state goes to draining and after a reconnect to a daemon that answers reads again (a fresh engine.hello), with tests
- [ ] #5 Tests cover the banner text in both cases and in ASCII mode
- [ ] #6 A dated 0009 section 7 note for the database line is proposed in the PR for the maintainer's approval
- [ ] #7 (from DIPO-125) daemon.status activeRuns is the sum of the active runs (activeRuns(handle).length) over the loaded offices, and the stale comment is gone
- [ ] #8 (from DIPO-125) A test with two offices and active runs checks the count and the CLI line
- [ ] #9 (from DIPO-199) The slots refusal of work.preview and work.run (packages/engine/src/run/work-run.ts) says, after its list of holders, that dipo discard <id> frees a story's slot; a test in packages/engine/test/run/work-run.test.ts checks the text
- [ ] #10 (from DIPO-199) The port slot setup failure in setupWorktree (packages/engine/src/worktree/setup.ts) says the same after its list of holders; a test in packages/engine/test/worktree/setup.test.ts checks the text
- [ ] #11 `dipo run --dry-run --box` shows what a box run would do (today it is refused)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Carried from DIPO-125: Review note: ControlDeps has only loadedOffices() (ids); the count needs a new dep wired where controlFeature is built in packages/daemon/src/foreground.ts. activeRunCount is not exported from the engine entry; activeRuns(handle).length is.

2026-10-22: combined from DIPO-125, DIPO-199 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
