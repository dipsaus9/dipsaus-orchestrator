---
id: DIPO-230
title: Retry the launch self-test once when its session ran another Bash command
status: To Do
assignee: []
created_date: '2026-10-20 08:20'
updated_date: '2026-10-20 08:20'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/self-test.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/src/workers/claude-cli/adapter.ts
  - packages/daemon/src/runs.ts
  - packages/engine/test/workers/self-test.test.ts
  - packages/engine/test/workers/launch-checks.test.ts
priority: medium
type: bug
ordinal: 230000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one self-test session whose model runs a Bash command other than the planned one no longer holds new runs in every office; the self-test runs once more before it refuses, and the refusal and a warn log line show the command the session ran.

Context: M1a run of 2026-10-20. At about 08:05 UTC a launch of DIPO-163 was refused with "the sandbox self-test could not run: the session's Bash call was not the planned command", which holds the claude-cli adapter in every office (0008 section 7); the next launch passed. The temp daemon log has no line for the refusal. judgeSelfTest in packages/engine/src/workers/claude-cli/self-test.ts refuses when the session made other than one Bash call, when its command is not the planned one, or when its input has other keys; bashCalls returns only the count and two flags, so the refusal does not say what ran. claudeLaunchChecks (launch-checks.ts) runs runSelfTest once with deps.selfTestSessionId; prepare in adapter.ts builds its deps and has no logger, and packages/daemon/src/runs.ts builds the port. DIPO-211 retried the Safe-Chain proxy check's allowed download. The 0008 amendment of 2026-10-15 (DIPO-98) says the exact-command check stays exact "and there is no retry", so a retry needs a 0008 change first. DIPO-181 also changes the self-test's calls; the two stories touch the same files.

```dipo
branch: "DIPO-230/retry-self-test-bash-call"
unknowns:
  - q: "The 0008 amendment of 2026-10-15 (DIPO-98) says the self-test's exact-command check has no retry. Does the maintainer amend 0008 so a session refused only for its Bash calls (not exactly one call, not the planned command, or other input keys) runs once more with a new session id before the launch is refused? (a) Yes: one retry for those reasons only; a verdict where the sandbox let something through, and any other could-not-run reason, refuse at once. (b) No retry: the refusal text and a warn line name the command, and the adapter is held as today. Recommended: (a); the check stays exact, and the retry is a second session under the same run settings."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a first session that runs another command and a second that passes hold nothing, and the second session has its own session id"
    - kind: "automated"
      check: "(unit) two sessions that run other commands hold the adapter with both commands in the detail"
    - kind: "automated"
      check: "(unit) an unsafe first verdict, and a could-not-run verdict for another reason, spawn no second session"
    - kind: "automated"
      check: "(unit) bashCalls returns the commands the session ran, and the warn sink gets one line per refused session with the run, the reason and the commands"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When the self-test verdict is could not run for the Bash calls only (not exactly one call, not the planned command, or input keys other than command, description and timeout), claudeLaunchChecks runs the self-test once more with a session id other than the first's, after the first session's files are removed, and the launch passes when the second session passes
- [ ] #2 A verdict where the sandbox let something through, and every other could-not-run reason, refuse the launch at once with no second session, as today
- [ ] #3 The refusal text for those reasons names each Bash command the session ran, cut to 300 characters each, and how many sessions ran; bashCalls returns the commands
- [ ] #4 Each session refused for its Bash calls writes the warn line "the launch self-test session ran another Bash command" with the run, the reason and the commands, through an optional warn of ClaudeWorkerPortDeps that packages/daemon/src/runs.ts passes
- [ ] #5 Tests in packages/engine/test/workers/launch-checks.test.ts with a fake spawn show a first session with another command and a passing second holding nothing, two such sessions holding the adapter with both commands in the detail, and an unsafe first verdict spawning no second session; tests in packages/engine/test/workers/self-test.test.ts show bashCalls returning the commands
<!-- AC:END -->
