---
id: DIPO-250
title: Give review sessions the worker's readable PATH and a closed shell snapshot
status: Done
assignee: []
created_date: '2026-10-20 19:03'
updated_date: '2026-10-20 21:16'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-183
  - DIPO-231
references:
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/workers/claude-cli/self-test.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/self-test.test.ts
  - packages/engine/test/workers/launch-checks.test.ts
priority: high
type: bug
ordinal: 136000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a review session on a machine with the official Safe-Chain install gets the PATH a worker gets, with the entries its sandbox cannot read left out, and the CLI's shell snapshot closed, so bun resolves in the reviewer sandbox and the reviewer's launch self-test can pass, while the reviewer still has no Safe-Chain proxy and no install.

Context: confirmed on 2026-10-20 on the temp office: every dipo review round's launch self-test failed with "`bun add` exited 127 inside the reviewer sandbox: bun was not found on the reviewer's PATH" (INSTALL_CANNOT_RUN in packages/engine/src/workers/claude-cli/self-test.ts), 49 failed starts across six stories. Cause: kindContext in packages/engine/src/workers/claude-cli/plan.ts drops the Safe-Chain context for a review ("no Safe-Chain proxy, since a reviewer installs nothing"), and the sandbox's denyRead adds the CLI's shell snapshot directory only when ctx.safeChain is set. Two things then give the reviewer's Bash its PATH: the PATH the plan passes through from the daemon (ENV_ALLOWLIST), and the shell snapshot the CLI built from the maintainer's login shell. That PATH starts with a Safe-Chain wrapper directory outside the sandbox's read paths, whose bun is a link to a wrapper script the sandbox cannot read, so bun cannot be resolved. Workers do not hit this: detectSafeChain (packages/engine/src/workers/claude-cli/safe-chain.ts) builds a PATH that leaves out entries the sandbox cannot read at all and moves to the end the entries whose wrapped command points where it cannot read (~/.bun/bin is demoted, not dropped), the Safe-Chain shell sets that PATH, and the snapshot stays closed; a zsh login shell runs path_helper from /etc/zprofile, which is why DIPO-107 gave the worker's shell its own .zprofile. kindContext is also called by self-test.ts (the reviewer self-test's workerPath is ctx.env PATH without Safe-Chain) and launch-checks.ts; keeping ctx.safeChain set for a review would start a Safe-Chain proxy for the reviewer and run the Safe-Chain installs, against 0019 section 4. So a review keeps ctx.safeChain undefined and carries the detected PATH and one flag that closes the snapshot. The self-test test "Safe-Chain on the machine changes nothing for a reviewer" in packages/engine/test/workers/self-test.test.ts changes with this. Only a live review start proves bun resolves. The failed-start retry and the hold scope are DIPO-257.

```dipo
branch: "DIPO-250/reviewer-path"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) plan.test.ts: with Safe-Chain detected, a review plan's env PATH is the detected PATH (dropped entries out, demoted entries at the end), its denyRead holds the shell snapshot directory, and it has no CLAUDE_CODE_SHELL, no Safe-Chain proxy port and REVIEW_NETWORK; without Safe-Chain the review plan is unchanged"
    - kind: "automated"
      check: "(unit) self-test.test.ts: the reviewer self-test with Safe-Chain detected uses the detected PATH as its workerPath, runs no Safe-Chain install and starts no proxy"
    - kind: "automated"
      check: "(unit) launch-checks.test.ts: a reviewer launch with Safe-Chain detected starts no Safe-Chain proxy"
    - kind: "manual"
      check: "(live) on this repo, let a story reach In Review on the temp office so its review round starts"
      expect: "the reviewer's launch self-test passes, bun resolves in the reviewer sandbox, and a reviewer session starts"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 kindContext in packages/engine/src/workers/claude-cli/plan.ts keeps ctx.safeChain undefined for a review, so no Safe-Chain proxy starts and no Safe-Chain install runs for a reviewer (0019 section 4), and, when the Safe-Chain install was detected, carries the PATH detectSafeChain built and a flag that closes the CLI's shell snapshot
- [x] #2 With that PATH and flag, the review plan sets env PATH to the detected PATH (entries the sandbox cannot read left out, demoted entries at the end) and adds the shell snapshot directory to the sandbox's denyRead; it sets no CLAUDE_CODE_SHELL and keeps REVIEW_NETWORK
- [x] #3 The reviewer self-test in packages/engine/src/workers/claude-cli/self-test.ts uses the same detected PATH for its workerPath, and the reviewer launch checks in launch-checks.ts start no Safe-Chain proxy
- [x] #4 A review plan, self-test and launch on a machine without the official Safe-Chain install are unchanged
- [x] #5 Unit tests cover the review plan with and without Safe-Chain in packages/engine/test/workers/plan.test.ts, the reviewer self-test in packages/engine/test/workers/self-test.test.ts (the test that Safe-Chain changes nothing for a reviewer is updated to the new PATH and closed snapshot), and the reviewer launch in packages/engine/test/workers/launch-checks.test.ts
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5DJ2QR7BR4Q7RTJS1QKCAFG (Sonnet, 37 turns, about $0.45, 2 min) reported done with no denied call and no write outside the References; stopped at review (the running binary predated this fix) and reviewed by hand. A review session keeps no Safe-Chain context (no proxy, shell wrapper or install, network closed, 0019 section 4), but on a machine with the official Safe-Chain install kindContext now carries the PATH detectSafeChain built (reviewShell): the plan sets the reviewer's env PATH to it and read-denies the CLI's shell snapshot directory, so the reviewer's Bash no longer takes the login shell's PATH, whose first bun links outside the sandbox's read paths (the cause of 49 failed review starts on 2026-10-20). The self-test's workerPath follows. Workers and machines without Safe-Chain are unchanged. Fixed on top: a stale self-test comment. Not yet proven: whether bun resolves in a live reviewer sandbox (a zsh login shell could reorder PATH via path_helper, as DIPO-107 handled for workers); the live check is the next review start on a rebuilt binary. Follow-ups: a direct test that the self-test's workerPath is reviewShell.path; the reviewer's env PATH replaces the whole claude process PATH, unlike a worker. Verify outside the sandbox: exit 0, 4181 tests; DIPO_TEST_CI=1 workers and run tests.
<!-- SECTION:NOTES:END -->
