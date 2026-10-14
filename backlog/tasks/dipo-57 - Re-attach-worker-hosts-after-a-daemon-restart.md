---
id: DIPO-57
title: Re-attach worker hosts after a daemon restart
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-14 15:15'
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
- [x] #1 Host alive with a matching handshake: catch up from `processed_offset`, then follow live with steering.
- [x] #2 Host alive without a socket: tail the event file, wait for `exit.json`, emit `work.observed follow-only`; steering commands fail with a message.
- [x] #3 Host dead with `exit.json`: process remaining events and the exit.
- [x] #4 Host dead without `exit.json`: emit `work.observed host-lost`, then resume once if budget remains and `canResume` holds, else park `interrupted`.
- [x] #5 No new host starts for a run whose old host PID is alive.
- [x] #6 After catch-up the run's caps are checked and the worker stopped when over.
- [x] #7 An `ingest.fileChanged` report (DIPO-45) for an active run parks it `interrupted` with detail "event file changed".
- [x] #8 Re-attach runs as a recovery step registered with the daemon's `recovering` state (DIPO-68), after reconcile (DIPO-56).
- [x] #9 When a re-attach finds a dead host without `exit.json` or an ingested exit line and resumes the run, the resumed session is a new agent and the dead agent's usage is finalized first with `finalizeAgentUsage` (DIPO-45); when the run ends instead, DIPO-51's `endRun` finalizes it. A test covers the resume case.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S41 (DIPO-15). Moved before cutover in the M0 review (maintainer decision D14, DIPO-15). Before cutover: built by hand-run agents.

Implementation (DIPO-57):
- `run/reattach.ts` `RunReattacher`, run by the daemon's recovery step `reattach` after `reconcile` (AC #8; the daemon start test checks the order migrations, reconcile, reattach). Per active story run it takes the newest `worker_hosts` row. An agent that already ended is left to `run-outcomes/redispatch`. Liveness is PID plus start time. Alive and handshake answered: mode `steer`, catch-up pass from `processed_offset`, then `advanced` announcements (AC #1). Alive without an answer (gone, timeout, refused protocol or run): mode `follow`, signal and `work.observed follow-only`, notice `run.followOnly`; ingestion tails by its 1 s poll; `hostSocketSteering` refuses a follow-only host with a message (AC #2). Dead with `exit.json`: the exit is recorded on the host row, the remaining lines and the exit line are ingested and decided as usual (AC #3). A run directory's `exit.json` counts for a host only when its final offset is past the host's processed offset, since the hosts of a run share the directory.
- Dead without `exit.json` and no exit line: `RunControl.onHostLost` -> `RunOutcomes.onHostLost`. The agent ends `host-lost` and `host-lost` is raised with `work.observed`. Then the crash rules apply, but only a resume counts: `#noRetry` (one resume per run, `host-lost` counts like `crashed`; caps), then `finalizeAgentUsage` of the dead agent, then `RunResumer.next` with `requireResume`. A session that cannot be resumed returns `notResumed` and the story parks `interrupted` (AC #4, AC #9). Redispatch treats `host-lost` as a recorded decision, so a restart in between decides it again. A new session clears `host-lost` and `follow-only`.
- AC #5: re-attach never starts a host. `RunResumer` now waits up to 30 s (`HOST_EXIT_WAIT_MS`) for every earlier host of the run to be dead by PID and start time before it starts one; otherwise it fails. Redispatch skips a run whose newest host row is not its newest agent, and skips runs that run control tracks.
- AC #6: `RunControl.checkCaps` runs right after the catch-up of a living host.
- AC #7: the `onFileChanged` ingest hook parks a tracked run `interrupted` with the detail "event file changed" and sends the stop sequence. Re-attach parks a run whose cursor already has `changed_at`, or whose file changed while the daemon was down.
- Restart window 1 (DIPO-51 review): `HostStarter.start` takes `processedOffset` and `record`. The resumer's new `agents` row and the host's start offset are written in the transaction that records the host. A stop while the host starts therefore leaves both rows or neither, and the restart follows the new host instead of starting a second session. Rows from an older binary (a host row without its agent) get the start offset from the earlier host's end and are re-attached. Remaining gap: the few milliseconds between spawning the host and recording it.
- Restart window 2: `#byIntent` resolves the intent and records the agent's end reason in one transaction.
- Re-attached runs are tracked without a backstop snapshot (the snapshot from before the worker started is lost at a restart), so the DIPO-49 backstop does not run for the rest of that session.
- `work.stop` on a follow-only run cannot reach the worker: the stop intent is marked failed with the follow-only reason, `run.stopNotSent` is posted and the story still parks. No ADR or contract change; `run.followOnly` is a new `engine.notice` code string.
- Tests: `test/run/reattach.test.ts` (14 fast tests, about 0.3 s: the four cases, follow-only steering, caps after catch-up, a truncated or already-reported event file, the host-lost resume with usage finalized first, park `interrupted`, restart windows 1 and 2). `test/run/reattach.ci.test.ts`: a restart during a replayed run on a real host socket, with output continuing without gaps or duplicates.
<!-- SECTION:NOTES:END -->
