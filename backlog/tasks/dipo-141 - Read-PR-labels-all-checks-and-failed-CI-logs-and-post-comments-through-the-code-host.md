---
id: DIPO-141
title: >-
  Read PR labels, all checks and failed CI logs, and post comments, through the
  code host
status: Ready
assignee: []
created_date: '2026-10-17 12:51'
updated_date: '2026-10-17 21:14'
labels:
  - 'tier:S'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-115
references:
  - packages/engine/src/platform/host.ts
  - packages/engine/test/platform/
priority: high
type: feature
ordinal: 130000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a new host interface next to PrStateHost reads a PR's labels, every check of a head with its link, a capped failed-job log tail, and posts a PR comment, and a test proves no deployment API is called, so the review loop reaches GitHub only through the engine's code host.

Context: implements ADR 0019 section 7 (logs, auth, the autorelease guard and deployments) and the comment call of section 3. CodeHost has no method that reads labels, check links or CI logs or posts a comment (0019 fact 3); the new calls go on a separate interface so the existing CodeHost fakes stay as they are. 0019 source 5: the gh flags used are checked against the pinned gh floor 2.50.0 by this story.

```dipo
branch: "DIPO-141/code-host-labels-checks-logs-comments"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) with a fake command runner, each new call builds the expected gh argv and parses labels, checks with links and the comment URL"
    - kind: "automated"
      check: "(unit) the log read keeps only the last 1 MiB, stops at 60 seconds, and skips a check link that is not an Actions job"
    - kind: "automated"
      check: "(unit) no gh command built by the code host names deployments or environments"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new interface in packages/engine/src/platform/host.ts, separate from CodeHost, PrStateHost and PrListHost, reads a PR's labels (gh pr view --json labels), lists every check of a head with name, state, bucket, link and workflow, and posts a comment with gh pr comment, returning the comment URL
- [ ] #2 A failed-job log read runs gh run view --job <job> --log-failed only for a GitHub Actions job link, keeps at most the last 1 MiB of output, and stops after 60 seconds
- [ ] #3 A unit test asserts that no gh command the code host builds names deployments or environments
- [ ] #4 Every gh flag the interface uses exists in gh 2.50.0, checked against its manual, and the story's implementation notes record the check
<!-- AC:END -->
