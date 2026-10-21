---
id: DIPO-265
title: Run a box on Apple container through one box interface
status: Refined
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 13:44'
labels:
  - 'tier:M'
  - cutover
  - box
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/
  - packages/engine/test/box/
  - packages/engine/src/index.ts
priority: high
type: feature
ordinal: 254000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo has one technology-neutral box interface and an Apple container backend that prepares the host-only box network, creates a box from an image with nothing of the maintainer's attached, copies files in and out, runs a command inside (also a long-running one with stdin and stdout), reads its memory use, and stops, starts and deletes it.

Context: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-265/box-interface"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/engine/src/box/port.ts defines the box interface: network, create, start, stop, delete, copy in, copy out, exec (including a long-running process with stdin and stdout), memory, and a list of dipo's own boxes
- [ ] #2 The Apple container backend implements it through the contract Spawn; every call has a deadline (default 60 s, a long-running exec excepted) and is killed on timeout with the coded error box.timedOut
- [ ] #3 A box joins only a host-only network (any other network mode is refused), and one argument builder never passes --volume, --mount, --ssh, --publish, --publish-socket or --virtualization, shown by a test over every input; --memory and --cpus are set to the Mac's total memory and CPU count (0021 decision 16)
- [ ] #4 A start check refuses with a reason when the container CLI is missing, older than 1.6.0 or its system service is not running
- [ ] #5 Boxes are named dipo-<run id> and carry a dipo label, and the list returns only dipo's boxes
- [ ] #6 Unit tests replay the container CLI with a fake Spawn; one opt-in test (never in CI) runs a real box: start time, copy in and out, exec, files kept after stop and start, delete
<!-- AC:END -->
