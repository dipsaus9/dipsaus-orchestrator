---
id: DIPO-93
title: >-
  Close the DIPO-57 re-attach gaps: follow-only stop, second-restart close-out,
  spawn window, backstop
status: Done
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-16 07:20'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-57
references:
  - packages/engine/src/run/reattach.ts
  - packages/engine/src/run/hosts.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/runs/worker-hosts.ts
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0008-worker-adapter.md
  - packages/engine/src/platform/process.ts
  - packages/engine/src/host/main.ts
  - packages/engine/src/host/protocol.ts
  - packages/daemon/src/worker-host.ts
  - packages/daemon/src/runs.ts
  - packages/engine/src/db/migrations/0027-reattach-gaps.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/src/run/records.ts
  - packages/engine/src/run/outcomes.ts
  - packages/engine/src/run/index.ts
  - packages/engine/src/index.ts
  - packages/engine/test/run
  - packages/engine/test/host
  - packages/engine/test/platform/process.test.ts
  - packages/engine/test/db
  - packages/daemon/test
priority: medium
type: feature
ordinal: 83000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker host that dipo only follows after a restart can still be stopped, is closed out even across further restarts, the window between spawning a host and recording it is closed, and the DIPO-49 backstop keeps running for re-attached runs.

Context: follow-ups recorded in the DIPO-57 notes and its live test of 2026-10-14. (1) work.stop cannot reach a follow-only host: hostSocketSteering refuses it (packages/engine/src/run/hosts.ts:231-251) and run.stopNotSent is posted (packages/engine/src/run/control.ts:102). Signalling the host by verified PID and start time is not in 0006 decision 8 or the 0008 stop sequence, so it needs an ADR 0006/0008 amendment approved by the maintainer before it is built. (2) Re-attach only walks active runs (packages/engine/src/run/reattach.ts:178), so a followed host still running after its run ended is not closed out after a second restart. (3) The worker_hosts row is written after the spawn (packages/engine/src/runs/worker-hosts.ts:168), leaving milliseconds in which a stop loses the host. (4) Re-attached runs are tracked with snapshot null (packages/engine/src/run/reattach.ts:258), so the backstop is off for the rest of that session.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The maintainer approves an ADR 0006/0008 amendment for stopping a follow-only host by signal after a PID and start-time check; with it recorded, work.stop on a follow-only run sends that signal sequence and the story parks as for any stop.
- [x] #2 Recovery also sweeps worker_hosts rows without ended_at whose run has ended: a dead host is closed out (exit.json or lost), a live one is followed until it exits, across any number of restarts.
- [x] #3 A pending host row (or PID marker) is written before or at spawn, so a restart in that window finds the host and never starts a second one.
- [x] #4 The backstop snapshot is stored with the run and restored on re-attach, so the DIPO-49 backstop keeps running after a restart.
- [x] #5 Fast tests cover each case; a CI test stops a follow-only host on a real host process.
<!-- AC:END -->
