---
id: DIPO-330
title: >-
  Set a worker host's end at ingest and fix the other readers of
  worker_hosts.ended_at
status: Refined
assignee: []
created_date: '2026-10-23 11:26'
updated_date: '2026-10-25 09:55'
labels: []
milestone: m-2
dependencies: []
references:
  - packages/engine/src/retention/
  - packages/engine/src/keepawake/activity.ts
  - packages/engine/src/ingest/
  - packages/engine/src/run/reattach.ts
priority: medium
type: bug
ordinal: 315000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up of the DIPO-328 review. Only a re-attach sets worker_hosts.ended_at, so run file retention (retention/run-files.ts) never removes the files of runs without a daemon restart, state retention (retention/run.ts) never prunes their host rows, keep-awake (keepawake/activity.ts) probes every such host on each read, and ingest_cursors.ended_at has the same restart-only assumption.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 worker_hosts.ended_at is set when the host's process is gone, also without a re-attach, and rows written before are backfilled or read with the exited rule
- [ ] #2 Run file retention, state retention and keep-awake treat an exited host as ended
- [ ] #3 ingest_cursors.ended_at readers are checked and fixed or named
<!-- AC:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-10-25 09:55
---
Folded into DIPO-354 on 2026-10-25 (prune plan): the worker host's end is set when its exit is ingested, as a criterion of the database cut.
---
<!-- COMMENTS:END -->
