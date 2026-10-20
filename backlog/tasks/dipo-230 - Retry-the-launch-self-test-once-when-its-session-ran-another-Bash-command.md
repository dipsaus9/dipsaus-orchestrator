---
id: DIPO-230
title: Show the Bash command a refused launch self-test session ran
status: In Review
assignee: []
created_date: '2026-10-20 08:20'
updated_date: '2026-10-20 14:00'
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
Outcome: when the launch self-test refuses a launch because its session ran a Bash command other than the planned one, the refusal and a warn log line show the command the session ran, so a one-off model slip can be told from a real sandbox problem; the check stays exact with no retry (0008 amendment of 2026-10-15, DIPO-98), and naming the story again (`dipo run <ID>`) repeats the checks.

Context: M1a run of 2026-10-20. At about 08:05 UTC a launch of DIPO-163 was refused with "the sandbox self-test could not run: the session's Bash call was not the planned command", which holds the claude-cli adapter in every office (0008 section 7); the next launch passed. The temp daemon log has no line for the refusal. judgeSelfTest in packages/engine/src/workers/claude-cli/self-test.ts refuses when the session made other than one Bash call, when its command is not the planned one, or when its input has other keys; bashCalls returns only the count and two flags, so the refusal does not say what ran. claudeLaunchChecks (launch-checks.ts) runs runSelfTest once with deps.selfTestSessionId; prepare in adapter.ts builds its deps and has no logger, and packages/daemon/src/runs.ts builds the port. DIPO-211 retried the Safe-Chain proxy check's allowed download. The 0008 amendment of 2026-10-15 (DIPO-98) says the exact-command check stays exact "and there is no retry", so a retry needs a 0008 change first. DIPO-181 also changes the self-test's calls; the two stories touch the same files.

```dipo
branch: "DIPO-230/show-self-test-bash-call"
unknowns:
  - q: "Does the self-test run once more before it refuses a launch for its Bash calls?"
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): no retry. The exact-command check stays as 0008 (DIPO-98) says; the refusal and a warn line show the command the session ran, and `dipo run <ID>` repeats the checks."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a session that runs another command refuses the launch with that command in the detail, and no second session is spawned"
    - kind: "automated"
      check: "(unit) bashCalls returns the commands the session ran, cut to 300 characters each"
    - kind: "automated"
      check: "(unit) the warn sink gets one line for the refused session with the run, the reason and the commands, and none for a passing session"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A self-test verdict of could not run for the Bash calls (not exactly one call, not the planned command, or input keys other than command, description and timeout) still refuses the launch at once with no second session, as 0008's DIPO-98 amendment says
- [x] #2 The refusal text for those reasons names each Bash command the session ran, cut to 300 characters each; bashCalls in packages/engine/src/workers/claude-cli/self-test.ts returns the commands
- [x] #3 A session refused for its Bash calls writes the warn line "the launch self-test session ran another Bash command" with the run, the reason and the commands, through an optional warn of ClaudeWorkerPortDeps that packages/daemon/src/runs.ts passes
- [x] #4 Tests in packages/engine/test/workers/launch-checks.test.ts with a fake spawn show a session with another command refusing with that command in the detail and spawning no second session, and the warn line; tests in packages/engine/test/workers/self-test.test.ts show bashCalls returning the commands
<!-- AC:END -->
