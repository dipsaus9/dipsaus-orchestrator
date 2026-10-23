# 0019 The review loop for story PRs

Status: Accepted (2026-10-17, maintainer). Proposed in spike DIPO-131, 2026-10-16. Records the M1 planning decisions on merge authority, reviewer defaults and conflicts, the ten spike answers and the secrets answer (listed under "Maintainer decisions"). Amends 0001, 0002, 0005, 0007, 0008, 0009, 0010, 0012, 0014 and 0016 (see "Amends").

## Context

M1a is the first slice of M1 (0003 amendment of 2026-10-16): the engine opens the story PR, a reviewer session reviews it, CI, review and conflict feedback go back to the worker with evidence and send-once signatures keyed on commit, and an approved PR merges through the merge slot. M0 stops at In Review with the branch pushed; 0010 section 7 says "The PR opens in M1". This ADR decides how a delivered story gets from In Review to merged without the maintainer, and how the maintainer steps in when a merge waits for them.

**Split with 0020 (DIPO-132).** This ADR owns the story PR and its record (`story_prs`), the review, CI and conflict loop, the merge slot for story PRs, the merge gate and the override past a blocked review. 0020 owns the resume matrix for every park reason and cause, the plain-text `dipo desk`, and what hold, drop and discard do to an open PR. Parks this ADR causes carry a `parks.cause` (0020 section 2) so 0020 can resume them: `review` for `budget-exceeded`, `worker-failed` (the reviewer crashed twice) or `stopped` (the maintainer stopped a review); `review-cap` for `worker-failed` when the reviewer hit its own turn or minute cap; `rounds` for `review-blocked`; `backstop` for `scope-violation` when the worktree changed during a review; `merge-in-progress`, `unwritable-path` and `slot-refused` for `conflict`; `ci` for `verify-failing` from red checks; `pr-closed` for `stopped`. Also owned elsewhere: per-office required check names (DIPO-133), skills and plugins in model sessions (DIPO-116, DIPO-108, DIPO-130), the test-story command (M1b).

### Facts checked in the code (main at b3f847e)

1. The merge slot (`packages/engine/src/merge-slot/slot.ts`) merges backlog PRs only. Its git is `laneSlotGit` in `<root>/_backlog` (`merge-slot/git.ts`). The occupant, the "left the slot" map and the once-only notices live in memory (`InSlot`, `parked`, `noticed`); a daemon restart forgets them. `CHECKS_WAIT_MS` is 30 minutes and `MAX_MERGE_ATTEMPTS` is 3.
2. The slot waits for the hard-coded `REQUIRED_CHECKS` `ci-ok` and `pr-title` (`merge-slot/checks.ts`); `evaluateChecks` fails on any reported check in bucket `fail` or `cancel`. DIPO-133 makes the names an office setting (`mergeSlot.requiredChecks`).
3. `CodeHost` (`platform/host.ts`) has `findOpenPr`, `createPr` (no draft flag), `updatePr`, `viewPr` (no labels), `closePr`, `squashMerge` (with `--match-head-commit`, subject, empty body) and `requiredChecks` (`gh pr checks --required --json name,state,bucket`, no link). `PrStateHost.findMergedPr` and `PrListHost.listOpenPrs` are separate interfaces. `createPr` is called only from `backlog/pr/feature.ts`. No method reads labels, check links or CI logs, posts a comment, or touches deployments.
4. Verify and commit (`run/verify-commit.ts`, DIPO-49) end the run at In Review (`endRunMarked(..., IN_REVIEW_END)`) after the push; no PR opens. A non-fast-forward push parks `conflict`. There is no `merge-tree` call in `engine/src/run/`: the conflict check before In Review and the building-time sync for riskier stories were deferred in DIPO-15 and DIPO-49.
5. A park ends the run and `reopenParkedRun` (`run/park.ts`) reopens it on resume: `ended_at` cleared, the ended time added to `parked_ms`, the `run_outcomes` row deleted. Caps count time from `capsStartedAt`, moved by `parked_ms` (DIPO-75).
6. `runs.review_round_cap` exists and is written as null (`run/work-run.ts`); `run_steps.kind` allows `review`; `Progress.reviewRound` counts review steps (`views/work.ts`). Nothing writes a review step. `agents.role` is free text.
7. `gates` and `gate_decisions` (migration 13) know kinds `review`, `test` and `merge`; `storyVerdicts` (`views/feature.ts`) reads them. The contract `Verdict` (`contract/src/office.ts`) has `gate`, `run`, `kind`, `decision`, `by`, `note`, `failures` and `at`, and no review payload. The `review_verdicts` table of 0007 section 4 has no migration.
8. `gate.approve`, `gate.reject`, `test.start` and `test.record` are provisional (`contract/src/office.ts`). `GateView` (`contract/src/work.ts`) has `waitingOn` `maintainer` or `rule`. Capability flags and the commands each needs are listed in `engine/src/reads/hello.ts`.
9. `KNOWN_WORKER_KINDS` holds `implement`, `review`, `session` (`workers/types.ts`), but the Claude adapter plans only `implement` (`workers/claude-cli/plan.ts`, `PLANNED_KINDS`). One report schema exists (`workers/claude-cli/report-schema.ts`); `prompts/contract/` has only `implement.md` and `prompts/roles/` only `developer.md`.
10. Verify feedback items carry a sha256 signature (`prompts/feedback.ts`); nothing records which signatures were sent.
11. `work.run` allows one active run per office; `activeRuns` (`run/records.ts`) counts unended story runs with a live claim and every unended session run.
12. The Done poll (`worktree/done.ts`, DIPO-58) runs every `polling.prStateSeconds` (60) and detects Done from the host's merged PR or from `merge-tree`.
13. The session self-test (`workers/claude-cli/self-test.ts`) is a Haiku session whose probes include a control write inside the worktree that must succeed.
14. `.github/workflows/ci.yml` runs on `pull_request` with the default activity types (`opened`, `synchronize`, `reopened`); `pr-title.yml` adds `edited`. `scripts/check-pr-title.ts` caps the subject at `MAX_SUBJECT_LENGTH` 100. The repository is public.
15. Office configuration is at version 2 (`config/schema.ts`). Retention tiers per table live in `retention/policy.ts` (D, R, S, T, P).

## Maintainer decisions

From M1 planning (2026-10-16):

- **Merge authority.** dipo merges a story PR by itself after reviewer approval and green CI, through the merge slot. An office setting switches auto-merge off. A story flagged test-before-merge (0002, 0012) always waits for the maintainer. Never a PR labelled `autorelease: pending`, never a deployment approval. (Section 2.)
- **Reviewer defaults.** A `review` block in `.dipo/office.yaml`: default model Opus, effort high, at most 3 review rounds per story; after round 3 fails the story parks `review-blocked` (shown on `dipo desk`). The reviewer is read-only. Its cost counts toward the story's budget. (Section 4.)
- **Conflicts.** Checked before In Review and before each merge. When the base moved: a plain merge of the base into the branch, never a rebase or force-push. On a conflict the worker gets the conflicting files as feedback, resolves them in the same session, runs verify and goes back to review. After 2 failed attempts the story parks `conflict` (shown on `dipo desk`). (Section 10.)

Spike answers (2026-10-16):

1. **Round counting:** only failed rounds count toward the cap of 3. (Section 6.)
2. **Red CI:** its own counter, `mergeSlot.ciAttempts`, default 2; at the cap the story parks `verify-failing` with cause `ci`. (Section 8.)
3. **Approve past a blocked review:** yes; `dipo approve` with a required note records an override and takes the PR through CI and the merge slot. (Section 11.)
4. **Parallel sessions:** a reviewer may run next to one worker, so up to two Claude sessions per office. (Section 12.)
5. **Review report on GitHub:** each round's full report is posted as a PR comment. (Section 3.)
6. **Missing automated test:** blocks; the reviewer names the test-plan entry and code checks it exists. (Section 5.)
7. **Security or correctness finding** at an exact, quoted line of the change: blocks like an unmet criterion; the worker must fix it; it counts as a failed round. (Section 5.)
8. **Review budget:** `review.budgetTokens`, default 200,000, is added to the story's budget for each review round started. (Section 4.)
9. **Conflicts:** the merge is left in progress for the worker; the engine resolves the story's own task file; a conflict in a path the worker cannot write parks at once. (Section 10.)
10. **CI timing:** review and CI start at once. (Section 7.)

At acceptance (2026-10-17):

