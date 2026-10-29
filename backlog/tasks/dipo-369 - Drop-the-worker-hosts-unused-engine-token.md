---
id: DIPO-369
title: Drop the worker host's unused engine token
status: Done
assignee: []
created_date: '2026-10-29 08:06'
updated_date: '2026-10-29 21:52'
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
modified_files:
  - packages/engine/src/db/migrations/0068-drop-engine-token.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/host/client.ts
  - packages/engine/src/host/protocol.ts
  - packages/engine/src/run/hosts.ts
  - packages/engine/src/run/reattach.ts
  - packages/engine/src/runs/worker-hosts.ts
  - packages/engine/test/db/drop-engine-token.test.ts
  - packages/engine/test/host/host.test.ts
  - packages/engine/test/host/pending-hosts.test.ts
  - packages/engine/test/host/worker-hosts.test.ts
  - packages/engine/test/run/host-watch.test.ts
  - packages/engine/test/run/reattach.test.ts
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
- [x] #1 The engine token is no longer created, stored, written to launch.json or sent in the hello; the builder confirms the host never read it and removes its type from host/client.ts
- [x] #2 The worker_hosts.engine_token column is dropped by a migration tested on a database with rows, fresh equals migrated, and the one-writer test stays green
- [x] #3 A host started by an earlier binary that still sends the token in its hello is reattached, the token ignored, with a test
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-29 21:52 UTC
- Criteria met: 3 of 3 (as the worker reported them)
- Loops: 0; CI attempts: 0
- Review rounds: 1, failed 0
- Budget used: 93,269 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
