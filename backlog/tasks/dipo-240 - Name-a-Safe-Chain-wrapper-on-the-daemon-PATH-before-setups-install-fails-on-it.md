---
id: DIPO-240
title: >-
  Run box only: keep the box from claim to merge, and remove the Mac sandbox
  worker path
status: Done
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-23 07:23'
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
  - '- packages/daemon/src/foreground.ts'
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0021-worker-isolation.md
  - packages/cli/src/index.ts
  - packages/cli/src/run-command.test.ts
  - packages/cli/src/run-command.ts
  - packages/contract/src/office.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/src/hook.ci.test.ts
  - packages/daemon/src/hook.test.ts
  - packages/daemon/src/hook.ts
  - packages/daemon/src/runs.ts
  - packages/daemon/test/unit/box-runs.test.ts
  - packages/engine/src/box/index.ts
  - packages/engine/src/box/lifetime.ts
  - packages/engine/src/box/parts.ts
  - packages/engine/src/box/workers.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/src/git/task-commit.ts
  - packages/engine/src/hooks/
  - packages/engine/src/hooks/bash-check.ts
  - packages/engine/src/hooks/gh-guard.ts
  - packages/engine/src/hooks/index.ts
  - packages/engine/src/hooks/park-answers.ts
  - packages/engine/src/hooks/park-questions.ts
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/src/hooks/questions.ts
  - packages/engine/src/hooks/temp-guard.ts
  - packages/engine/src/index.ts
  - packages/engine/src/platform/sandbox.ts
  - packages/engine/src/run/
  - packages/engine/src/run/compose.ts
  - packages/engine/src/run/control-endings.ts
  - packages/engine/src/run/index.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/src/run/park.ts
  - packages/engine/src/run/places.ts
  - packages/engine/src/run/plan-limit.ts
  - packages/engine/src/run/reattach.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/run/review-launch.ts
  - packages/engine/src/run/review-rounds.ts
  - packages/engine/src/run/reviews.ts
  - packages/engine/src/run/story-git.ts
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/sandbox/env.ts
  - packages/engine/src/sandbox/fence.ts
  - packages/engine/src/sandbox/index.ts
  - packages/engine/src/sandbox/policy.ts
  - packages/engine/src/sandbox/safe-chain-proxies.ts
  - packages/engine/src/sandbox/safe-chain-proxy.ts
  - packages/engine/src/sandbox/step.ts
  - packages/engine/src/workers/claude-cli/adapter.ts
  - packages/engine/src/workers/claude-cli/hooks.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/src/workers/claude-cli/npm-token-check.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/workers/claude-cli/safe-chain.ts
  - packages/engine/src/workers/claude-cli/self-test.ts
  - packages/engine/src/workers/claude-cli/verify-tools.ts
  - packages/engine/src/workers/credential-check.ts
  - packages/engine/src/workers/hold.ts
  - packages/engine/src/workers/port.ts
  - packages/engine/src/worktree/index.ts
  - packages/engine/src/worktree/setup.ts
  - packages/engine/test/box/lifetime.test.ts
  - packages/engine/test/box/workers.test.ts
  - packages/engine/test/hooks/
  - packages/engine/test/hooks/gh-guard.test.ts
  - packages/engine/test/hooks/park-answers.test.ts
  - packages/engine/test/hooks/park-questions.test.ts
  - packages/engine/test/hooks/permissions.test.ts
  - packages/engine/test/hooks/temp-guard.test.ts
  - packages/engine/test/hooks/worker-questions.test.ts
  - packages/engine/test/run/adapter.test.ts
  - packages/engine/test/run/park-resume.ci.test.ts
  - packages/engine/test/run/places.test.ts
  - packages/engine/test/run/reattach.test.ts
  - packages/engine/test/run/reviews.test.ts
  - packages/engine/test/run/run-office.ts
  - packages/engine/test/run/stand-in-plan.ts
  - packages/engine/test/run/start.test.ts
  - packages/engine/test/run/temp-dirs.ci.test.ts
  - packages/engine/test/run/verify-commit.ci.test.ts
  - packages/engine/test/run/verify-commit.test.ts
  - packages/engine/test/run/verify-in-box.test.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/engine/test/sandbox/env.test.ts
  - packages/engine/test/sandbox/fence.test.ts
  - packages/engine/test/sandbox/golden/darwin-install.json
  - packages/engine/test/sandbox/golden/darwin-verify.json
  - packages/engine/test/sandbox/golden/linux-install.json
  - packages/engine/test/sandbox/golden/linux-verify.json
  - packages/engine/test/sandbox/hardening.ci.test.ts
  - packages/engine/test/sandbox/helpers.ts
  - packages/engine/test/sandbox/install-cache-trust.test.ts
  - packages/engine/test/sandbox/mktemp-wrapper.ci.test.ts
  - packages/engine/test/sandbox/policy.test.ts
  - packages/engine/test/sandbox/safe-chain-proxy.ci.test.ts
  - packages/engine/test/sandbox/safe-chain-proxy.test.ts
  - packages/engine/test/sandbox/sandbox-exec.ci.test.ts
  - packages/engine/test/sandbox/sandbox.ci.test.ts
  - packages/engine/test/sandbox/self-verify.ci.test.ts
  - packages/engine/test/sandbox/srt-default-writes.ci.test.ts
  - packages/engine/test/sandbox/step.test.ts
  - packages/engine/test/workers/
  - packages/engine/test/workers/box-plan.test.ts
  - packages/engine/test/workers/credential-check.test.ts
  - packages/engine/test/workers/golden/plan-L.json
  - packages/engine/test/workers/golden/plan-M.json
  - packages/engine/test/workers/golden/plan-S.json
  - packages/engine/test/workers/hook-command.test.ts
  - packages/engine/test/workers/hooks.test.ts
  - packages/engine/test/workers/launch-checks.test.ts
  - packages/engine/test/workers/launch-fixtures.ts
  - packages/engine/test/workers/npm-token-check.test.ts
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/plugins.test.ts
  - packages/engine/test/workers/review-tools.test.ts
  - packages/engine/test/workers/safe-chain-bash-profile.ci.test.ts
  - packages/engine/test/workers/safe-chain-login.test.ts
  - packages/engine/test/workers/safe-chain-shell.ci.test.ts
  - packages/engine/test/workers/safe-chain.test.ts
  - packages/engine/test/workers/self-test.test.ts
  - packages/engine/test/workers/short-temp.ci.test.ts
  - packages/engine/test/workers/skills.test.ts
  - packages/engine/test/workers/verify-tools.test.ts
  - packages/engine/test/worktree/
  - packages/engine/test/worktree/base-verify.test.ts
  - packages/engine/test/worktree/setup-claim.ci.test.ts
  - packages/engine/test/worktree/setup-harness.ts
  - packages/engine/test/worktree/setup.ci.test.ts
  - packages/engine/test/worktree/setup.test.ts
  - packages/testkit/README.md
  - tools/recordings/capture.test.ts
  - tools/recordings/capture.ts
  - tools/recordings/scenarios.ts
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
- [x] #1 (from DIPO-278) The box is stopped while the story waits for a review, an answer, a resume, CI or the maintainer, and started again for the next session
- [x] #2 (from DIPO-278) A missing box is rebuilt from the start commit plus the delivered parts; only undelivered work is lost, and the maintainer is told
- [x] #3 (from DIPO-278) Merge, drop and discard delete the box
- [x] #4 (from DIPO-278) Tests cover each transition
- [x] #5 (from DIPO-280) plan.ts no longer writes the Bash sandbox settings, permission rules or hooks for a worker
- [x] #6 (from DIPO-280) The Bash hook, the gh and temp guards and the permission relay are removed with their tests
- [x] #7 (from DIPO-280) Every test still passes, and nothing in the worker path refers to the removed parts
- [x] #8 (from DIPO-280) The unused commitTaskFile in packages/engine/src/git/task-commit.ts is removed (DIPO-270 moved its callers to dipo's own copy)
- [x] #9 (from DIPO-280) packages/engine/src/hooks/web-guard.ts and the reviewer's and worker's use of it stay (DIPO-276, DIPO-292)
- [x] #10 (audit) A box run runs no Mac worktree setup step: no install, setup or post_create step and no base-commit verify runs on the Mac; the engine step sandbox goes where nothing else uses it
- [x] #11 (audit) The Mac verify runner, the backstop and the Mac-only scope check are removed
- [x] #12 (audit) No run temp directory is made in the shared temp folder for a box run
- [x] #13 (audit) The permission relay and allow-once go; the needs-permission park and its answer stay and resume the run in its box
- [x] #14 (audit) The daemon hook entry keeps only what the reviewer uses (the gate and nudge hooks)
- [x] #15 (audit) A launch check failure of the reviewer holds the adapter in every office; the Mac self-test and its could-not-run holds are gone
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: installs move into the box and the read-only cache dipo fills through Safe-Chain (0021 section 5).

Carried from DIPO-257: Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: launch-check holds become checks of the box and its probe (0021 sections 1 and 16).

2026-10-22: combined from DIPO-257, DIPO-278, DIPO-280 (maintainer, M1 speed-up)

2026-10-22: dropped the dependencies on DIPO-255, DIPO-159 (which now holds DIPO-289) and DIPO-149 (which now holds DIPO-291) to break a dependency cycle left by the M1 combine; those stories now come after this one.

2026-10-22: criteria 1 to 10 (Safe-Chain routing of the Mac setup install from DIPO-240, and the scoped self-test holds from DIPO-257) were dropped: the Mac setup install and the self-test no longer exist. They are replaced by the audit criteria above (maintainer, M1 speed-up).

2026-10-22: built outside dipo, reviewed in two rounds (the rest/session race and restored sandbox security tests fixed; a box is deleted only after a fresh token check). Follow-ups: base verify (DIPO-183) no longer runs (could run in the box); profile setup and post_create are not run in the box; timeouts.permissionWaitSeconds is unused and goes in a later config version.
<!-- SECTION:NOTES:END -->
