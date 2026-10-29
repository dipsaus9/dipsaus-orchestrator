---
id: DIPO-369
title: Drop the worker host's unused engine token
status: Ready
assignee: []
created_date: '2026-10-29 08:06'
updated_date: '2026-10-29 08:38'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/runs/worker-hosts.ts
  - packages/engine/src/host/client.ts
  - packages/engine/src/run/hosts.ts
priority: low
type: chore
ordinal: 349000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine no longer writes an engine token to worker_hosts, launch.json or the host hello, because the host no longer reads it.

From PR #417 (DIPO-347) on 2026-10-28: worker_hosts.engine_token and the token in launch.json and the hello only guarded hookReply, which is gone with the hooks. Dropping the column needs a migration.

```dipo
branch: "DIPO-369/drop-host-engine-token"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) launch.json and the hello carry no engine token, and migration drops the column with rows kept"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The engine token is no longer created, stored, written to launch.json or sent in the hello; the builder confirms the host never read it and removes its type from host/client.ts
- [ ] #2 The worker_hosts.engine_token column is dropped by a migration tested on a database with rows, fresh equals migrated, and the one-writer test stays green
- [ ] #3 A host started by an earlier binary that still sends the token in its hello is reattached, the token ignored, with a test
<!-- AC:END -->