- **Secrets.** The public review comment is accepted as a new egress path for development secrets, with a code check: before posting, code removes every value found in the env files dipo copied into the worktree and writes `[redacted]` in its place. The rule that worktree env files hold development secrets only stays. (Section 3.)
- **Design details beyond the answers** are approved as part of this ADR: a criterion only the maintainer can check makes the merge wait (section 11); the reviewer's tool set and caps (section 4); the PR opens ready (section 3); a conflict found while In Review is handled at the next sync (section 10); hold labels and a PR head the engine did not push (sections 7 and 9); the required checks are the office's joined with the host's (section 7); the reviewer receives resolved unknowns, and the phases `review`, `merge` and `test` (sections 4 and 14).

## Decision

### 1. The loop

One story, from the worker's `done` report to Done. Every step is code except the two model sessions (developer and reviewer).

1. The worker reports `done`. Scope check, then verify, then the code commit, as today (0010, 0014).
2. Conflict check against the base; a riskier story also merges the base here (section 10).
3. `<ID>: status In Review` commit, push, then the story PR opens or is updated (section 3). The run's active period ends (section 13).
4. The reviewer session reviews the pushed head (sections 4 to 6), in the office's reviewer place (section 12); CI runs on the same head at the same time (section 7). Each round's report is posted on the PR.
5. Blocking findings, red required checks, a conflict or a maintainer rejection start a fix round: the run reopens, the story goes In Review to In Progress, the developer session gets the feedback (section 8) and the loop starts again at step 1.
6. Review approved and required checks green: the merge gate opens. It is decided by rule, or waits for the maintainer (section 11).
7. The approved PR enters the office merge slot: close-out commit, merge of the base, push, required checks, host merge (section 9). Done comes from the host's PR state (DIPO-58).

### 2. Merge authority (decided)

In code: the merge gate (section 11) is decided by rule when `mergeSlot.autoMerge` is true, the story is not flagged test-before-merge, and no other condition of section 11 holds; otherwise it waits for the maintainer. The label guard and the absence of any deployment call are code (section 7). 0002's rule "automatic merge is allowed only after reviewer pass on unflagged stories" is unchanged; the office switch only narrows it. The maintainer can merge past a blocked review with a recorded override (section 11).

### 3. The story PR

**When it opens.** Options: (A) at the claim, as an early draft; (B) at the first In Review push; (C) only after review approval. A shows unverified work and makes CI run on every park push of a half-done branch. C hides review state from GitHub and leaves CI to start late. **Decided: B.** Right after the In Review push the engine looks for an open PR with the story branch as head (`findOpenPr`, so a crash between push and create never opens a second one) and creates it if there is none. A failed create is a notice and the story stays In Review; the PR poll of section 7 retries every `polling.prStateSeconds` until the PR exists. Every later In Review push updates the same PR.

**The record.** This ADR owns the story's PR record: table `story_prs` (section 16), one row per PR the engine opened for a claim. There is no PR number on `claims`. 0020 reads `story_prs` for the desk and for hold, drop and discard.

**Draft or ready.** Options: (A) open as a draft and mark it ready on review approval; (B) open ready for review. A blocks a hand merge on GitHub until the review passes, but costs a `gh pr ready` call, and an office whose CI skips drafts would get no CI until approval: GitHub runs `pull_request` workflows on drafts by default, but `ready_for_review` is not a default activity type, so the CI of such an office would not rerun when the PR turns ready. **Decided: B, ready.** The engine's merge gate, not GitHub's draft flag, is what stops an engine merge; the maintainer may always merge by hand (section 11).

**Title.** Built by code from the story (0016 rule 3): `<type>(<ID>): <subject>`. Type from the story type: `feature` and `enhancement` to `feat`, `bug` to `fix`, `docs` and `spike` to `docs`, `task`, `chore` and any other type to `chore`. Subject: the story title with trailing full stops removed, its first letter lowercased unless the second character is uppercase (an acronym), cut to at most 100 characters on a word boundary (`MAX_SUBJECT_LENGTH` of `scripts/check-pr-title.ts`). No `!` in M1a: no story fact marks a breaking change yet. A title change on the story is applied at the next PR update. The squash commit subject is the PR title (0016).

