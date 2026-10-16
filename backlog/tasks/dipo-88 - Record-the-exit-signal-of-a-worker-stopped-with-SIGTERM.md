---
id: DIPO-88
title: Record the exit signal of a worker stopped with SIGTERM
status: Done
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-16 07:20'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/host/main.ts
  - packages/engine/src/platform/sandbox.ts
  - packages/engine/src/runs/worker-hosts.ts
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/host/steering.ts
  - packages/engine/src/host/protocol.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/db/migrations/0025-exit-signal-inferred.ts
  - packages/engine/test/host/host.test.ts
  - packages/engine/test/host/steering.test.ts
  - packages/engine/test/host/worker-hosts.test.ts
  - packages/engine/test/host/exit-signal.ci.test.ts
  - packages/engine/test/ingest/ingest.test.ts
  - packages/engine/src/workers/claude-cli/result.ts
  - packages/engine/test/workers/result.test.ts
priority: medium
type: feature
ordinal: 78000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when dipo stops a worker with SIGTERM (or SIGKILL), worker_hosts.exit_signal names that signal, so outcomes and dipo logs can tell a stop from a crash.

Context: seen in the M0 delivery sessions: worker_hosts.exit_signal stayed empty after a stop that sent SIGTERM. The stop sequence sends SIGTERM then SIGKILL (packages/engine/src/workers/claude-cli/encode.ts:42-46). The host writes the child exit as Bun reports it (packages/engine/src/host/main.ts:304-323, 358-368), and a likely cause is that the sandbox wrapper forwards the signal and then exits with a code, so Bun reports no signal (packages/engine/src/platform/sandbox.ts:288-289 reads the signal the same way). The ingestor and recordHostExit copy that value as is (packages/engine/src/ingest/ingestor.ts:573-578, packages/engine/src/runs/worker-hosts.ts:268-283). Find out which process loses the signal before fixing.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After a work.stop that ends the worker with SIGTERM, exit.json, the exit line in events.ndjson and worker_hosts.exit_signal all say SIGTERM (and SIGKILL when the kill step was needed); a worker that exits on its own keeps exit_signal null.
- [x] #2 When the signal cannot be read from the process (for example the sandbox wrapper exits 143), the host records the signal it sent last as the cause, with a field that says it was inferred.
- [x] #3 A test on a real host with a scripted worker covers a SIGTERM stop and a normal exit.
<!-- AC:END -->
