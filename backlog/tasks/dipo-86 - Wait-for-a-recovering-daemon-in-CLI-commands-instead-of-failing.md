---
id: DIPO-86
title: Wait for a recovering daemon in CLI commands instead of failing
status: To Do
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-15 19:24'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/cli/src/daemon-commands.ts
  - packages/cli/src/office-commands.ts
  - packages/client/src/node/lifecycle/lifecycle.ts
  - packages/daemon/src/lifecycle.ts
  - packages/client/src/recovery.ts
  - packages/client/src/index.ts
  - packages/client/test/unit/recovery.test.ts
  - packages/cli/src/office-commands.test.ts
  - packages/cli/src/daemon-commands.test.ts
priority: high
type: feature
ordinal: 76000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo office open (and every other CLI command) run right after dipo daemon start waits for the daemon to finish recovering and then succeeds, instead of failing with engine.recovering.

Context: seen in the M0 delivery sessions: dipo daemon start followed at once by dipo office open failed with engine.recovering. The daemon answers office reads and commands with engine.recovering in starting and recovering (packages/daemon/src/lifecycle.ts:97-104). dipo daemon start returns once the daemon answers, not once it is running (packages/client/src/node/lifecycle/lifecycle.ts:395-415). The CLI sends the command once and prints the error (packages/cli/src/office-commands.ts:180-190, withDaemon in packages/cli/src/daemon-commands.ts:458-484). Only the TUI store retries on engine.recovering (packages/client/src/store/office-store.ts:313).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A CLI command that gets engine.recovering waits for daemon.state running (or polls daemon.status) and sends the command again, within the existing reply timeout; it prints one line such as waiting for the daemon to finish recovering when the wait is longer than about a second.
- [ ] #2 A daemon that ends recovery in safe makes the command fail with a clear line naming safe mode and dipo daemon resume, not a timeout.
- [ ] #3 The retry lives in the client package so the CLI and any other client share it; commands that are not idempotent are sent again only with the same request id.
- [ ] #4 Tests cover a fake daemon that answers engine.recovering twice and then succeeds, and one that goes to safe.
<!-- AC:END -->
