---
id: DIPO-418
title: 'Let discard stop an ended run''s host, and name dipo commands in refusals'
status: Done
assignee: []
created_date: '2026-11-01 18:45'
updated_date: '2026-11-01 19:27'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/discard.ts
  - packages/engine/src/run/park-resume.ts
  - packages/engine/src/run/planning.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/backlog/lane/lane.ts
  - packages/engine/src/office/manager.ts
  - packages/engine/src/records/worker-hosts.ts
  - packages/engine/src/create/commands.ts
  - packages/engine/test/run/
  - packages/engine/test/host/
priority: low
type: bug
ordinal: 396000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo discard` clears a story whose run ended with its worker host still alive, as `dipo resume` and `dipo drop` now do; no refusal names an internal command, and the ones that ask to send again name the `dipo` command.

Follow-ups of DIPO-411 (#534), 2026-11-01. DIPO-411 made resume (park-resume.ts about line 1407) and drop (planning.ts about line 468) send SIGTERM to a host of an ended run through `stopHostsOfEndedRun` (packages/engine/src/records/worker-hosts.ts about line 583), only when its PID, start time and command line match its row. packages/engine/src/run/discard.ts (about lines 178-185, `#liveHostPid`) still only refuses with `run.hostAlive`, and `discardOf` in packages/engine/src/create/commands.ts (about line 260) wires only `probe`, no `SignalProcess` as drop gets. Refusal texts that name internal commands: park-resume.ts about lines 589 ("send work.resume again once scheduling is back on"), 622 ("send work.resume again with confirmed") and 834 ("when work.resume checked it"), planning.ts about 269 ("send story.park again"), backlog/lane/lane.ts about 376 ("park it with `story.park` first"), run/work-run.ts about 398 ("work.run could not index…") and office/manager.ts about 598 ("office.open needs an absolute path"). The resume refusal that DIPO-411 fixed shows the wording: "Send `dipo resume <ID>` again".

Design: discard calls the same `stopHostsOfEndedRun` before it refuses, one function for resume, drop, discard and re-attach (0001); discard's `#liveHostPid` is removed, and discard refuses with drop's text: "A worker host of <ID> still runs, so its box is in use: <hosts>. Send `dipo discard <ID> --note <text>` again in a moment, once the host has exited." The client asks for the typed id before it sends `work.discard` (packages/cli story-commands.ts about line 256: a wrong id sends nothing), so no signal goes out before the maintainer confirmed. The confirmation refusal reads: "Raising <ID>'s caps needs confirmation; send `dipo resume <ID> --budget <amount> --yes` again, or run it at a terminal to be asked." Code comments that name commands stay. 0005, 0008, 0009.

```dipo
branch: "DIPO-418/discard-ended-host-and-cli-names"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) discard stops a verified host of an ended run as resume and drop do, and no engine refusal names an internal command"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `work.discard` of a story whose run ended with a verified worker host still alive sends that host SIGTERM through `stopHostsOfEndedRun`, refuses with `run.hostAlive` in drop's text naming the pid and `dipo discard <ID> --note <text>`, and succeeds once the host exited, shown by a test with a real process
- [x] #2 No engine CommandError or LaneError text names a contract command (`work.`, `story.`, `office.`, `daemon.`); those that ask to send again name the `dipo` command (`dipo resume <ID>`, `dipo resume <ID> --budget <amount> --yes`, `dipo park <ID> --note <text>`), shown by a test that scans those texts in packages/engine/src
- [x] #3 discard's `#liveHostPid` is removed, shown by the diff
- [x] #4 A host whose identity cannot be checked, whose PID and start time match but runs another program, or whose run has not ended gets no signal from discard, and discard refuses and says why; a PID that now belongs to another process (a different start time) counts as a host that is gone, so discard sends nothing and goes on, shown by tests with real processes
<!-- AC:END -->
