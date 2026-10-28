# 0002 Review, testing and merge

Status: accepted. First written 2026-10-09. Rewritten 2026-10-24 for the simplified design; it now also holds the review loop (former 0019) and the merge of story PRs (formerly in 0010 and 0016). The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Two gates, one authority

1. **A bot reviews the code.** A reviewer session judges each pushed head against the story's outcome, criteria and test plan. It is a separate session from the developer and never sees the developer's reasoning.
2. **The maintainer tests behaviour, only when they choose to.** They run the software instead of reading code. A story the maintainer flags **test before merge** waits for their test.
3. **The maintainer keeps merge authority.** dipo merges by itself only after the reviewer approved and the required checks passed, on a story nobody asked to wait for (section 7).

Code decides everything between the two model sessions: when the PR opens, whether a finding blocks, what feedback goes back, when a story merges.

## 1. The loop

From the developer's done report to Done:

1. **Done report.** The worker reports `done`. The report gate checks the valid report: every automated test-plan entry is covered, and no conflict markers are left. A miss is feedback (section 5). A report that does not parse or does not match the schema never reaches the gate: it gets one correction turn, then the story parks `worker-failed` (0008). dipo takes the last part out of the box (0008) and runs the office's verify in the box (section 4); red is feedback too.
2. **Conflict check.** dipo checks the branch against the base with `git merge-tree`. A conflict is feedback (section 6).
3. **In Review.** dipo ticks the met criteria and sets the status `In Review` through the Backlog CLI, commits and pushes. Then it opens the story PR, or updates it if one is already open (section 2).
4. **Review and CI at once.** The reviewer reviews the pushed head (section 3) while CI runs on it (section 4).
5. **Back to the developer.** A blocked verdict, red required checks, a conflict or a maintainer reject start one fix round (section 5), and the loop starts again at step 1.
6. **Merge gate.** With the review approved and the required checks green on the head, the merge gate opens. It is decided by rule, or it waits for the maintainer (section 7).
7. **Merge.** dipo makes the close-out commit and asks GitHub to merge when green. The one Done check sees the merge and tears down (section 8).

The run is one run per claim. Its active period ends at In Review and reopens for every fix round, so caps and usage add up across rounds without story-level sums.

## 2. The story PR

- **When it opens.** The PR opens at the first In Review push, ready for review rather than as a draft. dipo looks for an open PR with the story branch as head before it creates one, so a crash never opens a second PR. A failed create is a notice, and the PR poll retries it.
- **Title.** Code builds it from the story as `<type>(<ID>): <subject>` (0016). `feature` and `enhancement` map to `feat`, `bug` to `fix`, `docs` and `spike` to `docs`, and everything else to `chore`. The subject is cut to 100 characters on a word boundary.
- **Body.** Code builds it from facts, with no model text: the outcome, the criteria ticked as the task file has them, the test plan, the references, and a status block (review, required checks, merge). It is rewritten only when the rendered text changes.
- **Review comments.** After each round, dipo posts one PR comment built from the stored verdict: criteria with evidence, findings with `file:line` and the quoted line, and the summary. It never edits or deletes an earlier comment. Before posting, code replaces every value from the env files dipo copied into the box with `[redacted]`. The repository is public, so the comment is public.
- **Hand changes.** dipo never merges a head it did not push. If someone pushes to the branch, the story stays out of the merge, and the desk shows the PR with two ways on: merge by hand, or `dipo discard`. A PR closed on GitHub without a merge parks the story `by-maintainer` with the detail "PR #n closed on GitHub". A resume opens a new PR that names the closed one.

## 3. The reviewer

- **Who.** A built-in `reviewer` role, used only for reviews. It is always a fresh session and is never resumed.
- **Model and caps.** It has its own caps, separate from the story's: model `opus`, effort `high`, and per session a turn, minute and token cap from the office config. Reviewer usage is reported per story, but it never uses the developer's budget.
- **Where it runs.** In a read-only box of its own (0008), never the developer's. The box holds a `git archive` copy of the pushed head and nothing else: no `box.files`, so no secrets. Its tools are read, glob, grep, web search and web fetch, with no shell, no write and no `gh`. Its web traffic goes through the box web proxy like any box. No session has hooks.
- **What it receives.** The story, its criteria and test plan, the resolved unknowns, the diff of the branch against its start commit, and the previous round's findings. It also gets the developer's test-plan statuses and deviations from the done report, marked as the developer's words. It never gets the developer's reasoning, notes or transcript.
- **The report and the verdict.** The reviewer returns one result per criterion (`met`, `unmet` or `maintainer`), findings and a summary. Code validates the report against the reviewed commit and computes the verdict. A finding blocks only when it is one of these four kinds and its evidence checks out:
  - `scope`: content beyond the outcome and criteria, with a quoted changed line.
  - `test`: an automated test-plan entry with no test, naming the entry.
  - `correctness`: a problem at a quoted changed line.
  - `security`: a problem at a quoted changed line.

  The verdict is `blocked` when a criterion is `unmet` or a validated blocking finding exists, and `approved` otherwise. A criterion marked `maintainer` does not block, but it makes the merge wait for the maintainer. A blocking finding whose evidence does not check out gets one correction turn, after which it counts as advisory. Advisory findings never block.
