---
id: DIPO-49
title: Verify and commit the story at In Review
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-14 13:06'
labels:
  - 'tier:M'
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-50
  - DIPO-74
references:
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/run/backstop.ts
  - packages/engine/src/run/
  - packages/engine/src/db/migrations/
  - packages/engine/test/run/
documentation:
  - docs/decisions/0002-review-and-testing.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: high
type: feature
ordinal: 49000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: when the worker reports done, the engine checks every changed path against the declared scope, runs verify inside `srt`, and on green commits the code, checks off the met criteria, commits `<ID>: status In Review` and pushes; on red it sends the failure as feedback for another loop, and parks `verify-failing` at the loop cap.

Context: M0 delivery ends at In Review with the story branch pushed; the story PR and the reviewer stay manual until M1 (M0 breakdown decision D1, DIPO-15). Building-time base sync is not part of M0 runs except the re-claim merge of DIPO-38. This story owns the end of a run: every later outcome (DIPO-50, DIPO-51) ends through the same function, which writes the permanent `run_outcomes` row (M0 review, DIPO-15). References: 0010 section 7 (verify-and-commit row, code tree key, lockfile pairing amendment, push rule); 0014 section 3 (scope check at done, verify in `srt`, green and red paths, no mid-implementation commits, HEAD backstop after every turn); 0008 section 2 "Backstop after every turn"; 0007 section 4 (`verify_results`, `run_summaries`); 0002 (loops capped).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-49/verify-commit-story-at-review"
unknowns:
  - q: "Whether M0 opens the story PR?"
    status: "resolved"
    answer: "maintainer decision D1 of the M0 breakdown (2026-10-11, recorded in DIPO-15): no; M0 delivery ends at In Review with the story branch pushed; the story PR and the reviewer stay manual until M1."
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) `success-single` plus a fixture change in scope and green verify gives one code commit, one In Review commit and a push to the bare remote."
    - kind: "automated"
      check: "(engine) a file outside scope parks `scope-violation`; a `bun.lock` beside an in-scope `package.json` is accepted."
    - kind: "automated"
      check: "(engine) verify red twice on an S tier with loop cap 2 parks `verify-failing`; the feedback holds the parsed `file:line`."
    - kind: "automated"
      check: "(engine) a worker turn that moves HEAD parks `scope-violation`."
    - kind: "automated"
      check: "(engine) a run ending at In Review and a run parked `budget-exceeded` each write one `run_outcomes` row with the counted fields; verify output arrives as `work.output` with source `verify`."
    - kind: "manual"
      check: "in a scratch office (a clone of a fixture repository with a remote, opened with `dipo office open` and initialised with `dipo office init`), set one small fixture story Ready with `backlog task edit <ID> -s Ready`, merge that change, run `dipo run <ID>` and wait until `backlog task view <ID> --plain` in the story worktree `<root>/<ID>` shows status In Review, then run `git log --oneline origin/main..<ID>/<slug>` and `git ls-remote --heads origin <ID>/<slug>`"
      expect: "`git log` on the story branch shows the claim commit, one code commit and the In Review commit, and the remote has the branch."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After every worker turn, HEAD, the checked-out branch, stashes and `git status --porcelain -- backlog .dipo` are compared with the run-start snapshot, excluding the engine's own ref updates; any other change parks `scope-violation` with the evidence.
- [x] #2 On report `done`, every modified, staged and untracked path from `git status --porcelain=v1 -z --untracked-files=all` is checked; a path outside scope and outside the story's own task file parks `scope-violation` with the paths, except a lockfile paired with an in-scope manifest.
- [x] #3 Verify runs the run profile's verify command through DIPO-37 with network closed, records `verify_results` with exit code, duration and output range, emits `work.phase verify`, and streams its output as `work.output` with source `verify`.
- [x] #4 Green: exactly the scope paths and paired lockfiles are staged and committed with the worker's subject plus the story id; the result is recorded against the code tree key.
- [x] #5 Green: the criteria the report marks met are checked off and `<ID>: status In Review` is committed alone through the Backlog CLI, then the branch is pushed without force.
- [x] #6 Red: a verify feedback item (DIPO-47) is sent as the next user message, `Progress.loop` increases and `verify` shows `failing`; at the tier loop cap the story parks `verify-failing`.
- [x] #7 Base `verify` from the run profile also runs when the branch changed a gate script, and the changed commands are recorded on the run.
- [x] #8 At run end a run summary is stored with the final report, diffstat, verify result and last 50 output lines, built without a model.
- [x] #9 A migration adds `run_outcomes` (0007 amendment of 2026-10-12, kept until purge); one `endRun` function writes one row whenever a run ends, at In Review and at every park of DIPO-50, with tier, role, model, outcome, park reasons, loops, review rounds, verify failures, budget tokens used, minutes, criteria count and scope size.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S33 (DIPO-15). Before cutover: built by hand-run agents.

