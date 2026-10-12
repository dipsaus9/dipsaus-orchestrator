---
id: DIPO-68
title: Move the daemon through its lifecycle states with drain and safe mode
status: Done
assignee: []
created_date: '2026-10-12 09:20'
updated_date: '2026-10-12 12:48'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-23
references:
  - packages/daemon/src/
  - packages/engine/src/platform/process.ts
  - packages/daemon/test/
  - packages/engine/src/index.ts
  - packages/engine/test/platform/process.test.ts
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
priority: high
type: feature
ordinal: 23500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the daemon moves through `starting`, `recovering`, `running`, `draining` and `safe` as 0006 decision 7, drains within its caps on SIGTERM or SIGINT, waits for every child process it started, and starts in `safe` with scheduling off after three crashes within ten minutes.

Context: split from DIPO-23 in the M0 review (DIPO-15), which keeps the PID lock, the runtime directory and the logs. This story keeps the state and its reason inside the daemon and exposes them; the `daemon.state` event on the software stream and the `daemon.*` commands are DIPO-24. Recovery work (migrations here, reconcile in DIPO-56, re-attach in DIPO-57) plugs in as recovery steps registered with the daemon. References: 0006 decision 7 (states, drain caps of 20 s and 60 s, safe mode, crash counter in `<state>`), decision 6 (clean exit removes `dipo.sock`, then `dipo.pid`), decision 8 (worker hosts keep running across a drain); 0005 section 10 (`engine.recovering`, `scheduling.off`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-68/move-daemon-through-its-lifecycle-states"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) every transition of 0006 decision 7 is accepted and every other transition throws."
    - kind: "automated"
      check: "(integration, CI only) SIGTERM drains, waits for a running child process, and removes `dipo.sock` then `dipo.pid`."
    - kind: "automated"
      check: "(integration) three recorded crashes within 10 minutes on the manual clock start the daemon in `safe`; 10 stable minutes reset the counter."
    - kind: "automated"
      check: "(unit) the office-access predicate reports `engine.recovering` in `starting` and `recovering`, and the scheduling predicate reports `scheduling.off` in `safe`."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The daemon state machine accepts only the transitions of 0006 decision 7, keeps the current state with its reason, and reports each transition as `{ from, to, reason }` to registered listeners.
- [x] #2 `recovering` runs the recovery steps registered by other modules in registration order, database migrations first, then enters `running`, or `safe` when the crash counter requires it.
- [x] #3 SIGTERM, and SIGINT in `--foreground`, enter `draining`: no new work starts, pending writes finish, and the daemon exits within 20 s, or 60 s while workers are being stopped; at the cap it exits anyway.
- [x] #4 On a clean exit the daemon removes `dipo.sock`, then `dipo.pid`, and leaves worker hosts running.
- [x] #5 Before exiting, the daemon waits for every child process it started itself (worker hosts excepted) and kills the process group of any child still running at the drain cap.
- [x] #6 A crash counter in `<state>` counts unclean exits; three within 10 minutes start the next daemon in `safe` with reason "crash loop", and 10 minutes of stable running reset it.
- [x] #7 In `safe` a scheduling predicate reports `scheduling.off` for commands that would schedule work, and a method leaves `safe` for `daemon.resumeScheduling` (DIPO-24) to call.
- [x] #8 In `starting` and `recovering` an office-access predicate reports the retryable `engine.recovering` for office commands and reads.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-23 in the M0 review (DIPO-15). Before cutover: built by hand-run agents.

Added reference packages/engine/test/platform/process.test.ts: the new ChildProcesses tracker (engine/src/platform/process.ts) is tested next to the existing process tests.

Implementation (DIPO-68):
- packages/daemon/src/lifecycle.ts: DaemonLifecycle with the 0006 decision 7 transition table, state and reason, onTransition listeners ({ from, to, reason }), officeAccess() (engine.recovering in starting/recovering), scheduling() (scheduling.off in safe), resumeScheduling() for daemon.resumeScheduling (throws daemon.notSafe outside safe), beginWork()/idle() for pending work.
- packages/daemon/src/recovery.ts: RecoverySteps registry (migrations step always first, then registration order) and runRecovery (recovering -> running, or safe with reason "crash loop"). DIPO-56/57 register through ForegroundOptions.recoverySteps until a feature-level registration exists.
- packages/daemon/src/drain.ts: drain with caps 20 s / 60 s (stopWorkers), waits for pending work and tracked children, SIGKILLs the process groups at the cap. stopWorkers hook is a parameter for DIPO-50/DIPO-24.
- packages/daemon/src/crash-counter.ts: <state>/crashes.json with a running marker (PID + start time) cleared only on a clean exit; a marker left by another process is one crash at the next start.
- packages/engine/src/platform/process.ts: ChildProcesses (spawn detached in its own process group, track, waitAll, killGroups) and killGroup.
- foreground.ts wires it: starting (lock, runtime dir, bind, verify), recovering (migrations), running/safe, draining on SIGTERM/SIGINT or lost lock; cleanup removes dipo.sock then dipo.pid. DaemonIo gained an injected clock.

Interpretations to confirm:
- draining is reachable from starting, recovering and safe as well as running (0006: "SIGTERM always means this graceful drain"); the diagram only shows running -> draining.
- The scheduling predicate also reports scheduling.off in draining ("no new work").
- A drain that hits its cap still exits 0 and clears the crash marker, so stops that hit the cap do not push the daemon into safe; a lost lock exits 1; a failed recovery step exits 1 and counts as a crash.

Review follow-up (PR #32): the crash counter now writes its running marker right after the PID lock is taken, before the runtime-directory choice and the socket bind, so an unclean exit early in starting (exit 1 or a hard kill) counts toward the crash loop; crash-loop.test.ts covers a failure between lock and bind. scheduling() documents that scheduling.off in draining is deliberate and that clients reconnect on daemon.state to draining (DIPO-24). Known edge: in the rare stale-break race the losing starter overwrites the winner's marker before its post-bind re-read, which can count one spurious crash.

Follow-up idea (reviewer, optional): in CrashCounter.open count a foreign marker as a crash only when its PID and start time are no longer alive, which removes the rare spurious crash when two starters race for a stale lock.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Daemon lifecycle: DaemonLifecycle state machine per 0006 decision 7 (draining from every live state), recovery steps with migrations first, crash counter in <state>/crashes.json written right after the PID lock (three crashes in 10 minutes give safe with 'crash loop', 10 stable minutes reset), drain on SIGTERM/SIGINT with 20 s or 60 s caps and process-group SIGKILL of the daemon's own children at the cap, worker hosts untouched, engine.recovering in starting/recovering, scheduling.off in safe and draining, resumeScheduling from safe. Reviewer pass.
<!-- SECTION:FINAL_SUMMARY:END -->
