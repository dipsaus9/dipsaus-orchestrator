---
id: DIPO-343
title: Run Safe-Chain in a box and remove srt
status: Done
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-28 07:26'
labels:
  - 'tier:L'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/
  - packages/engine/src/platform/
  - packages/engine/src/sandbox/
  - packages/daemon/src/
  - packages/cli/src/index.ts
  - packages/engine/package.json
  - .github/workflows/audit.yml
  - tools/box-probe/
priority: high
type: feature
ordinal: 323000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: Safe-Chain runs in a box of its own behind dipo's web proxy, every registry install goes through it, and the srt sandbox, its package, the sandbox-exec and safe-chain-gate daemon forms and the node-forge audit ignore are gone.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decision of 2026-10-24 (audit question 4): the box is the only sandbox technology (0004, 0008). This story replaces a barrier, so its criteria name what the old barrier caught, the bypass forms and a fail-closed test against the real path (CLAUDE.md, R30). Absorbs DIPO-329. .github/ is the release path, so the maintainer merges this PR by hand.

```dipo
branch: "DIPO-343/safe-chain-in-a-box"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(box, CI on macOS) an install through the Safe-Chain box succeeds and safe-chain-test is refused"
    - kind: "automated"
      check: "(box) the bypass forms and the stopped Safe-Chain box each fail the install"
    - kind: "manual"
      check: "Run tools/box-probe/probe.sh against a developer box and the Safe-Chain box"
      expect: "every line passes"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Safe-Chain runs in a box made from one Safe-Chain image for the whole machine (the pinned Debian base, the box network tools and the official safe-chain-linux-arm64 release binary pinned by sha256, with no npm install, so building it needs no Safe-Chain), that only dipo's web proxy can reach; the box lives as long as dipo's web route, and leftovers are swept at daemon start; and every registry install from a developer, build or cache-fill box goes through it
- [x] #2 What the old barrier caught still fails, each with a test: a registry tunnel that skips Safe-Chain, the package safe-chain-test, and a box reaching another port of the Safe-Chain box
- [x] #3 The bypass forms are tested: a registry alias or CDN name, an IP literal, a TLS handshake naming another host, and a proxy setting changed inside the box
- [x] #4 A fail-closed test against the real path: with the Safe-Chain box stopped, a box install fails and no registry is reached
- [x] #5 @anthropic-ai/sandbox-runtime, packages/engine/src/sandbox/, platform/sandbox.ts, platform/sandbox-exec.ts, platform/mktemp-shim.ts, the sandbox-exec and safe-chain-gate forms and the node-forge ignore in audit.yml are removed
- [x] #6 tools/box-probe/probe.sh passes for a developer box and for the Safe-Chain box
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-27, maintainer: the Safe-Chain box runs from one machine-wide image, not the office image (building an office image needs Safe-Chain, and one Safe-Chain serves every office).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Safe-Chain 1.5.12 runs in a box of its own (dipo-safe-chain-<id>), made from one machine-wide image: Debian slim, the box network tools and the official safe-chain-linux-arm64 binary checked by sha256, with no package install. It lives as long as the web route, and leftovers are swept at daemon start. Only dipo's web proxy reaches it (ports 8101 npm, 8102 PyPI, inbound firewall from the box network host only), and its own traffic leaves through an upstream listener limited to the registries and the malware lists. Registry traffic fails closed when the box is down or dies mid-route. srt, engine/src/sandbox/, the Mac sandbox and Safe-Chain proxy code, the sandbox-exec and safe-chain-gate daemon forms, the srt CI and smoke steps and the node-forge audit ignore are removed. ADR 0008 is rewritten (machine-wide image; the escape probe's root line qualified per the accepted risk of 2026-10-21). The real-path box test runs only with DIPO_TEST_BOX=1; it passed on 2026-10-27 and 2026-10-28, as did probe.sh for a developer box and the Safe-Chain box.
<!-- SECTION:FINAL_SUMMARY:END -->
