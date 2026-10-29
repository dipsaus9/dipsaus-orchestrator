---
id: DIPO-367
title: Pin the box images' Debian base by digest
status: Refined
assignee: []
created_date: '2026-10-28 15:04'
updated_date: '2026-10-29 20:20'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - packages/engine/src/box/image.ts
  - packages/engine/src/box/safe-chain.ts
  - tools/box-probe/
priority: medium
type: chore
ordinal: 347000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the office images and the machine-wide Safe-Chain image start from a Debian slim base pinned by digest, not only by the trixie-slim tag, so a moved tag never changes what a box runs.

From the review of DIPO-343 on 2026-10-27: the Safe-Chain image's base is docker.io/library/debian:trixie-slim (box/safe-chain.ts, box/image.ts BOX_DEFAULTS.debian), a tag rather than a digest, and the office images do the same. 0008 (the image build). Changing the image build runs tools/box-probe/probe.sh again (0008).

```dipo
branch: "DIPO-367/pin-debian-base-digest"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the image build uses debian:<release>-slim@sha256:<digest> by default and the tag hash changes with the digest"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The default Debian base of the office images and the Safe-Chain image is a tag with a pinned sha256 digest, kept in one place, and the image tag hash includes it
- [x] #2 An office that sets its own debian release keeps working, and the image description says whether its base is pinned
- [ ] #3 tools/box-probe/probe.sh passes for a developer box and the Safe-Chain box built from the pinned base, recorded in tools/box-probe/RESULTS.md
- [ ] #4 The image-base check (packages/engine/test/box/args.test.ts and the code it tests) accepts debian:<release>-slim@sha256:<digest> and still refuses other forms, and the Apple container pull of a digest-pinned base is tested
<!-- AC:END -->