**Body.** Built by code from facts, no model text. Sections in this order: the outcome line; acceptance criteria with the number and text, ticked as the story's task file has them; the test plan (automated and manual entries, or the not-applicable reason); the declared scope; a status block; a footer naming dipo and the story's task file path. The status block holds one line each for verify (passed at `<short sha>`), review (pending, round `n` approved at `<short sha>`, blocked with the count of blocking and advisory findings, or approved by the maintainer's override), required checks (name and state), and merge (dipo merges after green checks, or waits for the maintainer and why). The engine updates the body only when the rendered text changed (its hash is stored). The body is capped at 20,000 characters; the story contract is never cut (it is at most `prompt.contractMax`, R26), the scope list may be cut with a marker.

**Review comments** (decided: each round's full report is posted). After each review round the engine posts one PR comment (`gh pr comment`, through the code host, section 7), built by code from the stored verdict, never by a model:

```markdown
### dipo review, round 2 of the story: blocked

Commit `a1b2c3d` · reviewer opus (effort high) · 2026-10-16 14:05 UTC

**Criteria**
- #1 met: <evidence>
- #2 unmet: <evidence>
- #3 maintainer: <evidence>

**Findings**
- blocking · correctness · `packages/engine/src/x.ts:42`
  > `const total = a - b;`
  <text>
- advisory · maintainability · `packages/engine/src/y.ts:7`
  > `<quoted line>`
  <text>

**Summary:** <summary>
```

Rules: one comment per round, posted once and never edited or deleted afterwards; a later round gets a new comment. An approval carried to a new head (section 6) posts nothing. A finding that failed its evidence check is listed as advisory with "(unverified)". The comment holds the report only: no prompt text, no token counts or cost, no session or run ids, no worker report. It is capped at 60,000 characters (GitHub allows 65,536); over the cap advisory findings are cut first, with a marker. The comment URL is stored on the verdict. A failed post is a notice and is retried by the PR poll; it never blocks or delays the gate, a fix round or a merge. A maintainer override (section 11) is shown in the body's status block, not as a comment.

**What a public comment can reveal.** The repository is public and so is the PR's diff. The reviewer is read-only and reads only the worktree (0008 section 2 fences reads to it, and the same deny rules as the worker's keep `.env*` files closed to the Read tool), so its quotes are lines of tracked files at the reviewed commit, and code checks every blocking quote against a changed line. Evidence and summary are free model text and could repeat other worktree content; the worktree holds only what the branch would publish, plus the copied env files the reviewer cannot read through its file tools. The residual risk is that a gitignored env file, readable by a Bash command, is quoted in free text; 0008's rule that worktree env files hold development secrets only applies, and the comment format never includes command output.

**Env values are redacted before posting** (maintainer, 2026-10-17). Before the engine posts a review comment, code removes from the rendered comment every value found in the env files dipo copied into the story worktree (the `copy` entries of `worktree.files`, 0010 section 8), read as `KEY=value` lines, and writes `[redacted]` in its place. The check runs on the whole comment (criteria evidence, findings, quotes and summary), after the size cap. A copied env file that cannot be read when the comment is built holds the comment back: a `pr.commentFailed` notice, retried by the PR poll. The stored verdict keeps the reviewer's text unchanged; only what leaves the machine is redacted. This accepts the public PR comment as a new egress path for development secrets with that check; the rule that worktree env files hold development secrets only stays.

### 4. The reviewer session

**Who.** A built-in agent role `reviewer`, used only by the `review` kind. It is not a story role: R17 and the roster are unchanged, and a story cannot name it (0003: one developer role until M4; 0014 L2 already lists a built-in reviewer). The reviewer is a new agent of the story's run (section 13), always a fresh session, never resumed (0008 section 8, 0014 section 6).

**Model, effort and caps.** From the `review` block (section 16): `model: opus`, `effort: high`, `maxRounds: 3` (failed rounds, section 6), per session `maxTurns` (default 60) and `maxMinutes` (default 30), and `budgetTokens` (default 200,000). All are snapshot on the run at its start (`runs.review_round_cap`, `review_max_turns`, `review_max_minutes`, `review_allowance`), as 0020 section 5 decides for every cap, so a config edit never changes a running story's limits. The reviewer's tokens count toward the story's budget (decided). When a review round starts, the run's budget limit grows by the snapshot `review_allowance` (decided); a retried session of the same round adds nothing. The allowance is configuration the maintainer set, recorded on the round's `run_steps` row, so it is never a silent raise. The reviewer's turns and minutes count only toward its own session caps, never toward the developer's (section 13).

**Tools.** Options: (A) Read, Glob and Grep only, the diff in the prompt; (B) the same plus Bash, sandboxed read-only; (C) a full developer tool set in a separate review worktree so it can run tests. A cannot read the part of a large diff that the prompt budget cut (0014 section 4 says the reviewer reads the rest from the worktree) or run read-only git. C pays for a second install per round and repeats what verify and CI already prove. **Decided: B.** `--tools Read,Glob,Grep,Bash`; no Edit, Write, WebSearch or WebFetch (the web tools 0020 gives workers are not the reviewer's). The Bash sandbox and the run settings are the worker's (0008 section 2) with these changes: the story worktree is in `denyWrite` next to `<main>/.git` and the `<worktree>/.git` pointer, so the only writable roots are the sandbox temp directory and the run's short temp root (DIPO-118); the network stays closed with no Safe-Chain proxy, since a reviewer installs nothing; the session self-test puts its control write in the run temp root instead of the worktree, because the worktree must refuse it, and drops the pinned-install probe of DIPO-84: with no proxy an install must fail, so the self-test requires it to fail. The fail-closed launch checks of 0008 apply unchanged. After the session the 0008 backstop compares the worktree with its state before the review; any change parks `scope-violation` with cause `backstop`.

**Hygiene.** No plugins: `worker.plugins` does not apply to the reviewer, every installed plugin is switched off as in DIPO-108, and a `system/init` that lists one refuses the session. No skills: `--disable-slash-commands` and the `system/init` skills check of DIPO-130; DIPO-116 decides whether a reviewer ever gets skills. No MCP servers: `--strict-mcp-config` with an empty config. `--setting-sources project,local` and the project settings allowlist apply as for workers.

**What it receives** (L4 of the `review` kind, 0014 section 2, extended): story id, title, type and tier; outcome; criteria numbered as in Backlog.md; scope; test plan with its entry numbers; resolved unknowns with their answers; the gate script changes the run recorded (0013: a branch that changes `test`, `lint`, `typecheck` or `verify` is always reported to the reviewer); the changed-path list with line counts; the diff from the merge base without the story's own task file, within the 0014 diff budget (over budget: per-file stat plus the largest hunks, the rest read with `git diff` in the worktree); on a re-review, the previous round's findings. Never: the worker's report, notes, handoff, reasoning or transcript (0002). L1 for the `review` kind (`prompts/contract/review.md`) states: you are read-only; judge the diff against the outcome, the criteria and the test plan; report security and correctness problems you can point to at an exact changed line; the engine has already checked which paths changed, so do not report paths outside scope; your report is posted publicly on the PR; report in the schema. L1+L2 are golden-tested like the developer's.

**Failure handling.** Every park here except the `scope-violation` row is recorded with `parks.cause = 'review'` (or `review-cap` for the reviewer's own cap); 0020 resumes it as a fresh reviewer session on the same head, not a developer session. A `work.stop` during a review parks `stopped` with cause `review`.

| Case | Action |
|---|---|
| Report missing or invalid against the schema | One correction turn in the same session ("report in the schema"); still invalid: as a crash |
| Blocking finding whose evidence does not check out (section 5) | One correction turn naming the findings; still failing: kept as advisory, marked unverified |
| Crash, host lost without exit file | One new fresh session for the same round; a second failure parks `worker-failed` with the reviewer's last error. The round is not counted |
| Reviewer turn or minute cap | Park `worker-failed` with cause `review-cap`, detail names the cap; no retry, the same cap would fire again. Not `budget-exceeded`: the story's budget did not run out |
| Story budget used up during review | Stop the session, park `budget-exceeded` (resume by top-up, 0020) |
| Plan limit (`rejected`) | Stop the session; a fresh review starts after the reset (the reviewer is never resumed, 0008 section 8, an exception to 0008 section 7's resume after a reset); never a park |
| `startFailed`, refused launch check | Adapter hold and `engine.notice` as in 0008; the story stays In Review and the review waits |
| Worktree changed after the session | Park `scope-violation` with cause `backstop` and the evidence (0008 backstop) |

### 5. The reviewer report and the verdict

The reviewer reports through the adapter's report channel (`--json-schema`, 0008), with a schema of its own kind. Options for who decides the verdict: (A) the reviewer returns approved or blocked; (B) the reviewer returns per-criterion results and findings, and code computes the verdict. **Decided: B**, because the blocking rules are deterministic once the facts are in.

```ts
ReviewReport = {
  criteria: { n: number, status: "met" | "unmet" | "maintainer", evidence: string }[],  // exactly one per criterion
  findings: { severity: "blocking" | "advisory",
              kind: "scope" | "test" | "correctness" | "security" | "maintainability" | "other",
              criterion?: number, testEntry?: number, file?: string, line?: number, quote?: string, text: string }[],
  summary: string,   // at most 1,500 characters
}
```

Validation by code, at the reviewed commit:

- `criteria` has exactly one entry for each criterion number of the story; `unmet` and `maintainer` need non-empty evidence. A missing or extra number makes the report invalid.
- `maintainer` means only the maintainer can check it (an approval, a manual step). It does not block the review; it makes the merge gate wait for the maintainer (section 11).
- **What may block** (0002 plus decisions 6 and 7): kind `scope`, kind `test` (a missing automated test-plan entry), and kinds `security` and `correctness`. `maintainability` and `other` marked blocking are stored as advisory. That is a rule, not a correction turn.
- **Evidence for a blocking finding.** `scope`, `security` and `correctness` need `file` (one of the changed paths), `line` (a line of that file at the reviewed commit, inside a hunk of the story's diff) and `quote` (equal to that line after trimming whitespace). `test` needs `testEntry`, the number of an automated test-plan entry of the story; code checks the number exists and is `automated`, and `file` and `line` are optional for it. Failures get one correction turn, then the finding is kept as advisory, marked unverified.
- **Verdict:** `blocked` when a criterion is `unmet` or a validated blocking finding exists; otherwise `approved`. A blocked verdict is a failed round (section 6), whatever the kind of finding.

**Scope findings and the engine's scope check.** Path-level scope belongs to code only: the engine's scope check at `done` (0010, 0014) parks `scope-violation` before any review, so a reviewed diff never holds a path outside scope. The reviewer's `scope` kind covers content inside in-scope paths that goes beyond the outcome and criteria, for example behaviour the story did not ask for or an unrelated rewrite. That is the "scope violation" of 0002 that only judgment can see; it blocks, with a quoted line as evidence.

**Advisory findings** never block and never start a fix round on their own (0002). They are stored with the verdict, posted with it, and listed in a fix round's message as optional when a fix round happens for another reason.

### 6. Review rounds and review keyed on the commit

**A review round** is one reviewer session that returns a valid report on a code tree that has no verdict yet in this claim. A session that failed (section 4) is not a round. `run_steps` gets a `review` step when the round starts, so `Progress.reviewRound` counts rounds started.

**The cap counts failed rounds** (decided). Options weighed: (A) every round counts, at most 3 in total; (B) only rounds whose verdict is `blocked` count. Under A a story whose round 1 was approved and whose CI then failed twice would park `review-blocked` although the reviewer never objected. Under B only the reviewer's objections use the cap, and the story's budget bounds the total number of rounds. The maintainer chose B, read as "after round 3 fails". When the third failed round ends, the story parks `review-blocked` with cause `rounds` and the last verdict's blocking findings as the park detail. A maintainer override (section 11) or a resume with a note (0020: one more round) are the ways on.

**Keyed on the commit.** Each verdict is stored with the reviewed commit and its code tree key (0010: the hash of `git ls-tree -r HEAD` without the story's own task file). The engine never starts a review of a code tree key that already has a verdict in this claim, across daemon restarts (research idea 17). A verdict holds for every commit with the same code tree key.

**Re-review is skipped** when:

1. the code tree key already has a verdict: commits that change only the task file (In Review, park, In Progress, the close-out) never trigger a review;
2. the new head is an approved head plus a clean merge of the base made by the engine and task-file commits only. The engine knows this from its own ref journal. This is 0016's "clean merge-time sync needs no re-review", and it also covers a clean building-time sync after an approval. The approval is recorded as carried to the new head.

Any change the worker made after a verdict (a fix round, a conflict resolution) gets a new round, with the previous findings in the prompt.

### 7. CI on the story PR

**Which checks.** The merge waits for the union of the office's `mergeSlot.requiredChecks` (DIPO-133; defaults `ci-ok` and `pr-title`) and the checks the host marks required (`gh pr checks --required`). Both sets must pass on the head the engine pushed. A check the host has not reported counts as pending.

**Timing against the review** (decided: at once). Options weighed: (A) CI and review at the same time on each In Review head; (B) CI first, review only on green CI. CI runs more than the local verify did (the CI-only tests under `DIPO_TEST_CI=1`, smoke builds on four targets, shellcheck, dependency review), but those extra jobs rarely fail on a story's change. B would save a review when CI is red but adds a CI run's wait before every review; with a reviewer place of its own (section 12) the review never waits for a worker either. A fix round waits until the head's verdict is in and its required checks are final (or the wait cap passed), so one round carries all feedback for that head. The merge gate opens only when the review approved and the required checks are green.

**Polling.** One PR poll per office, every `polling.prStateSeconds` (60 s), for each story PR that has unfinished required checks on its pushed head, an unposted review comment, or no PR yet: one `gh pr view` (state, head, labels) and one `gh pr checks`. That is two GitHub API calls per waiting PR per minute, far under GitHub's hourly limit for the one or two In Review stories of M1a. A PR whose checks are final for its head is not polled again until the head changes. `gh` has no conditional requests; accepted. The Done poll (DIPO-58) stays as it is. A head whose required checks are still not final after `mergeSlot.checksWaitMinutes` (default 30, today's `CHECKS_WAIT_MS`) raises one `ci.stuck` notice; polling then slows to every 10 minutes for that head; the story waits in phase `merge` and holds no session place.

**Logs.** When a required check fails, the engine lists every check of the head (`gh pr checks --json name,state,bucket,link,workflow`, without `--required`). For each failed check whose link is a GitHub Actions job (`/actions/runs/<run>/job/<job>`) it runs `gh run view --job <job> --log-failed`, reads at most 1 MiB of output keeping the tail, with a 60-second timeout. A failed aggregate check whose failure is explained by other failed jobs of the same workflow run (as `ci-ok` is) is named but gets no log. A check that is not an Actions job gets its name, state and link only. The tail is cut to 0014's feedback budget (60 lines, 3,000 characters per item, 8,000 per message) and `file:line` locations are parsed with the verify parsers. Logs are fetched once per failed head; the rendered item is stored (section 8), so a later handoff never fetches the log again.

**Auth.** Through the engine's code host only, outside any sandbox, with the maintainer's own `gh` login (0008 section 2). The new calls (labels, all checks with links, failed job logs, `gh pr comment`) go on a separate interface next to `PrStateHost` and `PrListHost`, so the existing `CodeHost` fakes stay as they are. Workers and the reviewer never get `gh`. Log text reaches the worker as data in a fenced block of the feedback template.

**The `autorelease: pending` guard and deployments.** Before a PR enters the merge slot and again right before the host merge, the engine reads the PR's labels. A PR labelled `autorelease: pending` is never merged by the engine, in any office, for any PR kind (backlog PRs included); the label is in the code, not only in the office default, so no setting removes it. Its merge gate waits for the maintainer, and `gate.approve` on it answers `gate.handMergeOnly`, naming a hand merge on GitHub as the only way. A label in `mergeSlot.holdLabels` also holds the PR: the gate waits for the maintainer, an approval is recorded, and the engine re-checks the label at each poll and merges only once the label is gone. No engine code calls a deployment or environment API; a unit test asserts that the code host builds no `gh` command naming deployments or environments. Release PRs are never story or backlog branches, so the engine has no other path to them.

### 8. Fix rounds and send-once feedback

**Sources** that start a fix round: blocking review verdict; red required checks on the pushed head (in review or in the merge slot); a conflict (section 10); `gate.reject` from the maintainer (section 11).

**One round per head.** All feedback for one pushed head goes in one user message. Conflicts and maintainer rejections are sent at once, as nothing else is pending for them. The round: the run reopens (section 13) and waits for the office's worker place (section 12); the engine commits `<ID>: status In Progress` (lane a, 0012 transition In Review to In Progress); the developer session resumes when `canResume` holds (0008 section 8, 0014 section 6), else a new session gets a handoff with the feedback; phase `build`. From there the worker's `done` goes through the normal gates again.

**Items and signatures** (0014 section 7, research ideas 5, 14 and 17). Each item is built by code from the failing fact, with a sha256 signature over fields that identify the failure, not over free text:

| Source | Evidence in the item | Signature over |
|---|---|---|
| Verify | As today (step, command, exit code, tail, locations) | step, command, exit code, locations (today's) |
| CI | Check name, job, failing step names, log tail, locations | check name, job name, failing step names, locations |
| Review | Criterion number and text and the evidence for an unmet criterion; for a finding: kind, `file:line`, the quoted line or the test-plan entry, the text | criterion number and status; or kind, file and the quote with whitespace collapsed; or kind and test-plan entry number |
| Conflict | Conflicted paths and conflict hunks within budget | base commit and the sorted conflicted paths |
| Maintainer reject | The note, verbatim | none: always sent once, keyed on the gate id |

**Storage.** A new table `feedback_items` (run, item id, source, signature, head commit, round, sent time, the intent that carried it, and the rendered item text, at most 3,000 characters, the 0014 per-item budget), retention tier S with its run. Storing the text lets 0020's handoff list open feedback without fetching CI logs again. The row is written in the same transaction as the steer intent that sends it (`run_intents`, DIPO-50), so a restart neither loses nor repeats it.

**Send-once.** An item is sent at most once per head commit: repeated polls, a daemon restart or a second CI run on the same head send nothing new. The same signature on a later head is a repeat: it is sent again, marked "still failing after your last change". Two sends in a row of the same verify or CI signature raise the watchdog signal `same-failure` (0009). Repeats never park on their own; parks come from the caps below.

**Caps per source** (red CI decided: its own counter). Options weighed for red CI: (A) the review round cap, as 0016 rule 2 and the 2026-10-10 0012 line said; (B) the tier's `loops`, shared with local verify (a tier S story has 3 in total); (C) its own counter. The maintainer chose C.

| Source | Counter | At the cap |
|---|---|---|
| Verify red (local) | tier `loops` (today) | `verify-failing`, cause `loops` |
| Required checks red | `mergeSlot.ciAttempts` (2) | `verify-failing`, cause `ci` |
| Review blocked (any blocking kind) | failed rounds, `review.maxRounds` (3) | `review-blocked`, cause `rounds` |
| Conflict | failed conflict hand-offs, `mergeSlot.conflictAttempts` (2) | `conflict`, cause `merge-in-progress` |
| Host refused the merge because the base moved | per stay in the slot, 3 (0010, 0016, unchanged) | `conflict`, cause `slot-refused` |
| Maintainer reject | none; the budget bounds it | none |

All caps are snapshot on the run at its start (`runs.loop_cap`, `review_round_cap`, and new `ci_cap` and `conflict_cap`), as 0020 section 5 decides; 0020's grants (`loop`, `reviewRound`, `ciAttempt`, `conflictHandoff`, `reviewCap`) add to them. Every token spent in any round counts toward the story's budget (plus the review allowance, section 4); running out parks `budget-exceeded` as today.

### 9. Merging story PRs through the merge slot

0016 rule 2's steps, now for story PRs, in the same one-PR-at-a-time slot as backlog PRs (first come, first served by the time each became eligible).

- **Entry.** The merge gate is approved (by rule or by the maintainer), the review verdict holds for the head (or a maintainer override does), the required checks were green on it, and no hold label is on the PR.
- **Steps**, each its own item of the office git queue, in the story worktree: (1) the close-out commit on the branch (final summary, modified files, status `Done`; provisional until the host merge, 0010); (2) merge the base unless the branch contains it; a conflict leaves the slot and becomes a conflict hand-off (section 10); (3) push once, never forced; (4) wait for the required checks on that head; red leaves the slot and is a fix round with CI feedback (section 8); (5) label guard, and a check that the host's PR head equals the head the engine pushed; (6) squash-merge with `--match-head-commit` and the PR title as subject; a refusal because the base moved goes back to (2), at most 3 times, then `conflict` with cause `slot-refused` (0016).
- **Persisted.** The slot's occupant, phase, pushed head and attempt count are stored in a new table `merge_slot`, so a daemon restart continues with the same occupant instead of forgetting it. Retention tier P in `retention/policy.ts` (no age rule); the slot code deletes the row when the PR merges or leaves the slot, so nothing of it is history. Every step is idempotent: a sync finds the base contained, a push finds nothing to push, a merge finds the PR merged. Backlog PRs keep their own rules (structural check, rebuild on conflict) and gain the persistence and the label guard.
- **Hand changes on GitHub.** The engine never merges a head it did not push. If the host's PR head differs from the head the engine pushed (someone pushed to the branch), the story stays out of the slot, a `pr.headChanged` notice names both heads, and the desk shows a `PR HEAD CHANGED` item (0020 section 12) with two actions: a hand merge on GitHub (picked up by the Done poll) or `dipo discard`. No merge gate opens for it, so `dipo approve` cannot send such a head through the slot. A story PR closed without a merge outside dipo parks the story `stopped` with cause `pr-closed` and the detail "PR #n was closed on the host"; 0020 decides what its resume does. Comments on the PR are not read in M1a: the maintainer steers through dipo commands.

### 10. Conflicts (decided) and the building-time sync

**When.** (1) Before In Review: after the scope check, green verify and the code commit, the engine fetches and runs `git merge-tree --write-tree origin/<base> HEAD` (0010 conflict check). (2) Before each merge: step (2) of the slot. (3) While a story is In Review, each fetch runs the same `merge-tree` check; a conflict found then is shown (a notice and the story detail) and handled at the story's next In Review sync or merge-slot sync, so a moving base does not start extra rounds.

**Riskier stories sync while building** (0010 open question 3, answered 2026-10-10: tier `L` or flagged test-before-merge). At point (1) such a story always merges the base, even when `merge-tree` is clean. After a clean sync the engine reinstalls when the lockfile changed and runs verify again; red is a verify loop. Other stories merge the base at point (1) only on a conflict. The base is merged after the code commit, so verify runs twice for a riskier story; in exchange every commit on the branch stays green and the worktree is clean when git merges.

**Leave the merge in progress** (decided). Options weighed: (A) abort the merge (`git merge --abort`) and send the conflict as text, as 0016 rule 2 step 2 and 0010 section 2a said; (B) leave the merge in progress in the story worktree for the worker to finish, and conclude it in code. Under A the worker, which has no git write (0014), could never produce the merge, and every conflict would end in a park. The maintainer chose B. The hand-off:

- The engine runs `git merge --no-ff --no-edit origin/<base>` in the story worktree (hardened git, outside the sandbox) and on a conflict leaves the merge in progress. The merge state is not stored; code derives it from git whenever it needs it: `MERGE_HEAD`, the unmerged index entries (the conflicted paths), and the blob id of every cleanly merged path from `git merge-tree --write-tree HEAD MERGE_HEAD`. So a daemon restart or a later resume (0020) reads the same state the hand-off saw. It refreshes the run's backstop snapshot, so the base's changes under `backlog/` and `.dipo/` that the merge staged are not read as the worker's.
- **The story's own task file** is resolved by the engine, never by the worker: the branch's field block and status, and the base's other changes to that file, written through the single field write path (0010 section 3).
- **A conflict in any other path the worker cannot write** (a path the worker's deny rules protect: other `backlog/` files, `.dipo/`, the `.claude` settings files) cannot be handed off: the engine aborts that merge and parks `conflict` at once with cause `unwritable-path`, detail naming the paths.
- Otherwise it sends the conflict item (section 8) to the developer session once the worker place is free: resumed when `canResume` holds ("the same session", as decided), else a new session with a handoff. The worker edits the conflicted files and reports `done`.

At `done` during a merge, in order: every conflicted path must be free of conflict marker lines (a line starting with `<<<<<<< `, `=======` or `>>>>>>> `), else one feedback turn naming them; the scope check covers paths whose content differs from the derived merge result, and the conflicted paths count as in scope; verify runs; green, the engine stages the conflicted paths and the worker's scope changes and commits the merge (`git commit --no-edit --no-verify`, hardened). Then In Review and a new review round (section 6).

**Attempts.** The counter counts failed hand-offs only. A hand-off fails when the worker reports `blocked`, or when conflict markers or unmerged paths remain after the one feedback turn. A red verify during a hand-off is a loop like any other; reaching the loop cap parks `verify-failing` with the merge still in progress. A hand-off that ends in a merge commit is not a failure, even if the base later conflicts again; that new conflict is a new hand-off. At the second failed hand-off the story parks `conflict` with cause `merge-in-progress` and the conflicted paths as detail. The merge stays in progress in the kept worktree; 0020's resume continues it (and, if the base moved since, aborts it and merges again).

**A conflict fix is not a loop and not a review round.** It has its own counter of 2 failed hand-offs (decided). The verify after it counts as a loop like any verify, and the review after it is a round, which counts toward the cap only if it fails.

**Re-claim of a kept branch** (0010 section 2a) uses the same hand-off, so a code conflict there also leaves the merge in progress instead of aborting it.

### 11. When a merge waits for the maintainer

**When.** The merge gate waits for the maintainer when any of these holds: `mergeSlot.autoMerge` is false; the story is flagged test-before-merge; the reviewer marked a criterion `maintainer`; the story passed review only by a maintainer override (that override gate is the merge gate, and its approval is the merge decision); the PR carries a hold label. (A PR whose head changed outside dipo gets no gate; section 9.) Otherwise it is decided `approved` by `rule` and recorded, so the audit trail shows every merge decision.

**The gate.** It opens (`gate.reached`, kind `merge`, `waitingOn: "maintainer"`) when the review approved and the required checks are green on the head: the maintainer approves only something that can merge. Its summary, built by code, names why it waits and what to do; for a flagged story it lists the manual test-plan entries and the worktree path to test in, because the test-story command arrives in M1b. Phase: `test` for a flagged story, `merge` otherwise. The run is not active while it waits (section 13).

**Options for the release.** (A) `gate.approve` and `gate.reject` only; (B) a hand merge on GitHub only; (C) both. **Decided: C.**

- `gate.approve { gate, note? }`: decided `approved` by `maintainer`; the PR enters the slot (a held label still holds it, section 7). A clean merge-time sync keeps the approval. A later fix round (conflict, red checks) changes the code, so after it the gate opens again with a new id and needs a new approval.
- `gate.reject { gate, note }` (`confirm: true`): decided `rejected`; a fix round with the note as the item (section 8). For a flagged story this is the failed test until M1b's `test.record` takes over.
- A hand merge on GitHub: the Done poll (DIPO-58) detects the merged PR, and in the same transaction the open gate is decided `approved` by `maintainer` with the note "merged on the host". Teardown follows as today.
- Both commands answer the new code `gate.notWaitingOnMaintainer` for a gate decided by rule, and `gate.approve` answers `gate.handMergeOnly` for a PR labelled `autorelease: pending`.

**Approving past a blocked review** (decided: yes, with a recorded override; 0002: the human keeps merge authority). When a story parks `review-blocked`, the engine also opens a merge gate (kind `merge`, waiting on the maintainer) whose summary is the last verdict's blocking findings. `gate.approve` on it needs a note (`gate.approve` answers `gate.noteRequired` without one) and records a maintainer override of that verdict: a `gate_decisions` row by `maintainer` with the note, and the verdict marked overridden. The park is resolved (0020: `resolved_how = override`), the status goes back to In Review with no session, and the PR goes through the required checks and the merge slot like any approved PR. Under `strict` the slot also brings the branch up to date, which a hand merge would leave to the maintainer on GitHub. A code change after the override (a merge-time conflict fix, red CI fix) gets a normal review round again. The override is a recorded fact, never automatic.

**CLI.** `dipo approve <ID> [--note <text>]` and `dipo reject <ID> --note <text>` (asks to confirm). The CLI reads the story's open gate that waits on the maintainer from `story.detail` and sends its `GateId`; with none it prints that nothing waits and exits 1 (`dipo gate` stays the Ready gate check). Events: `gate.reached` and `gate.decided`, both shipping in M1a. `dipo desk` (0020) lists each such gate as a row with the story, the PR number and link, why it waits, and the two commands; the TUI desk (M1b) binds them to `y` and `n` as 0009 section 5 already shows.

### 12. Capacity and plan limits

**Two places per office** (decided: a reviewer may run next to one worker). Each office has a **worker place** for one developer session (a first run, a fix round, a conflict hand-off, or a resumed developer session) and a **reviewer place** for one reviewer session. So at most two Claude sessions run per office. M2's parallel workers are unchanged: until M2, `work.run` keeps one worker per office (`maxAgents` above 1 is refused).

- **Worker place, start order:** maintainer resumes of developer sessions (0020 section 1 queues a resume that finds the place taken), then conflict hand-offs and fix rounds of claimed stories, then new pickups by `work.run`. A worker question waiting for an answer (0020 section 7) keeps its process and holds the place for at most `timeouts.questionWaitMinutes`.
- **Reviewer place, start order:** maintainer resumes that start a fresh review (0020: `budget-exceeded`, `worker-failed`, `stopped` with cause `review` or `review-cap`, a backstop park raised during review), then pending reviews, oldest In Review first.
- A story that waits for CI, for the maintainer or in the merge slot holds no place. The engine-only steps of the merge slot need no place.
- **Counting.** Story capacity counts open story runs with a live or starting session, per place, from the agent's role; session runs are left out (2026-10-16 review finding). `activeRuns` and `hasActiveRun` keep counting session runs, because `office.forget` and `dipo daemon status` must see them. Session runs get their own capacity rule with the M1b scan fallback.

**Plan limits** (0008 section 7) apply to both places by scope: a session or weekly hold pauses both places in every office; a model-family hold pauses the place whose session uses that family (an Opus hold stops reviews, and also a worker whose tier model is Opus); `allowed_warning` stops new sessions of that scope in both places. On `rejected` during a review the session is stopped and a fresh review starts after the reset, because the reviewer is never resumed (0008 section 8). A story waiting under a hold shows health `limited`. Two sessions per office use the plan's limits faster; the holds make that wait, never park.

### 13. The run across review rounds

Options: (A) a new run per round (implement, review, fix); (B) one run per claim whose active periods end and reopen. A needs story-level sums for budget, loops and rounds across runs, and a claim row per run. **Decided: B**, using the mechanism a park resume already uses. In Review still ends the run's active period (DIPO-49). A review round, a fix round or a conflict hand-off reopens the run as `reopenParkedRun` does: the ended time is added to `parked_ms` (or an equivalent idle total), so the developer's minute cap counts only developer working time. A review session's own time is also kept out of the developer's minute cap: when the review ends, its duration is added the same way, and the reviewer has its own minute cap (section 4). The developer's `--max-turns` remainder and the run's turn cap count only developer agents; reviewer turns count only toward the reviewer's cap. The provisional `run_outcomes` row is rewritten at each end. The reviewer is an agent of the run (role `reviewer`), so the run's usage, and with it the story budget, includes the reviewer's tokens without new arithmetic. Done writes the final outcome (end kind `done`), with loops, review rounds and failed rounds, CI attempts, conflict hand-offs and any override, for retro.

### 14. Where verdicts show

- `story.detail`: each review verdict as a `Verdict` with a new optional `review` field: round, commit, code tree key, verdict, per-criterion results, findings (with `unverified` where it applies), summary, reviewer model and usage, the comment URL, whether the approval was carried to a later head, and any maintainer override.
- The PR: one comment per round (section 3) and the body's status block.
- Events: `gate.decided` for a review gate gains an optional `review` summary (round, commit, verdict, count of blocking and advisory findings, comment URL). `gate.reached` and `gate.decided` for merge gates (section 11). `story.pr` when a PR opens, changes state or gets a new head. `work.phase` with `review`, `merge` and `test`. `story.parked` for `review-blocked` carries the blocking findings in `detail`, for `conflict` the conflicted paths, with the cause (0020).
- `StoryView.pr` (number, URL, state) and `Progress.reviewRoundCap` and `Progress.reviewRoundsFailed`, so a client shows "round 2, 1 of 3 failed" without computing it.
- Evidence labels (0009): criteria results and findings are `claimed` (the reviewer said so); a quote checked against the commit and the computed verdict are `checked`.
- `dipo desk` (0020): `review-blocked` (with the override action) and `conflict` parks with their evidence, merge gates waiting on the maintainer, PRs whose head changed outside dipo. The TUI shows phase and round in M1a as it does today and the verdict detail in M1b.

### 15. Contract additions

All additive (0005 section 11), in the unreleased minor 1 or the next minor, whichever is current when they ship:

- Commands shipped: `gate.approve`, `gate.reject` (provisional until now). No new command; the PR, the review, the comment and the merge are engine work.
- Events: new `story.pr { story, key, pr: { number, url, state } }`; `gate.decided` gains optional `review` (`ReviewSummary`).
- Reads: `Verdict.review` (`ReviewVerdict`), `StoryView.pr`, `Progress.reviewRoundCap` and `Progress.reviewRoundsFailed`, all optional.
- Error codes: `gate.notWaitingOnMaintainer`, `gate.handMergeOnly` and `gate.noteRequired` (office, not retryable).
- Capability flag `review`, listed in `engine/src/reads/hello.ts` with the commands it needs: `gate.approve`, `gate.reject`.
- Notice codes: `pr.opened`, `pr.openFailed`, `pr.headChanged`, `pr.closedOnHost`, `pr.commentFailed`, `review.failed`, `ci.failed`, `ci.stuck`, `merge.held`, and the story variants of the `mergeSlot.*` codes.

### 16. State and configuration

**State** (0007), each table registered in `db/schema.ts` and `retention/policy.ts`: `story_prs` (key, run, number, URL, branch, base, pushed head, state, body hash, opened and closed times; tier S); `review_verdicts` (as 0007 section 4 lists, plus the validation notes, the comment URL, the carried-from commit and any override; tier S); `feedback_items` (section 8; tier S); `merge_slot` (section 9; tier P, its row deleted by the slot code when its PR merges or leaves the slot). Review and merge gates are rows in `gates` and `gate_decisions`. `runs` gains `ci_cap`, `conflict_cap`, `review_max_turns`, `review_max_minutes` and `review_allowance`, and `review_round_cap` is written; `run_steps` gets `review` steps with the allowance added.

**Configuration** (`.dipo/office.yaml`). The merge keys extend DIPO-133's `mergeSlot` block. Version order of the office config: DIPO-133 (`mergeSlot.requiredChecks`), then this ADR's story A (`review` block and the other `mergeSlot` keys), then 0020's office keys (story 17: `worker.web`, then story 13: `scope.packages` and `scope.restricted`), then DIPO-116 (skills, M1b); each takes the next version with its in-memory migration (0017 amendment of 2026-10-12).

```yaml
review:
  model: opus           # decided
  effort: high          # decided
  maxRounds: 3          # failed rounds before review-blocked; decided
  maxTurns: 60
  maxMinutes: 30
  budgetTokens: 200000  # added to the story's budget per review round started; decided
mergeSlot:
  requiredChecks: [ci-ok, pr-title]   # DIPO-133
  autoMerge: true       # false: every story merge waits for the maintainer
  conflictAttempts: 2   # failed hand-offs; decided
  ciAttempts: 2         # red required checks before verify-failing; decided
  holdLabels: []        # extra labels the engine never merges while present; "autorelease: pending" is always held
  checksWaitMinutes: 30
```

### 17. Not in M1a

Reviewer runs on bot PRs (0016 rule 11), the test-story command and test gates (M1b), reading PR comments, more than one worker per office (M2), and a `review` ritual command (M3).

## Amends

Dated notes, one per touched ADR, each added under its "Amendments" (maintainer, 2026-10-17):

- **0001:** "2026-10-16, DIPO-131 (maintainer): the review-round hard cap counts failed rounds only: a round whose verdict is blocked counts, an approved round does not; the cap is 3 by default (`review.maxRounds`)."
- **0002:** "2026-10-16, DIPO-131 (maintainer): (1) Besides an unmet acceptance criterion and a scope violation, three findings block a story: an automated test-plan entry with no test (the reviewer names the entry, code checks it exists), and a security or correctness problem at an exact changed line, quoted, which code checks against the commit. Each counts as a failed review round. (2) The review round cap counts failed rounds only. (3) An office setting (`mergeSlot.autoMerge`) can switch automatic merge off; a criterion only the maintainer can check also makes the merge wait for the maintainer. (4) The maintainer may merge past a review-blocked story with `dipo approve` and a required note; the override is recorded and the PR still goes through the required checks and the merge slot. (5) Each review round's report is posted as a PR comment built by code."
- **0005:** "2026-10-16, DIPO-131 (maintainer): contract 1.1 (or the next unreleased minor). `gate.approve` and `gate.reject` ship. New event `story.pr`; `gate.decided` gains optional `review`; `Verdict.review`, `StoryView.pr`, `Progress.reviewRoundCap` and `Progress.reviewRoundsFailed` are added, all optional; new codes `gate.notWaitingOnMaintainer`, `gate.handMergeOnly` and `gate.noteRequired`; capability flag `review`. Additive."
- **0007:** "2026-10-16, DIPO-131 (maintainer): section 4. New tables `story_prs` (tier S), `review_verdicts` (tier S, as listed here, plus validation notes, comment URL, carried-from commit and override), `feedback_items` (tier S, with the rendered item text up to 3,000 characters) and `merge_slot` (tier P, its rows deleted when the PR merges or leaves the slot). `runs` gains `ci_cap`, `conflict_cap`, `review_max_turns`, `review_max_minutes` and `review_allowance`. A story run ends its active period at In Review and reopens for review rounds, fix rounds and conflict hand-offs; its final outcome is written at Done."
- **0008:** "2026-10-16, DIPO-131 (maintainer): sections 1, 2, 7 and 8. The Claude adapter plans the `review` kind: tools Read, Glob, Grep and Bash only, the story worktree write-denied in the sandbox, network closed with no Safe-Chain proxy, no plugins, skills or MCP servers; its self-test writes its control file in the run temp root and requires an install to fail. `WorkerPort.reportSchema` becomes per kind. A reviewer turn or minute cap parks `worker-failed` with cause `review-cap`. A reviewer stopped by a plan limit starts as a fresh session after the reset instead of resuming. An office runs at most one worker session and one reviewer session at a time. Before a review comment is posted, code removes every value found in the env files dipo copied into the worktree (0010 section 8) from the comment and writes `[redacted]` in its place; this accepts the public PR comment as a new egress path for development secrets with that check, and the rule that worktree env files hold development secrets only stays (maintainer 2026-10-17)."
- **0009:** "2026-10-16, DIPO-131 (maintainer): sections 3 and 4. After In Review a story's phase is `review`, `merge` or `test`; an office has a worker place and a reviewer place, so up to two agents of one office can show as running, one of them with role `reviewer`."
- **0010:** "2026-10-16, DIPO-131 (maintainer): section 7. The conflict check before In Review and the building-time sync for riskier stories (tier `L` or flagged test-before-merge, open question 3), deferred in DIPO-15 and DIPO-49, ship in M1a as decided here. A conflict found while a story is In Review is handled at its next In Review or merge-slot sync. A conflict found by the engine leaves the merge in progress in the story worktree for the worker to resolve, and the engine concludes it; the story's own task file is resolved by the engine, and a conflict in another path the worker cannot write parks `conflict` at once. This replaces 'abort the merge' in section 2a and in the failure row for a re-claim. Push and PR row: the story PR opens at the first In Review push, ready for review. Merge slot row: story PRs use the slot; its occupant is persisted; a PR labelled `autorelease: pending` or with a hold label, or whose host head the engine did not push, is never merged by the engine."
- **0012:** "2026-10-16, DIPO-131 (maintainer): this replaces the 2026-10-10 line from decision 0016. A merge-time conflict counts against `mergeSlot.conflictAttempts` (2 failed hand-offs) and parks `conflict`; red required checks count against `mergeSlot.ciAttempts` (2) and park `verify-failing`; neither counts as a review round. A review-blocked story can also return to In Review by a maintainer override (`dipo approve` with a note)."
- **0014:** "2026-10-16, DIPO-131 (maintainer): sections 2 and 7. The `review` kind also receives resolved unknowns, the test-plan entry numbers and the gate script changes. Feedback items gain CI and review sources with signatures; sent items are stored in `feedback_items` with their text and sent once per head commit."
- **0016:** "2026-10-16, DIPO-131 (maintainer): rule 2. Red required checks count against `mergeSlot.ciAttempts` and a conflict against `mergeSlot.conflictAttempts`, not against the review round cap. A conflict in step 2 leaves the merge in progress for the worker instead of aborting it. The required checks are the office's `mergeSlot.requiredChecks` joined with the checks the host marks required. The guard that never merges a PR labelled `autorelease: pending` is engine code (rule 12)."

## Consequences

- A story reaches Done with no maintainer action unless the office or the story asks for one, and the maintainer sees why each merge waits.
- Every PR of an office costs at least two CI runs (the In Review push and the slot push), as 0016 already implies, plus one per fix round.
- A reviewer on Opus on every round is the largest new cost; its tokens come out of the story's budget, eased by the 200,000-token allowance per round.
- Up to two Claude sessions per office run at once, so plan limits fill faster; the holds of section 12 make work wait, never park.
- Review reports are public on the PR, with values from the copied env files redacted before posting. Security and correctness findings now block, so a wrong finding can cost a fix round; the evidence check on an exact changed line and the maintainer's override limit that.
- The engine owns more host traffic (PR, comments, checks, logs, labels), more state (PRs, verdicts, sent feedback, the slot) and a second report schema.
- Leaving a conflicted merge in progress keeps the worker away from git while it resolves conflicts; the engine must tell its own merge from the worker's edits, which the merge state derived from git does.
- Recordings for the `review` kind (an approval, a blocked verdict, an invalid report) are captured live before the reviewer ships (0017).

## Sources

1. ADRs 0001, 0002, 0003 (amendment of 2026-10-16), 0005, 0007, 0008 (amendments to 2026-10-16), 0009, 0010, 0012, 0013, 0014, 0016, 0017; 0020 (DIPO-132); spike stories DIPO-131, DIPO-132, DIPO-133; DIPO-49 and DIPO-15 notes on the deferred conflict check; maintainer decisions of 2026-10-16 and 2026-10-17.
2. Engine code at b3f847e: `merge-slot/`, `platform/host.ts`, `run/verify-commit.ts`, `run/park.ts`, `run/records.ts`, `run/work-run.ts`, `views/feature.ts`, `views/work.ts`, `reads/hello.ts`, `retention/policy.ts`, `workers/types.ts`, `workers/claude-cli/plan.ts`, `workers/claude-cli/self-test.ts`, `prompts/feedback.ts`, `worktree/done.ts`, `db/migrations/0010`, `0013`, `0018`; contract `office.ts`, `work.ts`, `version.ts`; `scripts/check-pr-title.ts`.
3. Research `docs/research/2026-10-comparable-tools.md`, ideas 5, 14 and 17 and section 6.3 (send-once with signature and attempt budget, review keyed on commit), inspiration only (0015).
4. Milestone review of 2026-10-16 (`docs/reviews/`, not committed): merge-slot check names, the missing conflict check, `activeRuns` counting session runs.
5. GitHub CLI manual: `gh pr checks` (`--required`, `--json` fields `link` and `workflow`), `gh run view` (`--job`, `--log-failed`), `gh pr view --json labels`, `gh pr comment`. GitHub docs: `pull_request` activity types, draft PRs, comment size limit. To be checked against the pinned `gh` floor (2.50.0) by story C.

## Implementation stories for slice:m1a

All in milestone `m-1`, label `slice:m1a`, after the cutover (DIPO-115, a hard gate, named directly where a story has no other gate). "0020 n" is story n of 0020.

| # | Title | Outcome (one line) | References | Depends on | Tier |
|---|---|---|---|---|---|
| A | Read the review settings and the rest of the merge slot block from the office config | `.dipo/office.yaml` has the `review` block (including `budgetTokens`) and the `mergeSlot` keys of section 16 beyond `requiredChecks`, with defaults, in the next config version after DIPO-133 | `packages/engine/src/config/`, `packages/engine/schema/`, `packages/engine/scripts/write-schema.ts`, `packages/engine/test/config/`, `packages/engine/test/office/` | DIPO-133 | S |
| B | Add the review loop to the contract | The contract carries `Verdict.review`, `StoryView.pr`, `story.pr`, `gate.decided.review`, the progress fields and the three new codes, and ships `gate.approve` and `gate.reject` (the 0005 amendment of 2026-10-16 already lists these additions) | `packages/contract/src/`, `packages/contract/test/`, `packages/contract/schema/` | DIPO-115 | S |
| C | Read PR labels, all checks and failed CI logs, and post comments, through the code host | A new host interface next to `PrStateHost` reads labels, every check with its link and a capped failed-job log tail, posts a PR comment, and a test proves no deployment API is called | `packages/engine/src/platform/host.ts`, `packages/engine/test/platform/` | DIPO-115 | S |
| D | Reopen the story's run for review and fix rounds, with a worker place and a reviewer place | A run ends its active period at In Review and reopens for a review, fix round or conflict hand-off; each office has one worker place and one reviewer place with the start orders of section 12, counted from open story runs (session runs left out, while `activeRuns` and `hasActiveRun` keep counting them); a resume that finds its place taken is queued (0020 section 1); plan-limit holds pause the places by scope; review time and turns stay out of the developer's caps; `parks` gains `cause` (0020 section 2), written by every park and carried by `story.parked`; the final outcome, with the new `run_outcomes` columns, is written at Done | `packages/engine/src/run/`, `packages/engine/src/worktree/done.ts`, `packages/engine/src/views/work.ts`, `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/test/run/`, `packages/engine/test/db/`, `packages/contract/src/`, `packages/contract/schema/` | DIPO-115, DIPO-128, DIPO-129, 0020 1 | L |
| E | Open and update the story PR at In Review | Each In Review push opens or updates one ready PR with a code-built title and body, recorded in `story_prs` and shown as `StoryView.pr` and `story.pr` | `packages/engine/src/story-pr/`, `packages/engine/src/run/verify-commit.ts`, `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/src/retention/policy.ts`, `packages/engine/src/views/`, `packages/daemon/src/`, `packages/engine/test/story-pr/`, `packages/engine/test/db/` | B, C, D | M |
| F | Run the reviewer session on the story worktree | The Claude adapter plans the `review` kind (tools without web access, read-only sandbox, self-test variant, no plugins, skills or MCP, its report schema with `testEntry`) with a golden-tested L1 and reviewer role and the review task message, and live recordings exist | `packages/engine/src/workers/`, `packages/engine/src/prompts/`, `packages/engine/test/workers/`, `packages/engine/test/prompts/`, `packages/engine/test/recordings/claude-cli/`, `tools/recordings/` | A, D | L |
| G | Judge review reports and key verdicts on the code tree | Code validates each report (evidence for scope, test, security and correctness findings), computes the verdict, stores it in `review_verdicts` and review gates keyed on the code tree key, skips re-review by section 6, adds the review allowance per round, parks `review-blocked` (cause `rounds`) after the third failed round and handles reviewer failures by section 4 with causes `review`, `review-cap` and `backstop`; it snapshots `review.maxRounds`, `maxTurns`, `maxMinutes`, `budgetTokens`, `mergeSlot.ciAttempts` and `conflictAttempts` on the run at its start and owns the `runs` migration for `ci_cap`, `conflict_cap`, `review_max_turns`, `review_max_minutes` and `review_allowance` | `packages/engine/src/review/`, `packages/engine/src/run/`, `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/src/retention/policy.ts`, `packages/engine/src/views/feature.ts`, `packages/engine/src/features.ts`, `packages/daemon/src/`, `packages/engine/test/review/`, `packages/engine/test/db/` | A, B, F | L |
| H | Watch CI on story PRs and turn failures into feedback | The PR poll waits for the office's and the host's required checks on the pushed head, builds CI feedback items with job log tails, and parks `verify-failing` with cause `ci` after `mergeSlot.ciAttempts` red heads | `packages/engine/src/story-pr/`, `packages/engine/src/merge-slot/checks.ts`, `packages/engine/src/run/`, `packages/engine/src/prompts/feedback.ts`, `packages/engine/src/prompts/feedback/`, `packages/daemon/src/`, `packages/engine/test/story-pr/`, `packages/engine/test/merge-slot/`, `packages/engine/test/prompts/` | A, C, E, DIPO-133 | M |
| I | Send review, CI and reject feedback once per head in one fix round | Feedback items with their text are stored in `feedback_items`, sent once per head with repeats marked, batched into one fix round that moves the story to In Progress and resumes the developer session in the worker place | `packages/engine/src/run/`, `packages/engine/src/prompts/`, `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/src/retention/policy.ts`, `packages/engine/test/run/`, `packages/engine/test/db/` | G, H | M |
| J | Check for conflicts before In Review and let the worker resolve them | The engine checks with `merge-tree` before In Review, syncs riskier stories, resolves task-file conflicts itself, parks unwritable-path conflicts at once, leaves other conflicted merges in progress for the worker, concludes them after markers, scope and verify pass, and parks `conflict` at the second failed hand-off | `packages/engine/src/run/verify-commit.ts`, `packages/engine/src/run/story-git.ts`, `packages/engine/src/run/backstop.ts`, `packages/engine/src/run/control.ts`, `packages/engine/src/worktree/claim.ts`, `packages/engine/src/prompts/feedback/`, `packages/engine/test/run/`, `packages/engine/test/worktree/` | D, I | L |
| K | Merge story PRs through the merge slot | Story PRs whose review verdict (or override) holds for the head, with green required checks and no hold label, merge through a persisted slot with close-out, sync, push, required checks, label and head guards and squash merge; hand changes and PRs closed on the host are handled by section 9 | `packages/engine/src/merge-slot/`, `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/src/retention/policy.ts`, `packages/daemon/src/`, `packages/engine/test/merge-slot/`, `packages/engine/test/db/` | E, H, J, DIPO-133 | L |
| L | Let the maintainer approve, reject or override a waiting merge | Merge gates open and decide by section 11 and are put in front of K's slot entry, a review-blocked park opens an override gate whose approval needs a note and resolves the park as `override`, `gate.approve` and `gate.reject` work with the `review` flag, `dipo approve` and `dipo reject` exist, and a hand merge closes the gate through the Done poll | `packages/engine/src/merge-slot/`, `packages/engine/src/gate/`, `packages/engine/src/commands/`, `packages/engine/src/reads/hello.ts`, `packages/engine/src/worktree/done.ts`, `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/test/db/`, `packages/engine/src/features.ts`, `packages/daemon/src/`, `packages/cli/src/`, `packages/engine/test/merge-slot/`, `packages/engine/test/commands/`, `packages/engine/test/worktree/`, `docs/decisions/` | B, G, K | M |
| N | Post each review round's report on the story PR | After each round the engine posts one code-built comment in the format of section 3, with every value from the copied env files replaced by `[redacted]`, never edits it, stores its URL on the verdict, and retries a failed post without holding the gate | `packages/engine/src/story-pr/`, `packages/engine/src/review/`, `packages/engine/test/story-pr/` | C, E, G, H | S |
| M | Prove the review loop end to end in an engine test | One engine-layer test file with a scripted worker and reviewer, a fake host and real git covers approve, blocked then fixed, a security finding, red CI, conflict, a maintainer gate, an override, a review next to a running worker and a daemon restart in the slot | `packages/engine/test/engine/` | L, N | M |

0020 story 6 resumes the parks caused here (causes `review`, `review-cap`, `rounds`, `backstop` during review, `merge-in-progress`, `unwritable-path`, `slot-refused`, `ci`, `pr-closed`) and depends on G, J, K and L (the `override` value); 0020 story 12 (`dipo desk`) depends on L; 0020 story 1 comes before D.

## Amendments

- 2026-10-19, DIPO-210 (maintainer): section 3. The office key `storyPr.open` (default `true`, office configuration version 7) lets the maintainer switch story PRs off for an office: with `false` the engine opens, updates, polls and retries no story PR for that office and raises no `pr.openFailed` notice, and the story stays In Review. When to open stays decision B for every office that leaves the key on. Reason: on this repository the maintainer side merges its own PR from a finish branch (main merged in, review fixes on top) and never touches dipo's branch, so a story PR from dipo would be a second PR per story.
- 2026-10-21, DIPO-263 (maintainer, decision 0021): the reviewer has no box and its tools are read-only plus web: the story, the diff of the story branch against the start commit, a read tool on the pushed commit, and web search; no shell, no write, no gh (0021 section 10). Fix rounds go to the same builder in its kept box, including CI failures and the maintainer's PR comments until merge (0021 sections 6 and 10).
- 2026-10-22, DIPO-275 (maintainer): section 3 and the DIPO-210 amendment. This repository sets `storyPr.open` back to `true`: CI on dipo's story PR is the verify of a box run (0021 amendment of 2026-10-22), so a box run needs the PR. The maintainer side merges dipo's story PR after the review and CI instead of a finish-branch PR, until the merge slot merges it (DIPO-150).
- 2026-10-22, DIPO-186 (maintainer): section 4. The reviewer's task message gets a `worker_report` section built by code from the newest stored done report: each test-plan entry with its status and evidence, and each deviation, every field flattened to one line and the section capped, marked as the worker's words.
- 2026-10-22, DIPO-309 (maintainer): sections 11 and 17. A test pass decides the story's `test` gate for the current head, and the merge gate no longer counts the test-before-merge flag for that head: with `mergeSlot.autoMerge` on and no other reason from section 11, the story merges by rule, because the pass is the maintainer's merge decision (0002). A fail or a new head reopens the `test` gate. For an unflagged story the result is recorded and shown in the merge gate summary and the PR status block.
- 2026-10-22, DIPO-310 (maintainer): section 12. Session runs have their own capacity rule: one session run per office at a time, outside the worker and reviewer places. Plan-limit holds apply to it (it waits, never parks), and its tokens count in the office's usage and in spend alerts.
