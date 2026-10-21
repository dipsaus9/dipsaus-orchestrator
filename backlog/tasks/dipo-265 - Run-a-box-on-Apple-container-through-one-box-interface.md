---
id: DIPO-265
title: Run a box on Apple container through one box interface
status: In Review
assignee: []
created_date: '2026-10-21 13:44'
updated_date: '2026-10-21 14:20'
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
- [x] #1 packages/engine/src/box/port.ts defines the box interface: network, create, start, stop, delete, copy in, copy out, exec (including a long-running process with stdin and stdout), memory, and a list of dipo's own boxes
- [x] #2 The Apple container backend implements it through the contract Spawn; every call has a deadline (default 60 s, a long-running exec excepted) and is killed on timeout with the coded error box.timedOut
- [x] #3 A start check refuses with a reason when the container CLI is missing, older than 1.6.0 or its system service is not running
- [x] #4 Boxes are named dipo-<run id> and carry a dipo label, and the list returns only dipo's boxes
- [x] #5 Unit tests replay the container CLI with a fake Spawn; one opt-in test (never in CI) runs a real box: start time, copy in and out, exec, files kept after stop and start, delete
- [x] #6 A box joins only a host-only network (any other network mode is refused); one argument builder passes exactly one mount, the office package cache of DIPO-267, always read-only (0021 section 5), and never any other --volume or --mount, nor --ssh, --publish, --publish-socket or --virtualization, shown by a test over every input; --memory and --cpus are set to the Mac's total memory and CPU count (0021 decision 16)
<!-- AC:END -->
