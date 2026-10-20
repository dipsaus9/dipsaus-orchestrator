---
id: DIPO-231
title: >-
  Make the launch self-test fail when the CLI denies an approval call before
  dipo decides
status: To Do
assignee: []
created_date: '2026-10-20 08:42'
updated_date: '2026-10-20 08:42'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-181
references:
  - packages/engine/src/workers/claude-cli/self-test.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/test/workers/self-test.test.ts
  - packages/engine/test/workers/launch-checks.test.ts
  - packages/engine/test/workers/launch-fixtures.ts
  - packages/engine/test/workers/skills.test.ts
  - packages/engine/test/run/adapter.test.ts
priority: medium
type: feature
ordinal: 231000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the launch self-test catches the failure DIPO-181 fixes: its session makes one planned Bash call that needs approval under the run settings, dipo answers that call's PermissionRequest with a fixed deny, and the launch is refused when the CLI denied the call on its own before dipo's decision arrived.

Context: split from DIPO-181 by the PR #256 review (2026-10-20). Today the self-test (packages/engine/src/workers/claude-cli/self-test.ts) runs with hookRelay false and one planned Bash call built so the permission layer does not stop it, so it never meets a PermissionRequest. It is spawned with no worker host, and its DIPO_HOST_SOCKET (plan.ts) names the run's host socket, which nothing binds before launch, so the self-test needs a short-lived host-protocol stand-in that answers non-waiting hooks with no output and the approval PermissionRequest with the self-test deny. The approval command must be shown to ask under the run settings with the sandbox on: in the 2026-10-20 probe the compound commands tried with dipo's sandbox settings ran with no ask. The shared fixture packages/engine/test/workers/launch-fixtures.ts (selfTestSession) and packages/engine/test/workers/skills.test.ts replay the one-call session today. Adding a self-test call and a hold reason under 0008 section 2 is the kind of change DIPO-98 recorded as a dated 0008 amendment, so the maintainer records that note before this story goes Ready.

```dipo
branch: "DIPO-231/self-test-approval-call"
unknowns:
  - q: "Which Bash command asks for approval under the run settings with the sandbox on, so the self-test's approval call is sure to reach the PermissionRequest hook? (a) find one with a recorded probe under the pinned CLI and the run settings, and name it in this story (recommended); (b) let the self-test pick from a short list and pass on the first that asks."
    status: "open"
  - q: "The maintainer records a dated 0008 section 2 note for the approval-call probe and its hold reason (as DIPO-98 did for its probes)."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the self-test plans the probe call and one approval call, the stand-in host answers the approval call's PermissionRequest with the self-test deny, and the judge passes a session with exactly these two calls"
    - kind: "automated"
      check: "(unit) the self-test refuses a session whose approval call got the CLI's no approval surface deny, whose tool result lacks dipo's reason, or whose approval call never reached dipo"
    - kind: "manual"
      check: "(live) on the scratch repo, launch a story on the pinned CLI"
      expect: "the launch self-test passes with its two planned calls"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The self-test session makes, after its planned probe command, one more planned Bash call that needs approval under the run settings and writes no file; a short-lived host-protocol stand-in at the session's DIPO_HOST_SOCKET answers that call's PermissionRequest with a deny carrying a fixed self-test reason, and the judge accepts a session with exactly these two planned calls
- [ ] #2 The self-test refuses the launch as could not run, with its own probe key, when the approval call's tool result does not hold dipo's self-test reason, when the session's stdout holds a permission_denied event with the CLI's no approval surface text, or when no PermissionRequest for that call reached the stand-in; unit tests in packages/engine/test/workers/self-test.test.ts cover each case and the pass
- [ ] #3 The shared self-test fixture in packages/engine/test/workers/launch-fixtures.ts replays the two-call session, and every test that replays a passing self-test (skills.test.ts, launch-checks.test.ts, adapter.test.ts) passes with it
<!-- AC:END -->
