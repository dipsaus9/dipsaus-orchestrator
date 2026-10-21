---
id: DIPO-264
title: >-
  Probe whether one Apple container box can be locked down as decision 0021
  requires
status: Refined
assignee: []
created_date: '2026-10-21 09:59'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - tools/box-probe/
  - docs/decisions/0021-worker-isolation.md
priority: high
type: spike
ordinal: 253000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: we know from real attempts whether a box built as decision 0021 describes holds, and if not, exactly which line fails and why.

Context: decision 0021 (DIPO-263) makes this probe the hard gate before anything else of the box design is built (section 16), and decision 11 asks for the token proxy to be probed first. The maintainer installs Apple container; Claude runs the probe by hand with the maintainer watching, since dipo runs are held. Every attempt only checks whether something is reachable or readable; none reads secret contents or sends anything out. Justification for a spike: whether network rules can be enforced outside an Apple container box, and whether a proxy can carry a subscription login, can only be settled by running them.

```dipo
branch: "DIPO-264/box-escape-probe"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A box is built as decision 0021 describes (the code at a start commit with no .git, nothing of the maintainer's inside, SSH forwarding off), with the probe script and box setup under tools/box-probe/
- [ ] #2 Every line of the 0021 escape table is tried from inside the box as root, and each line's command and result are recorded
- [ ] #3 How the network rules are enforced outside the box is written down, or the probe states that they cannot be on Apple container
- [ ] #4 One model request from inside the box goes through a dipo proxy on the Mac that adds the subscription login, and the token is shown to be absent from the box's environment and files; that live request runs only with the maintainer's OK at that moment
- [ ] #5 Box start-up time and memory use are measured
- [ ] #6 docs/decisions/0021-worker-isolation.md gets a dated amendment with the result per table line, the enforcement method and the login outcome
<!-- AC:END -->
