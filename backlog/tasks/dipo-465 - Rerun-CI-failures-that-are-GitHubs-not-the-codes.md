---
id: DIPO-465
title: 'Rerun CI failures that are GitHub''s, not the code''s'
status: Refined
assignee: []
created_date: '2026-11-08 12:17'
updated_date: '2026-11-08 12:35'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/src/story-pr/checks.ts
  - packages/engine/src/platform/host.ts
  - packages/engine/test/platform/host.test.ts
  - packages/engine/src/prompts/feedback.ts
  - packages/engine/src/records/caps.ts
  - docs/decisions/0002-review-and-testing.md
priority: medium
type: enhancement
ordinal: 438000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to rerun a red CI check that failed because of GitHub rather than the code, so that a story does not park on outages its worker cannot fix.

M3 (maintainer's choice, 2026-11-08). The trigger: DIPO-463 parked verify-failing after 2 red CI heads of PR #624 that were GitHub HTTP 504 errors while downloading actionlint and the CodeQL bundle, not test failures; both counted toward the CI cap of 2 (0002).

Today a red head (packages/engine/src/story-pr/prs.ts) reads each failed Actions job log once (failedJobLog in packages/engine/src/platform/host.ts), builds the CI feedback items (packages/engine/src/prompts/feedback.ts), counts a CI attempt (ciAttempts, packages/engine/src/records/caps.ts) and parks verify-failing at the cap.

The fix: code classifies each failed required check from its job's failing step and log tail, with no model. Infrastructure is a download or HTTP 5xx error from GitHub or a tool host, a lost runner, or a rate limit; anything else, a log that cannot be read, and a check that is not an Actions job count as the code's (fail closed). The tests read log fixtures committed from DIPO-463's real red heads (the 504 downloads of actionlint and the CodeQL bundle, taken with gh run view --log-failed), not hand-written strings. An aggregate check such as ci-ok that failed only because other jobs of its run failed takes those jobs' class, as the log read already explains them.

When every failed required check of a head is infrastructure, dipo reruns the failed jobs through a new GitHub host method that runs gh run rerun with the run id and --failed (GhHost in packages/engine/src/platform/host.ts), tested through that real host path with the spawn stub the host tests use (packages/engine/test/platform/host.test.ts), not only a fake host. dipo then watches the head again, up to 2 reruns per head, with no CI attempt and no fix round; each rerun is a run step and a notice to the maintainer. Rerunning the failed jobs reruns the failed ci-ok aggregate with them, since it needs them: the head is final again only once ci-ok is final, a ci-ok that fails again because a rerun job failed again takes that job's class, and a third infrastructure red on the same head counts as today. Any test, lint, type or other failure counts as today.

ADR 0002 gets the rerun and one Replaced line.

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-465/rerun-infrastructure-ci-failures"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the classifier marks the committed log fixtures of DIPO-463's red heads (HTTP 504 downloads of actionlint and the CodeQL bundle) as infrastructure, and test, lint and type failures as code"
    - kind: "automated"
      check: "(unit) an unmatched failure, an unreadable log and a check that is not an Actions job are classified as code"
    - kind: "automated"
      check: "(unit) an aggregate check that failed only because other jobs of its run failed takes the class of those jobs, also when it fails again after a rerun"
    - kind: "automated"
      check: "(unit) the new GhHost rerun method runs gh run rerun with the run id and --failed through the host's spawn path, with its argv checked as the failed-log read is"
    - kind: "automated"
      check: "(unit) a head whose failed required checks are all infrastructure is rerun, watched again until its ci-ok aggregate is final, recorded as a run step and told in a notice, at most 2 times per head"
    - kind: "automated"
      check: "(unit) a rerun counts no CI attempt and starts no fix round; a head with any code failure, or a third infrastructure red, counts an attempt and starts a fix round"
    - kind: "manual"
      check: "On the scratch repository with a Haiku office, add a required workflow step that prints an HTTP 504 download error and exits 1 on its first attempt, then run a story to its PR"
      expect: "dipo watch shows a rerun notice for the head, the PR's check shows a second attempt, and dipo status shows no CI attempt counted for the story"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Code classifies each failed required check of a red head as infrastructure or code from its job's failing step and log tail, with no model; the patterns for download or HTTP 5xx errors, a lost runner and a rate limit are named in code, and the tests use log fixtures committed from DIPO-463's real red heads (the HTTP 504 downloads of actionlint and the CodeQL bundle), not hand-written strings
- [ ] #2 A failure that matches no pattern, a log that cannot be read and a check that is not a GitHub Actions job count as the code's
- [ ] #3 An aggregate check that failed only because other jobs of its run failed takes the class of those jobs; a rerun of the failed jobs reruns the failed ci-ok aggregate with them, the head is final again only once ci-ok is final, and a ci-ok that fails again because a rerun job failed again takes that job's class
- [ ] #4 The rerun goes through a new GitHub host method that runs gh run rerun with the run id and --failed, tested through the real host path with the host tests' spawn stub, not only a fake host
- [ ] #5 When every failed required check of a head is infrastructure, dipo reruns the failed jobs of their runs and watches the head again, up to 2 reruns per head, recording each rerun as a run step and a notice to the maintainer
- [ ] #6 A rerun counts no CI attempt and starts no fix round, while a red head with any code failure, or a third infrastructure red on the same head, counts a CI attempt and starts a fix round as today
- [ ] #7 ADR 0002 says that infrastructure failures are rerun and do not count toward the CI cap, with one Replaced line
<!-- AC:END -->
