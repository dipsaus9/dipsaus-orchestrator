---
id: DIPO-334
title: Run everything untrusted in a box as a non-root user
status: Refined
assignee: []
created_date: '2026-10-23 13:37'
labels:
  - 'tier:L'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/
  - packages/engine/test/box/
priority: high
type: feature
ordinal: 316000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the worker, the install steps and the image build's install steps run as a non-root user in every box, so /etc, /opt and the tools mount cannot be written and dipo's privileged commands cannot be redirected; dipo's own trusted steps (bootstrap, firewall) stay root.

Context: the DIPO-281 review findings. A worker that is root in its box can redirect dipo's privileged commands, which start through the dynamic loader: through /etc/ld.so.preload, and through a renamed /opt that lets a planted loader run in place of the mounted one. An install script during the image build can plant the same into the image. The contained command's capabilities are a deny list over a set the backend chooses; prefer an allow list. Until this story is done, the in-box firewall of DIPO-281 stops accidental direct connections, not a root worker (0021 amendment of 2026-10-23).

```dipo
branch: "DIPO-334/non-root-box-user"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) every exec argv of the worker session, its commands, the box install and each build install step sets the fixed non-root uid; the bootstrap and the firewall stay root"
    - kind: "automated"
      check: "(unit) the contained command's capability set is an allow list, and the tools mount sits directly under /"
    - kind: "automated"
      check: "(unit) the package cache, /work and the Claude Code install are readable or writable for the non-root uid as each needs"
    - kind: "manual"
      check: "(real box, box-network.ci.test.ts) as the worker and as an install script: plant /etc/ld.so.preload, rename the mount's parent, try an NSS module; the next session's firewall still sets and holds"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The worker's session, its commands, the install and every build install step run as a fixed non-root uid in the box
- [ ] #2 The tools mount sits directly under / and every path dipo's privileged commands load from is not writable by that uid
- [ ] #3 The capability set of a contained command is an allow list
- [ ] #4 A real-box test plants /etc/ld.so.preload, renames the mount's parent and tries an NSS module as the worker and as an install script, then shows the next session's firewall still sets and holds
- [ ] #5 The package cache, /work and the Claude Code install work for that uid
<!-- AC:END -->
