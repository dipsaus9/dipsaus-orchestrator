---
id: DIPO-102
title: Remove the run temp directory when a run ends
status: To Do
assignee: []
created_date: '2026-10-15 19:23'
updated_date: '2026-10-15 20:58'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/run/launch.ts
  - packages/engine/src/run/records.ts
  - packages/engine/src/run/temp-dirs.ts
  - packages/engine/test/run/temp-dirs.test.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/run/index.ts
  - packages/daemon/src/runs.ts
  - packages/daemon/src/foreground.ts
  - packages/engine/test/run/run-office.ts
  - packages/engine/test/run/temp-dirs.ci.test.ts
  - packages/daemon/test/integration/foreground.test.ts
priority: medium
type: feature
ordinal: 92000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: no /tmp/dipo-run-<run-id> directory stays behind after a run ends (any outcome) or after the daemon removes a claim.

Context: seen in the DIPO-84 test on 2026-10-15: /tmp/dipo-run-* directories (with the Safe-Chain install caches of DIPO-84 inside) stayed after the runs ended. runLaunchPaths puts the run temp dir at <tmpRoot>/dipo-run-<run-id> (packages/engine/src/run/launch.ts:208) and prepare removes it only when the setup fails (packages/engine/src/run/launch.ts:312-315); nothing removes it when the run ends.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When a run ends (done, failed, stopped, parked), the engine removes its temp directory after the worker host has exited; a resumed session of the same run gets a fresh one.
- [ ] #2 Daemon start (recovery) removes dipo-run-* directories under the temp root whose run has ended or is unknown, and never one of a live or re-attachable run.
- [ ] #3 Tests cover removal at run end and the recovery sweep keeping a live run's directory.
<!-- AC:END -->
