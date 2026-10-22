---
id: DIPO-240
title: >-
  Run box only: keep a story's box from claim to merge, and remove the Mac
  sandbox worker path with its setup install, hooks, guards and launch holds
status: Refined
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:M'
  - cutover
  - needs-refinement
  - box
milestone: m-1
dependencies:
  - DIPO-183
  - DIPO-228
  - DIPO-231
  - DIPO-250
  - DIPO-294
  - DIPO-295
  - DIPO-302
  - DIPO-296
  - DIPO-300
  - DIPO-271
  - DIPO-275
  - DIPO-276
  - DIPO-279
  - DIPO-284
  - DIPO-292
  - DIPO-152
references:
  - packages/daemon/src/foreground.ts
  - packages/daemon/src/hook.ts
  - packages/daemon/src/runs.ts
  - packages/engine/src/box/lifetime.ts
  - packages/engine/src/git/task-commit.ts
  - packages/engine/src/hooks/
  - packages/engine/src/run/
  - packages/engine/src/run/compose.ts
  - packages/engine/src/run/places.ts
  - packages/engine/src/run/plan-limit.ts
  - packages/engine/src/run/review-rounds.ts
  - packages/engine/src/run/reviews.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/sandbox/safe-chain-proxies.ts
  - packages/engine/src/sandbox/safe-chain-proxy.ts
  - packages/engine/src/sandbox/step.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/workers/claude-cli/safe-chain.ts
  - packages/engine/src/workers/claude-cli/self-test.ts
  - packages/engine/src/workers/hold.ts
  - packages/engine/src/worktree/setup.ts
  - packages/engine/test/box/lifetime.test.ts
  - packages/engine/test/hooks/
  - packages/engine/test/run/places.test.ts
  - packages/engine/test/run/reviews.test.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/engine/test/sandbox/safe-chain-proxy.test.ts
  - packages/engine/test/workers/
  - packages/engine/test/workers/launch-checks.test.ts
  - packages/engine/test/worktree/
priority: high
type: bug
ordinal: 240000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: workers run only in boxes: a story's box lives from claim to merge (running while the worker works, stopped while the story waits, rebuilt from the start commit and the delivered parts when lost, deleted at merge, drop or discard), and the Mac sandbox worker path is removed with its setup install, Bash sandbox settings, permission rules and relay, hooks, guards and self-test launch holds.

Context: G31 (2026-10-18, DIPO-177) and again on 2026-10-20 (DIPO-231, twice, after a daemon restart from a shell whose PATH had ~/.bun/bin first). Setup (packages/engine/src/worktree/setup.ts) runs the run profile's install (`bun install --frozen-lockfile`) through the sandboxed step runner (packages/engine/src/sandbox/step.ts) with the daemon's environment. When the daemon's PATH resolves bun to Safe-Chain's wrapper, the wrapper starts its own checking listener inside the step sandbox, which refuses it: "Failed to check for malicious packages: listen EPERM: operation not permitted 127.0.0.1" (or, in G31, mktemp EPERM). The failure text is all the maintainer sees, at info level the output is "[debug only]", and nothing says the PATH order is the cause. With the real bun first, setup passes, but then setup's install is not checked by Safe-Chain at all. Worker installs go only through a per-run Safe-Chain checking proxy dipo runs outside the worker sandbox (0008 section 2, DIPO-84); detectSafeChain (packages/engine/src/workers/claude-cli/safe-chain.ts) finds the official install and sorts the worker PATH. Today the run's proxy starts only at launch, after setup: claudeLaunchChecks in packages/engine/src/workers/claude-cli/launch-checks.ts calls SafeChainProxies.start (packages/engine/src/sandbox/safe-chain-proxies.ts, which stops an earlier proxy of the same run first) and routes the plan through its port; the proxy itself is packages/engine/src/sandbox/safe-chain-proxy.ts. The daemon builds setup's dependencies (SetupDeps, its runStep) and the proxies in packages/daemon/src/runs.ts. The 0008 section 2 note of 2026-10-20 (DIPO-240) records that the proxy also serves setup.

DIPO-240 (Safe-Chain wrapper in the Mac setup) and DIPO-257 (launch holds of the Mac self-test) are kept only as far as they still apply once the Mac path is gone.

