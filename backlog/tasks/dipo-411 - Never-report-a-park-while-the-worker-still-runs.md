---
id: DIPO-411
title: Never report a park while the worker still runs
status: Done
assignee: []
created_date: '2026-11-01 15:39'
updated_date: '2026-11-01 17:08'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/hosts.ts
  - packages/engine/src/run/reattach.ts
  - packages/engine/src/run/park-resume.ts
  - packages/engine/src/host/main.ts
  - packages/engine/src/keepawake/activity.ts
  - packages/engine/src/overview/summary.ts
  - packages/engine/test/run/
  - packages/engine/test/host/
priority: high
type: bug
ordinal: 389000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo park` stops the worker, whenever it is sent. A story is parked only when no host and no worker of its run is left, so a park never leaves an orphan that blocks resume and drop.

Found in the M1 hand-test wave of 2026-11-01 on the scratch office (binary 9c7d41238fbc). `dipo park TASK-12` came 0.24 s after the worker host started. The stop intent failed ("worker host socket …/hosts/run_….sock is unreachable"), yet dipo recorded "ended parked" and printed "parked". The worker went on editing README.md; host pid and `claude` were still alive after 50 minutes, past the 45-minute cap, because the cap belongs to a run that had already ended. Then `dipo resume` refused 11 times with "run.hostAlive: … send work.resume again in a moment" (the internal command name, not `dipo resume`; run/park-resume.ts about line 1382), `dipo drop` refused ("A worker host of TASK-12 still runs"), and `dipo status` said "0 active runs" while keep-awake said "held (1 run active)". A park later in the run (TASK-16) worked. The maintainer cleared TASK-12 with a SIGTERM to the host, which stopped its worker in 2 s.

The stop op goes out through `hostSocketSteering.send` in run/hosts.ts, which connects once; only `connectWhenBound` (the launch path) retries "unreachable" up to `HOST_LAUNCH_DEADLINE_MS`. run/control.ts records the stop intent and the exit that resolves it, and the host's own SIGTERM stop is `terminate` in host/main.ts. DIPO-384 parks a host found dead at recovery; this story covers the opposite case, a host found alive for a run that ended. One stop path: the park reuses the stop sequence and the host's SIGTERM stop, no second mechanism (0001). 0005, 0008.

```dipo
branch: "DIPO-411/park-during-startup"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a park sent while the worker host is still starting stops the worker before the run ends parked, and a host left alive for an ended run is stopped"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A park sent while the run's worker host does not answer yet (still starting) keeps trying the stop until the host answers or its launch deadline passes, then stops the worker; the run ends parked only after the worker exited, shown by a test with a real worker host parked within its first second
- [x] #2 When dipo cannot confirm the worker stopped, `dipo park` says so and names what still runs; it never prints `parked` while a host or worker of the run is alive, shown by a test
- [x] #3 A worker host still alive for a run the engine recorded as ended gets SIGTERM from the daemon when re-attach, `dipo resume` or `dipo drop` finds it, only when its PID and start time match its worker_hosts row (`hostAlive`); a host whose PID was reused gets no signal; afterwards the story can be resumed or dropped, shown by a test
- [x] #4 The refusal while a host still runs names `dipo resume <ID>`, not `work.resume`, and while a worker host of a run is alive `dipo status` counts that run as active, shown by a test
<!-- AC:END -->
