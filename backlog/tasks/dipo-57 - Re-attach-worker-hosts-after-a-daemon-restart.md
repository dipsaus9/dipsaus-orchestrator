---
id: DIPO-57
title: Re-attach worker hosts after a daemon restart
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-14 15:14'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-45
  - DIPO-51
  - DIPO-52
  - DIPO-56
  - DIPO-74
references:
  - packages/engine/src/host/
  - packages/engine/test/host/
  - packages/engine/src/run/
  - packages/engine/src/recovery/
  - packages/engine/src/features.ts
  - packages/engine/src/ingest/
  - packages/engine/src/run/reattach.ts
  - packages/engine/src/runs/worker-hosts.ts
  - packages/engine/src/index.ts
  - packages/engine/test/run/
  - packages/daemon/src/runs.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/test/integration/foreground.test.ts
documentation:
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0009-tui.md
priority: high
type: feature
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after a daemon restart the engine re-attaches every active run's worker host by PID and start time, catches up from the processed offset, follows a host whose socket is gone in follow-only mode, processes an exit that happened while it was down, and parks `interrupted` a run whose host died without an exit file and cannot be resumed.

Context: required before cutover (maintainer decision D14, DIPO-15; 0003 amendment of 2026-10-12): once dipo builds itself, a daemon upgrade or restart must not lose the run that is building it. Re-attach is a recovery step registered with the daemon's `recovering` state (DIPO-68), after reconcile (DIPO-56). It also handles the `ingest.fileChanged` report of DIPO-45, which parks the run `interrupted` (M0 review, DIPO-15). The manual check uses `dipo watch` (DIPO-52), so it does not depend on the TUI stories. References: 0006 decision 7 (recovering), decision 8 (re-attach cases, never a new host while the old PID is alive, caps checked after catch-up); 0007 section 5 (host file changed means `interrupted`); 0008 section 8 (resume on `interrupted`); 0009 section 3 (`host-lost`, `follow-only`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-57/re-attach-worker-hosts-after-daemon"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) each of the four cases with a fake host."
    - kind: "automated"
      check: "(integration, CI only) restart the daemon during a replayed run; output continues without gaps or duplicates."
    - kind: "automated"
      check: "(engine) a truncated event file of an active run parks it `interrupted` with detail \"event file changed\"."
    - kind: "manual"
      check: "during a scratch run, keep `dipo watch <ID>` open in one terminal and run `dipo daemon restart` in another"
      expect: "`dipo watch` reconnects and the worker output continues without a gap or repeated lines."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Host alive with a matching handshake: catch up from `processed_offset`, then follow live with steering.
- [ ] #2 Host alive without a socket: tail the event file, wait for `exit.json`, emit `work.observed follow-only`; steering commands fail with a message.
- [ ] #3 Host dead with `exit.json`: process remaining events and the exit.
- [ ] #4 Host dead without `exit.json`: emit `work.observed host-lost`, then resume once if budget remains and `canResume` holds, else park `interrupted`.
- [ ] #5 No new host starts for a run whose old host PID is alive.
- [ ] #6 After catch-up the run's caps are checked and the worker stopped when over.
- [ ] #7 An `ingest.fileChanged` report (DIPO-45) for an active run parks it `interrupted` with detail "event file changed".
- [ ] #8 Re-attach runs as a recovery step registered with the daemon's `recovering` state (DIPO-68), after reconcile (DIPO-56).
- [ ] #9 When a re-attach finds a dead host without `exit.json` or an ingested exit line and resumes the run, the resumed session is a new agent and the dead agent's usage is finalized first with `finalizeAgentUsage` (DIPO-45); when the run ends instead, DIPO-51's `endRun` finalizes it. A test covers the resume case.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S41 (DIPO-15). Moved before cutover in the M0 review (maintainer decision D14, DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