From DIPO-257: the maintainer's decision D5 of 2026-10-20 (answer A); dated 0008 note (launch checks) of 2026-10-20. On 2026-10-20 every review start's self-test failed with bun not found on the reviewer's PATH (DIPO-250): 49 failed starts across six stories, each a short live Haiku self-test session, retried about every 70 seconds with no cap, each holding claude-cli in every office. AdapterHolds (packages/engine/src/workers/hold.ts) keeps one hold per adapter for the whole daemon; gateLaunch (packages/engine/src/workers/hold.ts) sets it on any failed check that claudeLaunchChecks (packages/engine/src/workers/claude-cli/launch-checks.ts) returns and lifts it when the checks pass; the daemon builds the holds in packages/daemon/src/foreground.ts. The plan-limit schedule (packages/engine/src/run/plan-limit.ts), built in packages/engine/src/run/compose.ts, already re-checks on a timer with the engine clock. The self-test's verdicts already tell the two cases apart (packages/engine/src/workers/claude-cli/self-test.ts): `unsafe: true` when a probe write or read got through, `cannotRun` (unsafe false) when a tool was missing, a timeout, or the session ended early. work.run reads adapterHeld (packages/engine/src/run/work-run.ts). Places.drain (packages/engine/src/run/places.ts) offers each place only its first waiting start, oldest In Review first among pending reviews (pendingReviews, packages/engine/src/run/review-rounds.ts), and requeues it when the starter returns false; it runs at each worker exit decision, at office load and every minute while anything waits, and #disarm stops that tick when nothing waits. So a backed-off review at the head would starve every other pending review, and filtering it out of the pending list could stop the tick and leave an expired backoff never retried. Reviews.start (packages/engine/src/run/reviews.ts) writes a run.startFailed notice on a failed start; the story stays In Review and its review waits (0019 section 4, kept). The 0008 note of 2026-10-20 (DIPO-257) decides the two hold scopes, the backoff and the notice. The backoff steps, counting a refused approval call as could-not-run, and passing a backed-off review over in Places.drain are this story's design choices (design choice, not a maintainer decision; the maintainer may change it before a run).

From DIPO-278 and DIPO-280: Decision 0021 (worker isolation, DIPO-263) and the probe results of DIPO-264 (tools/box-probe/RESULTS.md and the 0021 amendment of 2026-10-21).

