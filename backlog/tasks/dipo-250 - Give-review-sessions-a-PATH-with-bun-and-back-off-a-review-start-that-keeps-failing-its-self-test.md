---
id: DIPO-250
title: >-
  Give review sessions a PATH with bun, and back off a review start that keeps
  failing its self-test
status: Refined
assignee: []
created_date: '2026-10-20 19:03'
updated_date: '2026-10-20 19:03'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-183
  - DIPO-231
references:
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/workers/claude-cli/safe-chain.ts
  - packages/engine/src/workers/claude-cli/adapter.ts
  - packages/engine/src/run/reviews.ts
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/safe-chain.test.ts
  - packages/engine/test/run/reviews.test.ts
priority: high
type: bug
ordinal: 136000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a review session on a machine with the official Safe-Chain install finds bun on its PATH, so its launch self-test can pass and its reviewer starts; and a review start that keeps failing its self-test backs off and then pauses with one notice, instead of starting a new self-test session about every minute.

Context: confirmed on 2026-10-20 on the temp office. Every dipo review round's launch self-test failed with "`bun add` exited 127 inside the reviewer sandbox: bun was not found on the reviewer's PATH" (INSTALL_CANNOT_RUN in packages/engine/src/workers/claude-cli/self-test.ts): 49 failed starts across DIPO-237, 229, 227, 195, 136 and 183, each a short live Haiku self-test session, retried about every 70 seconds with no cap or backoff, each holding claude-cli in every office. Cause: kindContext in packages/engine/src/workers/claude-cli/plan.ts drops the Safe-Chain context for a review ("no Safe-Chain proxy, since a reviewer installs nothing"), so the reviewer's sandbox leaves the CLI's shell snapshot readable (the denyRead of the snapshot directory applies only with Safe-Chain) and the reviewer's Bash tool takes its PATH from the maintainer's login shell. That PATH starts with a Safe-Chain wrapper directory outside the sandbox's read paths, whose bun is a link to a wrapper script the sandbox cannot read, so bun cannot be resolved and the install exits 127 before it can prove the network is closed. Workers do not hit this: detectSafeChain (packages/engine/src/workers/claude-cli/safe-chain.ts) builds a PATH without the entries the sandbox cannot read and with entries whose wrapped command points where it cannot read moved to the end (SafeChainLaunch path, dropped, demoted), the Safe-Chain shell sets that PATH, and the snapshot stays closed. The reviewer keeps its closed network and no proxy (REVIEW_NETWORK, 0019 section 4); only its PATH and its shell snapshot read change. Retries: Places.drain (packages/engine/src/run/places.ts) runs every minute while anything waits and calls the review starter; Reviews.start in packages/engine/src/run/reviews.ts handles a startFailed outcome with a review.startFailed notice, and the story stays In Review and its review waits (the startFailed row of 0019 section 4, which this story keeps). claudeWorkerPort in packages/engine/src/workers/claude-cli/adapter.ts passes the launch context and the detected Safe-Chain install to the plan. DIPO-231 (Ready, finishing) changes plan.ts and self-test.ts for the self-test's approval call; DIPO-183 (in progress) has packages/engine/src/run/ in its References.

```dipo
branch: "DIPO-250/reviewer-path-and-start-backoff"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) plan.test.ts: a review plan with Safe-Chain detected has the detected PATH (dropped entries out, demoted at the end), denies reads of the shell snapshot directory, sets no CLAUDE_CODE_SHELL and keeps REVIEW_NETWORK with no proxy port; a review plan without Safe-Chain is unchanged"
    - kind: "automated"
      check: "(unit) safe-chain.test.ts: the PATH detectSafeChain returns leaves out a wrapper directory the sandbox cannot read whose bun links outside every read path"
    - kind: "automated"
      check: "(unit) reviews.test.ts, manual clock: failed starts of one run wait 1, 2, 4 and 8 minutes; the fifth failure pauses that run's review with one review.startPaused notice; a later start after a configuration reload starts again; a successful start resets the count"
    - kind: "manual"
      check: "(live) on this repo, let a story reach In Review on the temp office so its review round starts"
      expect: "the reviewer's launch self-test passes and a reviewer session starts"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 For a review session on a machine where detectSafeChain found the official Safe-Chain install, the plan in packages/engine/src/workers/claude-cli/plan.ts sets the session's PATH to the PATH detectSafeChain built (dropped entries left out, demoted entries at the end) and denies reads of the CLI's shell snapshot directory, as a worker's plan with Safe-Chain does, while the review keeps no Safe-Chain proxy, no CLAUDE_CODE_SHELL wrapper and REVIEW_NETWORK
- [ ] #2 A review plan on a machine without the official Safe-Chain install is unchanged
- [ ] #3 In Reviews.start in packages/engine/src/run/reviews.ts a run whose review start failed (a startFailed outcome or a refused launch check) is not started again before a backoff that doubles from 1 minute to at most 30 minutes; after 5 failed starts in a row of one run its review is paused, no further start is tried until the office configuration is reloaded or the daemon restarts, and one engine.notice review.startPaused names the story, the count and the last reason; a successful start resets the count, and the story stays In Review throughout
- [ ] #4 Unit tests cover the review plan with and without Safe-Chain in packages/engine/test/workers/plan.test.ts, the PATH without the unreadable wrapper directory in packages/engine/test/workers/safe-chain.test.ts, and the backoff, the pause with its single notice, the start after a configuration reload and the reset in packages/engine/test/run/reviews.test.ts with a manual clock
<!-- AC:END -->
