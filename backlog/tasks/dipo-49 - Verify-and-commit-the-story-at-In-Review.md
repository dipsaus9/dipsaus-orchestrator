---
id: DIPO-49
title: Verify and commit the story at In Review
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
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
- [ ] #1 After every worker turn, HEAD, the checked-out branch, stashes and `git status --porcelain -- backlog .dipo` are compared with the run-start snapshot, excluding the engine's own ref updates; any other change parks `scope-violation` with the evidence.
- [ ] #2 On report `done`, every modified, staged and untracked path from `git status --porcelain=v1 -z --untracked-files=all` is checked; a path outside scope and outside the story's own task file parks `scope-violation` with the paths, except a lockfile paired with an in-scope manifest.
- [ ] #3 Verify runs the run profile's verify command through DIPO-37 with network closed, records `verify_results` with exit code, duration and output range, emits `work.phase verify`, and streams its output as `work.output` with source `verify`.
- [ ] #4 Green: exactly the scope paths and paired lockfiles are staged and committed with the worker's subject plus the story id; the result is recorded against the code tree key.
- [ ] #5 Green: the criteria the report marks met are checked off and `<ID>: status In Review` is committed alone through the Backlog CLI, then the branch is pushed without force.
- [ ] #6 Red: a verify feedback item (DIPO-47) is sent as the next user message, `Progress.loop` increases and `verify` shows `failing`; at the tier loop cap the story parks `verify-failing`.
- [ ] #7 Base `verify` from the run profile also runs when the branch changed a gate script, and the changed commands are recorded on the run.
- [ ] #8 At run end a run summary is stored with the final report, diffstat, verify result and last 50 output lines, built without a model.
- [ ] #9 A migration adds `run_outcomes` (0007 amendment of 2026-10-12, kept until purge); one `endRun` function writes one row whenever a run ends, at In Review and at every park of DIPO-50, with tier, role, model, outcome, park reasons, loops, review rounds, verify failures, budget tokens used, minutes, criteria count and scope size.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S33 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