- **Rounds.** A round is one reviewer session that returns a valid report. The cap counts failed rounds only: after the third blocked round the story parks `review-blocked`. A verdict is keyed on the code tree, which is the tree without the story's own task file. A head whose tree already has a verdict in this claim gets no new review, so commits that change only the task file never start one.
- **Failures.** An invalid report gets one correction turn. A crash gets one fresh session for the same round, which is not counted. A second crash, or a reviewer cap, parks the story `worker-failed`. A review never uses the story's budget.

## 4. Verify in the box, CI as the final gate

- **Which checks.** The required checks are the ones GitHub's branch protection or ruleset requires on the base branch. That is one list, owned by GitHub. Every one of them must pass on the head dipo pushed.
- **dipo runs verify.** When the done report passes the report gate, dipo runs the office's verify command in the story's box, as the box user, with a deadline. The box has its own local git repository (0008), so tests that need git pass. Red is feedback (section 5); green goes on to the conflict check. The worker may run tests and verify while it works, but only dipo's run counts.
- **CI is the final gate.** The required checks on the PR must still pass before the merge gate opens. A red verify is caught in the box, so a CI round is rarely the one that finds it.
- **Polling.** One PR poll per office, every `polling.prStateSeconds`, for each story PR whose head has unfinished checks: `gh pr view` (state, head, labels, mergeable) and `gh pr checks`. A head whose checks stay unfinished past a time limit raises one notice, and its polling slows down.
- **Logs.** For each failed check that is a GitHub Actions job, dipo fetches the tail of the failed job's log once per head, capped, and parses `file:line` locations for the feedback.
- **Who talks to GitHub.** Only engine code, with the maintainer's `gh` login. Workers and the reviewer never get `gh`.

## 5. One feedback path

Every kind of feedback reaches the developer the same way: as a message to the developer session in its box. That covers the report gate, a red verify in the box, a conflict, a blocked review, red checks, a maintainer reject, a resume note and a steer.

- **Items.** Code builds each item from the failing fact, as text with evidence. Its signature is computed over the fields that identify the failure, never over free text.
- **Send once per head.** An item goes to the worker at most once per pushed head. The same signature on a later head is sent again, marked "still failing after your last change".
- **One fix round per head.** All items for one head go in one round: the run reopens, the status goes back to `In Progress`, and a new developer session in the story's box gets the items with a handoff (0014). A maintainer reject and a conflict are sent at once, because nothing else is pending for them.
- **One cap per source,** all fixed at run start (0020):

  | Source | Cap | At the cap |
  |---|---|---|
  | Report gate refusals and a red verify in the box | Tier `loops` | `verify-failing` |
  | Red required checks | CI attempts, default 2 | `verify-failing` |
  | Blocked review | Failed rounds, default 3 | `review-blocked` |
  | Conflict | Failed conflict hand-offs, default 2 | `conflict` |
  | Maintainer reject | None; the budget bounds it | None |

## 6. Conflicts

- **When dipo checks.** Before In Review (section 1, step 2), and whenever the PR poll reports GitHub can't merge the PR because of a conflict.
- **The hand-off.** dipo merges the base into the story branch in its own git, from objects. It commits the result as git left it, conflict markers included, and copies that commit into the box before the developer's next session. The developer resolves the markers as ordinary work. At done, a conflicted path that still has markers is report gate feedback (section 1), counted against the tier `loops`. A hand-off fails when the developer reports blocked while it is open.
- **Paths the developer must not touch.** dipo resolves the story's own task file itself, taking the base's version and writing the branch's status back. A conflict in another protected path (`backlog/`, `.dipo/`, `.github/`, the Claude settings) parks the story `conflict` at once, naming the paths.
- **No rebase, no force push.** dipo never rewrites a pushed branch.
- **No sync without a conflict.** GitHub's "require branches to be up to date" setting is off (0016), so dipo merges the base into a branch only when there is a conflict.

## 7. The merge gate

The gate opens when the review approved the head and its required checks are green, so the maintainer only ever approves something that can merge. It is decided **by rule**, and recorded, unless one of these holds. Then it **waits for the maintainer**:

- `merge.autoMerge` is `false` in the office config;
- the story is flagged test before merge, and no test pass is recorded for this head;
- the reviewer marked a criterion `maintainer`;
- the story passed review only through a maintainer override;
- the PR has a hold label from `merge.holdLabels`;
- the diff changes a path that the base's `CODEOWNERS` gives an owner (the release path). Such a gate is decided only by a hand merge on GitHub: `dipo approve` refuses it, and dipo never merges it or uses `--admin`;
- the PR is labelled `autorelease: pending`. dipo never merges such a PR. This rule is in code, and no setting removes it.

The maintainer's actions:

