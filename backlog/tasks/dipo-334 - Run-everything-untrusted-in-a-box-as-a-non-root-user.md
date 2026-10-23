---
id: DIPO-334
title: Run everything untrusted in a box as a non-root user
status: Done
assignee: []
created_date: '2026-10-23 13:37'
updated_date: '2026-10-23 16:27'
labels:
  - 'tier:L'
milestone: m-1
dependencies: []
references:
  - '- packages/engine/src/box/'
  - docs/decisions/0021-worker-isolation.md
  - packages/engine/src/box/apple-args.ts
  - packages/engine/src/box/apple-container.ts
  - packages/engine/src/box/build-box.ts
  - packages/engine/src/box/cache.ts
  - packages/engine/src/box/collisions.ts
  - packages/engine/src/box/door.ts
  - packages/engine/src/box/firewall.ts
  - packages/engine/src/box/image.ts
  - packages/engine/src/box/index.ts
  - packages/engine/src/box/port.ts
  - packages/engine/src/box/token-check.ts
  - packages/engine/src/box/user.ts
  - packages/engine/src/box/workers.ts
  - packages/engine/src/workers/claude-cli/box-plan.ts
  - packages/engine/test/box/
  - packages/engine/test/box/apple-container.test.ts
  - packages/engine/test/box/args.test.ts
  - packages/engine/test/box/box-network.ci.test.ts
  - packages/engine/test/box/build-box.test.ts
  - packages/engine/test/box/cache.test.ts
  - packages/engine/test/box/collisions.test.ts
  - packages/engine/test/box/door.test.ts
  - packages/engine/test/box/fake-boxes.ts
  - packages/engine/test/box/firewall.test.ts
  - packages/engine/test/box/image.test.ts
  - packages/engine/test/box/user.test.ts
  - packages/engine/test/box/workers.test.ts
  - packages/engine/test/workers/box-plan.test.ts
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
- [x] #1 The worker's session, its commands, the install and every build install step run as a fixed non-root uid in the box
- [x] #2 The tools mount sits directly under / and every path dipo's privileged commands load from is not writable by that uid
- [x] #3 The capability set of a contained command is an allow list
- [x] #4 A real-box test plants /etc/ld.so.preload, renames the mount's parent and tries an NSS module as the worker and as an install script, then shows the next session's firewall still sets and holds
- [x] #5 The package cache, /work and the Claude Code install work for that uid
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (all 5 criteria met). The real-box test passed in the maintainer session (3 of 3): every plant attempt, as an install script and as the worker, was refused, the files root loads from were unchanged, the firewall holds, and claude runs as the box user. Deviation approved by the maintainer: Debian packages and the Node.js archive install as a root step before any npm code. Follow-up DIPO-336: a smaller allow list for the fixed root steps. A live dipo run as the box user waits for the weekly plan limit to reset.
<!-- SECTION:NOTES:END -->
