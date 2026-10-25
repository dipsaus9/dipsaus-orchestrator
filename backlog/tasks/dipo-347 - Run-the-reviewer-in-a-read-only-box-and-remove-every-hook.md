---
id: DIPO-347
title: Run the reviewer in a read-only box and remove every hook
status: Refined
assignee: []
created_date: '2026-10-25 09:51'
labels:
  - 'tier:M'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-343
references:
  - packages/engine/src/box/
  - packages/engine/src/run/
  - packages/engine/src/review/
  - packages/engine/src/workers/claude-cli/
  - packages/engine/src/hooks/
  - packages/daemon/src/
  - packages/cli/src/index.ts
priority: high
type: feature
ordinal: 327000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each review session runs in a read-only box of its own with a git archive copy of the pushed head and no box.files, its web traffic goes through the box web proxy, and dipo registers no hooks anywhere: dipo hook, the hook relay and the web guard are removed.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decision of 2026-10-24 (audit section 12, item 3; 0002, 0008, 0004). This story replaces a barrier, so its criteria name what the old barrier caught, the bypass forms and a fail-closed test against the real path (CLAUDE.md, R30).

```dipo
branch: "DIPO-347/reviewer-box-no-hooks"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(box) a review runs in its own box, returns a verdict and leaves no box behind"
    - kind: "automated"
      check: "(box) each bypass form fails and a missing firewall stops the review before it starts"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A review session starts in a new box from the office image with the head's git archive copy, the firewall, the box user and the proxies, and the box is deleted when the session ends
- [ ] #2 What the old barrier caught still fails, each with a test: the reviewer box holds no value from box.files, a write to the copy fails, and the reviewer reaches no service of the Mac
- [ ] #3 The bypass forms are tested: a symlink in the copy that points outside it, a shell or write tool asked for in the session, and a proxy setting changed in the box
- [ ] #4 A fail-closed test against the real path: with the reviewer box's firewall missing, the review does not start
- [ ] #5 dipo hook, the host socket hook relay, the PreToolUse web guard, hooks/web-guard.ts and every hook setting are removed
<!-- AC:END -->
