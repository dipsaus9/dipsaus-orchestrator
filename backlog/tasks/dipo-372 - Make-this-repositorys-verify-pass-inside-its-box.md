---
id: DIPO-372
title: Make this repository's verify pass inside its box
status: Refined
assignee: []
created_date: '2026-10-29 09:28'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies: []
references:
  - scripts/ci-light-path.test.ts
  - packages/engine/test/platform/
  - packages/engine/test/box/forwarder.test.ts
  - .dipo/office.yaml
priority: high
type: bug
ordinal: 352000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: bun run verify of this repository passes inside the office's developer box on a clean main, so dipo can deliver this repository's stories.

Found by the cutover run (DIPO-351) on 2026-10-29: run run_01M63FH8VDQ7VFVVGD0BADRF6W of DIPO-366 parked because verify in the box was red on a clean main, with 10 failing tests that pass on the Mac and in CI. scripts/ci-light-path.test.ts (all ci-ok cases exit 127: the box image has no jq); packages/engine/test/platform/process.test.ts and deadline.test.ts (process-group kill: 'kills the whole process group of a child still running', 'ends a detached child that ignores SIGTERM, and its group, with SIGKILL after the grace'); packages/engine/test/box/forwarder.test.ts ('loses nothing of its answer through the forwarder', 'returns an upstream redirect to the box and never requests its target, over loopback TCP'); packages/engine/test/platform/paths.test.ts ('chooseRuntimeDir refuses to start and names the squatted paths when the fallback fails too'). Each needs its cause found in the box: a missing package goes into box.packages of .dipo/office.yaml; a test that assumes the Mac or a CI runner gets fixed or guarded with the reason; a real box limit (for example loopback TCP under the box firewall) is reported, not hidden. 0008 (the box), 0002 (verify in the box).

```dipo
branch: "DIPO-372/verify-green-in-box"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(box) bun run verify passes in this repository's developer box on a clean main"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each of the 10 tests has its cause named in the PR, with the fix: an image package in .dipo/office.yaml, a test that no longer assumes the Mac or a CI runner, or code that works in the box
- [ ] #2 No test is skipped in the box without a written reason, and none of the fixes weakens the box firewall or the box user
- [ ] #3 bun run verify passes inside a developer box built from this repository's office image on a clean main, shown by a real-box run recorded in the PR
<!-- AC:END -->
