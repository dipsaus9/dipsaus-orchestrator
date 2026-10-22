---
id: DIPO-248
title: >-
  Harden three tests and a code comment left from the DIPO-227, 229 and 136
  reviews
status: Parked
assignee: []
created_date: '2026-10-20 18:35'
updated_date: '2026-10-22 07:35'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-183
  - DIPO-228
references:
  - packages/engine/test/run/work-run.test.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/test/unit/
  - packages/contract/src/errors.ts
priority: low
type: chore
ordinal: 248000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the DIPO-229 claim-window test waits for a condition instead of a fixed number of microtask ticks, the daemon's StoryPlanning wiring has a test, and the office.refused comment names every cause it is used for.

Context: advisories of three reviews on 2026-10-20. (1) DIPO-229 (PR #278): settle() in packages/engine/test/run/work-run.test.ts waits 50 microtask ticks for a park answer to reach its serialized step; if a later change puts a macrotask before that step, the claim-window test still passes but no longer catches the race. (2) DIPO-227 (PR #279): packages/daemon/src/foreground.ts builds StoryPlanning inside serve() with `probe: systemProcessProbe(platform)`; no daemon test builds serve()'s dependencies, so the wiring is checked only by tsc through the required field. Daemon unit tests live in packages/daemon/test/unit/. (3) DIPO-136 (PR #282): office.setPrivacy answers office.refused for a failed write of .dipo/office.local.yaml; the comment on office.refused in packages/contract/src/errors.ts says only "an office whose engine instance would not load".

```dipo
branch: "DIPO-248/harden-tests-and-refused-comment"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) work-run.test.ts: the claim-window test waits until the answer's intent row is stored (or the unpark mock resolves) before it opens the claim gate, and still fails with the DIPO-229 fix reverted"
    - kind: "automated"
      check: "(unit) a daemon unit test calls the factored-out StoryPlanning dependency builder and finds the probe it was given"
park:
  reason: "verify-failing"
  from: "In Progress"
  note: "verify failed 3 of 3 times (the tier loop cap). Verify failed at the verify step.\nCommand: bun run verify\nExit code: 1\nLocations:\n- packages/testkit/src/git.ts:79:20\n- packages/testkit/src/git.ts:97:24\n- packages/testkit/src/git.ts:152:11\n- packages/engine/test/office/set-privacy.test.ts:98:11\n- packages/engine/test/office/set-privacy.test.ts:33:11\n- packages/engine/test/office/set-privacy.test.ts:76:11\n- packages/engine/test/office/set-privacy.test.ts:134:11\n- packages/engine/test/backlog/lane/lane.test.ts:138:11\n- packages/engine/test/backlog/lane/lane.test.ts:177:11\n- packages/testkit/src/git.ts:189:10\n- packages/engine/test/backlog/lane/lane.test.ts:112:11\n- packages/engine/test/backlog/lane/lane.test.ts:38:11\n- packages/engine/test/scan/read-probe.test.ts:206:11\n- packages/engine/test/scan/read-probe.test.ts:171:11\n- packages/engine/test/scan/read-probe.test.ts:105:11\n- packages/engine/test/scan/read-probe.test.ts:82:11\n- packages/engine/test/scan/read-probe.test.ts:46:11\n- packages/engine/test/backlog/lane/failures.test.ts:68:11\n- packages/engine/test/backlog/lane/failures.test.ts:94:11\n- packages/engine/test/backlog/lane/failures.test.ts:30:11\n- and 152 more\nLast output lines:\n[dipo: showing the last 21 of 10,983 output lines.]\n(fail) office.rescan > reports a failed scan as scan.finished with the error and keeps the profile [0.39ms]\n(fail) office.rescan > fails with scan.running while a rescan runs [0.26ms]\n(fail) office.rescan > re-indexes the stories, stores the diff of a script change and emits scan.finished [0.26ms]\n(fail) the claims load step sweeps leftover scratch directories > leaves only the claim worktree after the office loads [0.39ms]\n(fail) the claims load step sweeps leftover scratch directories > still loads the office when the worktree root cannot be listed, and warns [0.26ms]\n(fail) the backlog PR > opens one PR once gh is logged in, updates it for the next operation and checks each head [0.42ms]\n(fail) without a remote > opens no PR and reports the waiting branch [0.28ms]\n(fail) the launch self-test's two calls (DIPO-244) > plans the probe and the approval call, and gives the session its own socket [0.28ms]\n(fail) the launch self-test's two calls (DIPO-244) > writes the approval evidence and judges a session whose approval call reached dipo ok [0.25ms]\n(fail) the lockfile on the base branch > is read from <remote>/<base> with its manifests, never from a story's commit or checkout [0.33ms]\n(fail) the lockfile on the base branch > refuses yarn.lock, a lone bun.lockb and lockfiles of two managers with box.cacheUnsupported [0.30ms]\n(fail) the lockfile on the base branch > reads pnpm-workspace.yaml with a pnpm lockfile [0.24ms]\n(fail) the lockfile on the base branch > is null when the base has no lockfile [0.24ms]\n\n --seed=2463149428\n 4512 pass\n 8 skip\n 305 fail\n 42333 expect() calls\nRan 4825 tests across 409 files. [65.16s]\nerror: script \"verify\" exited with code 1"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The claim-window test of DIPO-229 in packages/engine/test/run/work-run.test.ts waits for a condition that is always reached (the answer's intent row stored, or the unpark mock resolved) instead of a fixed count of microtask ticks, and settle() no longer counts ticks
- [ ] #2 The StoryPlanning dependencies serve() builds in packages/daemon/src/foreground.ts come from an exported function that takes the probe, and a test in packages/daemon/test/unit/ shows that the dependencies it returns carry the given probe
- [ ] #3 The comment on office.refused in packages/contract/src/errors.ts names both causes: an office whose engine instance would not load, and a refused write of an office file such as .dipo/office.local.yaml
<!-- AC:END -->
