---
id: DIPO-329
title: Drop the node-forge audit ignore once a fixed node-forge ships
status: Refined
assignee: []
created_date: '2026-10-23 10:50'
updated_date: '2026-10-25 09:55'
labels: []
milestone: m-2
dependencies: []
references:
  - .github/workflows/audit.yml
  - bun.lock
priority: low
type: chore
ordinal: 314000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tracking story of the one advisory ignore in .github/workflows/audit.yml (GHSA-86w9-cpqp-85rv). On 2026-10-23 node-forge 1.4.0 is the newest release and has no fix; @anthropic-ai/sandbox-runtime depends on node-forge ^1.4.0.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 audit.yml has no ignore for GHSA-86w9-cpqp-85rv and bun audit --audit-level=high passes
<!-- AC:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-10-25 09:55
---
Dropped on 2026-10-25 (prune plan): DIPO-343 removes the srt sandbox and the node-forge audit ignore with it.
---
<!-- COMMENTS:END -->
