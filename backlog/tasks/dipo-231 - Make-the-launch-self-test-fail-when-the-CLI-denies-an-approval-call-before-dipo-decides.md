---
id: DIPO-231
title: >-
  Make the launch self-test fail when the CLI denies an approval call before
  dipo decides
status: Done
assignee: []
created_date: '2026-10-20 08:42'
updated_date: '2026-10-20 19:00'
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
  - packages/engine/src/workers/claude-cli/adapter.ts
priority: medium
type: feature
ordinal: 231000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the launch self-test catches the failure DIPO-181 fixes: its session makes one planned Bash call that needs approval under the run settings, dipo answers that call's PermissionRequest with a fixed deny, and the launch is refused when the CLI denied the call on its own before dipo's decision arrived.

Context: split from DIPO-181 by the PR #256 review (2026-10-20). Today the self-test (packages/engine/src/workers/claude-cli/self-test.ts) runs with hookRelay false and one planned Bash call built so the permission layer does not stop it, so it never meets a PermissionRequest. It is spawned with no worker host, and its DIPO_HOST_SOCKET (plan.ts) names the run's host socket, which nothing binds before launch, so the self-test needs a short-lived host-protocol stand-in that answers non-waiting hooks with no output and the approval PermissionRequest with the self-test deny. The approval call is `cd .; ls`: in the 2026-10-20 probe (9 Haiku sessions on Claude CLI 2.1.304 with a real worker's run settings and argv) it asked 4 of 4 times, because cd names a path computed at run time that the permission layer cannot check against the read block, and it writes nothing even when allowed; earlier compound commands ran with no ask. The CLI's ask list can change between versions, so a session whose call never reached dipo is inconclusive and refuses the launch, never passes it. When the CLI denies the call on its own, its permission_denied text reads 'no approval surface in this session; permission request denied automatically'; the judge matches the substring 'no approval surface'. claudeWorkerPort in packages/engine/src/workers/claude-cli/adapter.ts picks the launch-check seams (launchCheckSeams) the self-test runs with. The shared fixture packages/engine/test/workers/launch-fixtures.ts (selfTestSession) and packages/engine/test/workers/skills.test.ts replay the one-call session today. The 0008 section 2 note of 2026-10-20 (DIPO-231) records the approval call, dipo's fixed deny and the refusal that holds the adapter, as DIPO-98 recorded its probes.

```dipo
branch: "DIPO-231/self-test-approval-call"
unknowns:
  - q: "Which Bash command asks for approval under the run settings with the sandbox on, so the self-test's approval call is sure to reach the PermissionRequest hook? (a) find one with a recorded probe under the pinned CLI and the run settings, and name it in this story (recommended); (b) let the self-test pick from a short list and pass on the first that asks."
    status: "resolved"
    answer: "A (probe, 2026-10-20, 9 Haiku sessions on Claude CLI 2.1.304 with a copy of a real worker's claude-settings.json and plan.ts argv, files in scratchpad probe-231/): the self-test's approval call is `cd .; ls`. It asked 4 of 4 times in the cd form (reason: cd names a path computed at run time, which cannot be checked against the read block that blockReadsOutsideWorkingDirectories sets), needs no file, and writes nothing even when allowed. `sed -i` also asks but would write; a heredoc append and `ls | sed -n 1p` did not ask. The CLI's ask list can change between versions, so a session where no PermissionRequest reached dipo counts as could-not-run (inconclusive), not as a pass."
  - q: "The maintainer records a dated 0008 section 2 note for the approval-call probe and its hold reason (as DIPO-98 did for its probes)."
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): the 0008 section 2 note of 2026-10-20 (DIPO-231) records it: the self-test also makes one planned Bash call that needs approval, which dipo denies through its PermissionRequest hook with a fixed reason; a launch whose call the CLI denied on its own before dipo's decision, or whose call never reached dipo, is refused and holds the adapter."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the self-test plans the probe call and the approval call cd .; ls, the stand-in host answers the approval call's PermissionRequest with the self-test deny, and the judge passes a session with exactly these two calls"
    - kind: "automated"
      check: "(unit) the self-test refuses as could not run a session whose approval call got the CLI's no approval surface deny, whose tool result lacks dipo's reason, or whose approval call never reached dipo (inconclusive, not a pass), and the adapter stays held"
    - kind: "manual"
      check: "(live) on the scratch repo, launch a story on the pinned CLI"
      expect: "the launch self-test passes with its two planned calls"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The self-test session makes, after its planned probe command, one more planned Bash call, exactly `cd .; ls`, which asks for approval under the run settings and writes no file; a short-lived host-protocol stand-in at the session's DIPO_HOST_SOCKET answers that call's PermissionRequest with a deny carrying a fixed self-test reason, and the judge accepts a session with exactly these two planned calls
- [x] #2 The self-test refuses the launch as could not run, with its own probe key, when the approval call's tool result does not hold dipo's self-test reason, when the session's stdout holds a permission_denied event with the CLI's no approval surface text, or when no PermissionRequest for that call reached the stand-in (inconclusive, since the CLI's ask list can change between versions, and never a pass), and the refusal holds the adapter as every failed launch check does; unit tests in packages/engine/test/workers/self-test.test.ts cover each case and the pass
- [x] #3 The shared self-test fixture in packages/engine/test/workers/launch-fixtures.ts replays the two-call session, and every test that replays a passing self-test (skills.test.ts, launch-checks.test.ts, adapter.test.ts) passes with it
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5D2Z8VPHBCNJ32DNYXQVQ9M (Sonnet, 146 turns, about $2.93, 14 min) reported done, but dipo's own verify failed during the Mac's sleep stalls, so the run parked verify-failing with the work uncommitted; finished by hand (files copied read-only, unchanged on main since the base). One denied call (a cd compound). The launch self-test makes, after its probe, one more planned Bash call, `cd .; ls`; a short-lived host-protocol stand-in answers that call's PermissionRequest with a deny carrying a fixed self-test reason, and the judge passes only a session with exactly those two calls and dipo's reason in the tool result. It refuses as could not run (probe key approval, adapter held) when the CLI denied the call itself (no approval surface), when the tool result lacks dipo's reason, or when no PermissionRequest reached the stand-in; an absent approval field refuses too. The shared fixture replays the two-call session. Fixed on top after review: the stand-in binds the self-test's own socket (<run>.self next to <run>.sock), so a resume's ending host cannot remove it and cause a false refusal; doc comment order. Live check (test binary from this branch): the worker launch of DIPO-183 passed the new self-test on the pinned CLI, so the CLI copies the hook deny into the tool result. Not yet checked live: a reviewer launch, since review sessions cannot start at all today (bun not on the reviewer's PATH, a separate story). Advisory, not done: tools/recordings/scenarios.ts still captures one call (DIPO-244); the self-test verdict is not kept in the run dir (DIPO-245). Verify outside the sandbox: the story's tests pass (129), lint, tsc and format clean; full local verify only stalled on unrelated tests during machine sleep, CI is the gate.
<!-- SECTION:NOTES:END -->