- `dipo approve <id> [--note]`: the gate is approved and the merge goes ahead.
- `dipo reject <id> --note`: a fix round with the note as its item.
- A hand merge on GitHub: the Done check records the gate as approved by the maintainer.
- **Override.** When a story parks `review-blocked`, its merge gate opens as well. `dipo approve <id> --note` overrides the verdict, records the override, and puts the story back In Review on the way to merging. A later code change gets a normal review again.

A gate belongs to one head. A new head from the developer opens a new gate.

## 8. Merging and Done

When the gate is approved, dipo:

1. Commits the close-out on the story branch: the final summary (built from facts, 0020) and status `Done`. This commit changes only the task file, so the verdict still holds.
2. Pushes, then runs `gh pr merge --auto --squash --match-head-commit <head>`. GitHub merges once its required checks pass on that head. The PR title is the squash subject.
3. Watches through the PR poll:
   - **Merged:** Done.
   - **Conflict, or red checks:** dipo turns auto-merge off and starts a fix round. The status goes back to In Progress in the next commit.
   - **A hold label appears, or a head dipo did not push:** dipo turns auto-merge off and the gate waits again.

**One Done check.** A story is Done when its PR is merged, or when the story reads `Done` on the base while dipo holds a claim (a story finished outside dipo, 0020). One function decides this from the PR poll and the base. Teardown releases the claim and deletes the box and the branch.

The repository setting "Allow auto-merge" must be on; the maintainer sets it by hand (0016). If merge order starts to matter once stories run in parallel (M2), GitHub's merge queue is the next step, not a merge slot of dipo's own.

## 9. Testing a story

`dipo test <id>` runs the story's pushed head in a new test box (0008), for a story In Review with a manual test-plan entry, flagged or not. It installs and starts the product, and shows the test plan's manual entries and the URL. A forwarder on the Mac listens on 127.0.0.1 and passes connections to the dev port at the test box's address, starting them from the Mac's address on the box network, so no port is published and the URL works while a VPN routes the box network's range. `dipo test pass <id>` records a pass for that head and decides the story's test gate; a merge gate that waited only for that test is then decided by the pass. `dipo test fail <id> --note <what>` starts a fix round with the note as its item. A new head needs a new test. A test stays open until it is recorded, a new head is pushed, the story is dropped, discarded or merged, or `timeouts.testIdleMinutes` passes; then its box is deleted.

## 10. Capacity

An office runs at most one developer session per story, at most one developer session in total until M2, one reviewer session, and one scan session. A story that waits for CI, for the maintainer or for GitHub's merge holds no session.

## Building this repository

- A separate agent reviews every PR against the story goal before it merges. The maintainer does not review code.
- Pull requests that change only `backlog/` merge after dipo's structural check, without the reviewer (0010).
- Dependency update PRs follow 0016's rules.

## Replaced

- A merge slot that merged one PR at a time, with a base sync, a re-check loop, a refusal cap and a persisted occupant (2026-10-16). Replaced by GitHub auto-merge (2026-10-24). The slot existed for "require branches to be up to date", which has been off since 2026-10-22.
- The office list of required checks (`mergeSlot.requiredChecks`), joined with GitHub's (2026-10-16). Replaced by GitHub's required checks only (2026-10-24), because auto-merge waits for GitHub's list, and one list has one owner.
- A per-round review allowance that grew the story's budget, so reviewer tokens counted against the story (2026-10-16). Replaced by the reviewer's own caps (2026-10-24).
- A reviewer with a read-only Bash sandbox in the story worktree (2026-10-16), then a reviewer on the Mac fenced by its tool list, permission rules and a web-gate hook (2026-10-21). Replaced by a read-only reviewer box (2026-10-24).
- Verify run by dipo inside an `srt` sandbox (2026-10-10), then CI as the only verify while the box had no git (2026-10-22), with dipo reading the worker's tool calls to see whether it ran verify. Replaced by dipo running verify in the box, which has a local git repository, with CI as the final gate (2026-10-24).
- A conflict merge left in progress in a Mac worktree (2026-10-16). Replaced by a merge committed with markers and copied into the box (2026-10-22), since dipo never runs git in a folder a worker can write.
- A building-time sync for tier L and flagged stories. Removed (2026-10-24); a merge without a conflict is not needed.
- `storyPr.open` to switch story PRs off (2026-10-19). Removed (2026-10-24): every story needs its PR, because CI on the PR is the final gate.
- A PR closed on GitHub parked as `stopped` with cause `pr-closed`. Replaced by `by-maintainer` with a detail (2026-10-24).
- A forwarder inside the test box on the box's address, with that address as the test URL (2026-10-22). Replaced by a forwarder on the Mac's loopback (2026-10-28): the Mac does not reach a box address while a VPN routes the box network's range.
- Schema validity in the report gate, a bad report parked `ambiguous-spec`, and markers left at done failing the hand-off (2026-10-24). Replaced by one correction turn and then `worker-failed` for a report that does not parse or match the schema (0008), and by markers as report gate feedback against the tier `loops` (2026-10-28).
