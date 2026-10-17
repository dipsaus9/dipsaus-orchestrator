---
id: DIPO-141
title: >-
  Read PR labels, all checks and failed CI logs, and post comments, through the
  code host
status: Done
assignee: []
created_date: '2026-10-17 12:51'
updated_date: '2026-10-17 22:07'
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
- [x] #1 A new interface in packages/engine/src/platform/host.ts, separate from CodeHost, PrStateHost and PrListHost, reads a PR's labels (gh pr view --json labels), lists every check of a head with name, state, bucket, link and workflow, and posts a comment with gh pr comment, returning the comment URL
- [x] #2 A failed-job log read runs gh run view --job <job> --log-failed only for a GitHub Actions job link, keeps at most the last 1 MiB of output, and stops after 60 seconds
- [x] #3 A unit test asserts that no gh command the code host builds names deployments or environments
- [x] #4 Every gh flag the interface uses exists in gh 2.50.0, checked against its manual, and the story's implementation notes record the check
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Criterion 4, gh 2.50.0 check (maintainer, against the v2.50.0 source on github.com/cli/cli, 2026-10-18): pr view --json labels: 'labels' is in IssueFields, which PullRequestFields appends (api/query_builder.go). pr checks --json name,state,bucket,link,workflow: all five are in prCheckFields (pkg/cmd/pr/checks/checks.go; the full list is name, state, startedAt, completedAt, link, bucket, event, workflow, description). run view --job and --log-failed: both defined in pkg/cmd/run/view/view.go; --repo comes from cmdutil.EnableRepoOverride on the run command (pkg/cmd/run/run.go). pr comment --body: defined in pkg/cmd/pr/comment/comment.go; --repo from EnableRepoOverride on the pr command (pkg/cmd/pr/pr.go). So MIN_GH_VERSION 2.50.0 stays.

Delivery: dipo run run_01M55XPQ4DHJBPZHGHZCSF1SMR (Haiku low, 26 turns, about $0.04, 2 min) wrote the code and tests, then parked blocked asking for this check: gh is denied in the worker and it has no network. Its uncommitted work was copied to DIPO-141/code-host-labels-checks-logs-comments-finish. PrReviewHost (prLabels, prChecks, failedJobLog, commentPr) on GhHost; failedJobLog reads only an Actions job link, keeps the last 1 MiB, stops at 60 s. Verify outside the sandbox: 3174 pass, 2 skip, 0 fail; DIPO_TEST_CI=1 platform tests 95 pass.

Review fix (maintainer side): actionsJobOf(repo, link) accepts only https://github.com/<owner>/<repo>/actions/runs/N/job/M for this repository, so a third-party check's link runs no gh; the no-deployments test now calls all 14 GhHost methods and checks the list against GhHost.prototype; commentPr sends the body on stdin with --body-file - (in gh 2.50.0: pkg/cmd/pr/comment/comment.go defines -F, --body-file, '-' reads standard input), so a long body cannot hit E2BIG; stderr of the log read is capped at 64 KiB; the tail skips a cut UTF-8 character. Verify after the fix: 3176 pass, 2 skip, 0 fail; DIPO_TEST_CI=1 platform 97 pass.
<!-- SECTION:NOTES:END -->
