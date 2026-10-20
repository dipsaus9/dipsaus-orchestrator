---
id: DIPO-231
title: >-
  Make the launch self-test fail when the CLI denies an approval call before
  dipo decides
status: Parked
assignee: []
created_date: '2026-10-20 08:42'
updated_date: '2026-10-20 17:18'
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
park:
  reason: "verify-failing"
  from: "In Progress"
  note: "Verify failed at the verify step.\nCommand: bun run verify\nExit code: 1\nLocations:\n- packages/testkit/src/git.ts:90:36\n- packages/engine/test/worktree/setup.test.ts:58:29\n- packages/engine/test/worktree/setup.test.ts:307:27\n- packages/testkit/src/git.ts:156:23\n- packages/engine/test/git/helpers.ts:53:26\n- packages/engine/test/git/office-git.test.ts:182:13\nLast output lines:\n[dipo: showing the last 41 of 4,916 output lines.]\n(pass) FakeProcess > records stdin writes and the close [0.07ms]\n(pass) FakeProcess > writes a partial line without a newline [0.10ms]\n(pass) FakeProcess > replays stdout, stderr, hooks and the exit, moving the clock by recorded deltas [0.22ms]\n(pass) FakeProcess > ends with exit 143 and no result on SIGTERM [0.06ms]\n(pass) FakeProcess > jumps to the recorded post-interrupt tail on SIGINT [0.10ms]\n(pass) FakeProcess > is a contract ChildProcess handed out by an injected Spawn [0.05ms]\n\npackages/testkit/src/listener-guard.test.ts:\n(pass) the uncaught-error listener guard > sees a listener a test leaves on the real process [0.04ms]\n(pass) the uncaught-error listener guard > is preloaded for every test [0.09ms]\n(pass) the uncaught-error listener guard > reports a changed listener count and nothing when the counts are back [0.02ms]\n\n10 tests skipped:\n(skip) a test daemon's runtime directory > stays under the test's temp directory when DIPO_RUNTIME_DIR is unusable\n(skip) a test daemon's runtime directory > is its DIPO_RUNTIME_DIR on darwin for the longest temp root testkit accepts\n(skip) a test daemon's runtime directory > is its DIPO_RUNTIME_DIR on linux for the longest temp root testkit accepts\n(skip) (unit) the gate on local sockets > forwards a registry CONNECT to that ecosystem's Safe-Chain and refuses the rest\n(skip) the merge slot on GitHub > waits for ci-ok and pr-title, then squash-merges the backlog PR without a reviewer\n(skip) the backlog PR on GitHub > opens a chore(backlog) PR whose pr-title check passes and whose structural check passes\n(skip) withTempDir > uses $DIPO_TMP when set and /tmp otherwise\n(skip) withTempDir > keeps the directory when DIPO_TEST_KEEP=1\n(skip) the temp root limit (DIPO-109) > accepts a temp root of exactly the longest length, and refuses one byte more\n(skip) system probe > reads the same as /bin/ps on macOS: live, child and zombie\n\n\n3 tests failed:\n(fail) (engine) the review kind's launch checks (DIPO-145, 0019 section 4) > holds the adapter when the worktree took the self-test's write [130561.28ms]\n  ^ this test timed out after 5000ms.\n(fail) setting up a worktree > copies files, takes slot 1 and runs install, setup and post_create in order with the run environment [28052.69ms]\n  ^ this test timed out after 5000ms.\n(fail) the worktree root > is refused inside the main checkout [499485.86ms]\n  ^ this test timed out after 5000ms.\n\n --seed=4245707292\n 4069 pass\n 10 skip\n 3 fail\n 2 errors\n 29895 expect() calls\nRan 4082 tests across 368 files. [804.72s]\nerror: script \"verify\" exited with code 1"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The self-test session makes, after its planned probe command, one more planned Bash call, exactly `cd .; ls`, which asks for approval under the run settings and writes no file; a short-lived host-protocol stand-in at the session's DIPO_HOST_SOCKET answers that call's PermissionRequest with a deny carrying a fixed self-test reason, and the judge accepts a session with exactly these two planned calls
- [ ] #2 The self-test refuses the launch as could not run, with its own probe key, when the approval call's tool result does not hold dipo's self-test reason, when the session's stdout holds a permission_denied event with the CLI's no approval surface text, or when no PermissionRequest for that call reached the stand-in (inconclusive, since the CLI's ask list can change between versions, and never a pass), and the refusal holds the adapter as every failed launch check does; unit tests in packages/engine/test/workers/self-test.test.ts cover each case and the pass
- [ ] #3 The shared self-test fixture in packages/engine/test/workers/launch-fixtures.ts replays the two-call session, and every test that replays a passing self-test (skills.test.ts, launch-checks.test.ts, adapter.test.ts) passes with it
<!-- AC:END -->