```dipo
branch: "DIPO-240/box-only"
unknowns:
  - q: "How should setup's install meet Safe-Chain? (a) Setup's install step runs through the run's Safe-Chain checking proxy, as worker installs do (DIPO-84), so setup installs are checked and the wrapper's own listener is never needed; a dated 0008 section 2 note records that the proxy also serves setup (recommended: installs stay checked, which is the DIPO-84 rule, and today setup installs are unchecked whenever the real bun comes first). (b) No proxy for setup: before a claim, an office check refuses the run when the install program on the daemon PATH is Safe-Chain's wrapper, naming the wrapper path and saying to start the daemon with the real program first; setup installs stay unchecked."
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): approved; the 0008 section 2 note of 2026-10-20 (DIPO-240): setup's install step also runs through the run's Safe-Chain checking proxy, as worker installs do (DIPO-84), so setup installs are checked too and setup no longer needs a Safe-Chain wrapper on the daemon PATH."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) with Safe-Chain detected, setup starts the run's proxy before the install step, and the install step's environment and sandbox settings route the package manager through the proxy port as a worker install is routed"
    - kind: "automated"
      check: "(unit) a proxy that fails to start fails setup with a reason naming Safe-Chain and the proxy failure, runs no install, and the claim rolls back; a failed install stops the proxy"
    - kind: "automated"
      check: "(unit) the launch after a setup that started the proxy routes the worker through the run's proxy, and with no Safe-Chain install setup runs as today"
    - kind: "manual"
      check: "(live) start the temp daemon from a shell with the Safe-Chain wrapper first on PATH and start a Ready story"
      expect: "setup's install passes through the run's proxy, and the proxy's log shows the install's package checks"
    - kind: "automated"
      check: "(unit) launch-checks.test.ts: an unsafe self-test verdict holds the adapter in every office; a cannot-run verdict holds only that office's launch kind, and the other office and the other kind still launch"
    - kind: "automated"
      check: "(unit) a cannot-run hold is re-checked on the engine clock after each backoff step with a manual clock, with the held kind's launch context in that office; its notice names the probe and the fix; a passing check lifts it"
    - kind: "automated"
      check: "(unit) places.test.ts and reviews.test.ts: while the head pending review backs off, the next pending review starts; the backed-off review starts again after its wait with no other trigger, and the drain tick keeps running while it waits"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When the official Safe-Chain install is detected, setup in packages/engine/src/worktree/setup.ts starts the run's Safe-Chain checking proxy (SafeChainProxies.start) before the install step, and the install step's environment and sandbox settings route the package manager through the proxy port as a worker install is routed (DIPO-84), so the install never starts the Safe-Chain wrapper's own listener inside the step sandbox
- [ ] #2 A proxy that does not start fails setup with a reason that names Safe-Chain and the proxy failure, no install runs, and the claim rolls back as for any setup failure; a setup that fails after the proxy started stops that proxy
- [ ] #3 The launch after setup routes the worker through the run's proxy, either the one setup started or one started again under the rule of safe-chain-proxies.ts, and the run never has two proxies at once
- [ ] #4 With no Safe-Chain install, setup and the launch behave as today
- [ ] #5 Unit tests in packages/engine/test/worktree/ and packages/engine/test/workers/launch-checks.test.ts cover the routed install, a proxy that fails to start, a failed install that stops the proxy, the launch's proxy after setup, and the case with no Safe-Chain install, with fake proxies and fake files
- [ ] #6 (from DIPO-257) A launch check whose verdict is unsafe (a probe write or read got through) holds the adapter in every office, as today
- [ ] #7 (from DIPO-257) A launch check that could not run (a missing tool, a timeout, a session that ended early; a refused approval call counts as one too (design choice, not a maintainer decision; the maintainer may change it before a run)) holds only that launch kind, worker or reviewer, in that office; the other kind and the other offices still launch, and its engine.notice names the probe and the fix; every launch-check failure other than a self-test could-not-run verdict (the tools, probe, settings, engine credential and Safe-Chain proxy checks, and a CLI start failure) keeps the hold in every office, so the scoped hold fails closed
- [ ] #8 (from DIPO-257) A could-not-run hold is checked again with backoff, after 1, 2, 4 and 8 minutes and then every 30 minutes (design choice, not a maintainer decision; the maintainer may change it before a run), and lifts when the checks pass; the re-check is scheduled on the engine clock by the run composition in packages/engine/src/run/compose.ts, as the plan-limit schedule is, and runs the held kind's launch checks through gateLaunch with that office's launch context for that kind (the reviewer's for a reviewer hold, the worker's for a worker hold)
- [ ] #9 (from DIPO-257) In Places.drain a review start that backs off is passed over and the next pending review in order starts in its place; the backed-off review starts again after its wait with no other trigger, and the drain's minute tick keeps running while any start waits for a backoff (design choice, not a maintainer decision; the maintainer may change it before a run)
- [ ] #10 (from DIPO-257) Tests in packages/engine/test/workers/launch-checks.test.ts, packages/engine/test/run/places.test.ts packages/engine/test/run/reviews.test.ts and packages/engine/test/run/work-run.test.ts cover the unsafe and the could-not-run holds, the backoff with a manual clock, the notice text, the passed-over head and the retry after the wait
- [ ] #11 (from DIPO-278) The box is stopped while the story waits for a review, an answer, a resume, CI or the maintainer, and started again for the next session
- [ ] #12 (from DIPO-278) A missing box is rebuilt from the start commit plus the delivered parts; only undelivered work is lost, and the maintainer is told
- [ ] #13 (from DIPO-278) Merge, drop and discard delete the box
- [ ] #14 (from DIPO-278) Tests cover each transition
- [ ] #15 (from DIPO-280) plan.ts no longer writes the Bash sandbox settings, permission rules or hooks for a worker
- [ ] #16 (from DIPO-280) The Bash hook, the gh and temp guards and the permission relay are removed with their tests
- [ ] #17 (from DIPO-280) Every test still passes, and nothing in the worker path refers to the removed parts
- [ ] #18 (from DIPO-280) The unused commitTaskFile in packages/engine/src/git/task-commit.ts is removed (DIPO-270 moved its callers to dipo's own copy)
- [ ] #19 (from DIPO-280) packages/engine/src/hooks/web-guard.ts and the reviewer's and worker's use of it stay (DIPO-276, DIPO-292)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: installs move into the box and the read-only cache dipo fills through Safe-Chain (0021 section 5).

Carried from DIPO-257: Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: launch-check holds become checks of the box and its probe (0021 sections 1 and 16).

2026-10-22: combined from DIPO-257, DIPO-278, DIPO-280 (maintainer, M1 speed-up)

2026-10-22: dropped the dependencies on DIPO-255, DIPO-159 (which now holds DIPO-289) and DIPO-149 (which now holds DIPO-291) to break a dependency cycle left by the M1 combine; those stories now come after this one.
<!-- SECTION:NOTES:END -->