Follow-ups from DIPO-63 and DIPO-65 (2026-10-13): (1) the verify step calls WorkTracker.beginVerify() (packages/engine/src/keepawake/activity.ts) and calls the returned function when verify ends, so keep-awake holds during verify; (2) add the run_summaries table: retention's runSummaryExists (packages/engine/src/retention/run-files.ts) looks for it, and until it exists processed event files wait for the retention fallback.

Maintainer decision 2026-10-14: engine steps in the step sandbox (install at setup, verify here) get their own writable TMPDIR inside the run's allowed write area, so package-manager wrappers such as Aikido Safe-Chain (~/.bun/bin/bun on the maintainer's machine, which calls mktemp) work inside the sandbox and keep checking installs. Found in the DIPO-74 live test, where setup failed with 'mktemp: mkstemp failed … Operation not permitted'. Check on the first live install with dependencies whether Safe-Chain also needs network access to Aikido.

Implementation (DIPO-49 branch):
- run/backstop.ts: run-start snapshot (HEAD, symbolic-ref, refs/stash, status -- backlog .dipo) taken by the launcher before the worker host starts; compared after every turn by run control; any change, or a tampered worktree, parks scope-violation with the evidence.
- run/verify-commit.ts (VerifyCommit, the RunFinisher of RunControl): scope check at done over git status --porcelain=v1 -z --untracked-files=all against runs.scope (the F8 scope stored at run start, so editing the task file cannot widen it); a scope path covers itself and everything under it; the task file is exempt; lockfiles (bun.lock, bun.lockb, pnpm-lock.yaml, yarn.lock, package-lock.json) pair with an in-scope package.json beside them, and the root lockfile with any in-scope workspace manifest.
- Verify: branch verify from a code-only scan of the worktree (the stored profile when fingerprints match); gate changes (root package.json scripts test/lint/typecheck/verify and the resolved gate commands) are recorded in runs.gate_changes and the base verify also runs when its commands differ. Each command runs through runSandboxedStep with the verify policy and the run env; work.phase verify first; WorkTracker.beginVerify holds keep-awake; output streams (new optional onOutput on the sandboxed step) into output_chunks source verify and work.output source verify, buffered 500 ms; one verify_results row per command list.
- Red: verify feedback item (DIPO-47) sent as a steer intent through the host; a loop step and phase build are recorded (Progress.loop up, verify failing). Red passes reaching runs.loop_cap park verify-failing with the item as detail. A sandbox refusal parks verify-failing at once.
- Green: the run claims its end (caps and work.stop wait), commits exactly the scope paths and paired lockfiles as '<ID>: <worker subject>', records the code tree key (sha256 of ls-tree -r HEAD without the task file), checks off met criteria and sets In Review with the Backlog CLI, commits the task file alone as '<ID>: status In Review', pushes without force, then ends the run (endRun in-review), stores the summary, emits story.state to In Review and closes the worker's stdin. Non-fast-forward push parks conflict; other push failures are a verify.pushFailed notice; a failed commit step parks interrupted.
- Migration 21: verify_results, run_summaries, run_outcomes (tier P, no FK to runs), runs.scope and runs.gate_changes. endRun now writes the run_outcomes row whenever a run ends (In Review, every park, start-failed, claim releases). Every park through run control also stores a run summary.
- Outside the declared scope, needed: db/schema.ts (register migration), retention policy/run/run-files (tier and FK order of the new tables), views/work.ts (Progress.verify from verify_results), sandbox/step.ts (onOutput streaming), daemon runs.ts and foreground.ts (wiring).
- Decision A (own TMPDIR for sandboxed steps): already in place since DIPO-37 (TMPDIR and DIPO_TMP point at the step temp root, srt gets it through CLAUDE_CODE_TMPDIR). Reproduced the Safe-Chain failure locally: macOS /usr/bin/mktemp without a template ignores TMPDIR and uses confstr(_CS_DARWIN_USER_TEMP_DIR) (/var/folders/.../T), which the policy does not allow. A TMPDIR change cannot fix it; making it work needs the Darwin per-user temp dir writable for steps, a policy change of 0008 section 2 that needs the maintainer. Not implemented; until then run the daemon with ~/.bun/bin-originals first on PATH.
<!-- SECTION:NOTES:END -->
