---
id: DIPO-418
title: 'Let discard stop an ended run''s host, and name dipo commands in refusals'
status: Refined
assignee: []
created_date: '2026-11-01 18:45'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/discard.ts
  - packages/engine/src/run/park-resume.ts
  - packages/engine/src/run/planning.ts
  - packages/engine/src/records/worker-hosts.ts
  - packages/engine/test/run/
  - packages/engine/test/host/
priority: low
type: bug
ordinal: 396000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo discard` clears a story whose run ended with its worker host still alive, as `dipo resume` and `dipo drop` now do, and every refusal tells the maintainer the `dipo` command to send again, never an internal command name.

Follow-ups of DIPO-411 (#534), 2026-11-01. DIPO-411 made resume and drop send SIGTERM to a host of an ended run through `stopHostsOfEndedRun` (packages/engine/src/records/worker-hosts.ts), only when its PID, start time and command line match its row; packages/engine/src/run/discard.ts still only refuses with `run.hostAlive` while such a host lives. Three refusals still name internal commands: park-resume.ts about line 589 ("send work.resume again once scheduling is back on") and 622 ("send work.resume again with confirmed"), and planning.ts about line 269 ("send story.park again"). The resume refusal that DIPO-411 fixed shows the wording: "Send `dipo resume <ID>` again".

Design: discard calls the same `stopHostsOfEndedRun` before it refuses, one function for resume, drop, discard and re-attach (0001); the typed confirmation stays first, so nothing is signalled before the maintainer confirmed. The three texts name `dipo resume <ID>`, `dipo resume <ID> --yes` for the confirmation and `dipo park <ID> --note <text>`. 0005, 0008, 0009.

```dipo
branch: "DIPO-418/discard-ended-host-and-cli-names"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) discard stops a verified host of an ended run as resume and drop do, and no refusal names an internal command"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After the typed confirmation, `dipo discard` of a story whose run ended with a verified worker host still alive sends that host SIGTERM through `stopHostsOfEndedRun`, refuses with `run.hostAlive` naming the pid, and succeeds once the host exited, shown by a test with a real process
- [ ] #2 A host whose PID was reused, or whose identity cannot be checked, gets no signal from discard, and discard still refuses and says why, shown by a test with a real process
- [ ] #3 The three refusals in park-resume.ts and planning.ts name the `dipo` command to send again (`dipo resume <ID>`, `dipo resume <ID> --yes`, `dipo park <ID> --note <text>`), and no engine refusal text names `work.` or `story.` commands, shown by a test that scans the refusal texts
<!-- AC:END -->
