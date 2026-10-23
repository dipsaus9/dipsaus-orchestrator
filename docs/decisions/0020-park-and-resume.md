# 0020 Park, resume and the maintainer's desk

Status: Accepted (2026-10-17, maintainer). Proposed in spike DIPO-132, 2026-10-16. Records the maintainer decisions of 2026-10-16 and 2026-10-17 (listed under "Maintainer decisions"). Amends 0005, 0007, 0008, 0009, 0010, 0012 and 0014 (see "Amends").

## Context

M1a is the first slice of M1 (0003, amendment of 2026-10-16): the unattended review-and-park loop. Its park half needs three things M0 does not have: every parked story can be resumed, the maintainer can step in (hold, drop, discard, steer, pause), and one plain-text list says what waits on the maintainer. 0019 (DIPO-131) owns the story PR, the reviewer, review rounds, conflict hand-offs, the merge gate and the override past a blocked review. This ADR owns what happens once a story is parked or the maintainer steps in, and how a worker asks for more than its story gives. The points where the two meet are listed in "Interface with 0019" below.

### What M0 does today (checked in the code on main, b3f847e)

1. **Parks.** A park is written in lane a: the F16 `park` block and status `Parked` in the story's task file on the story branch, committed alone and pushed (`engine/src/run/park.ts`, `gitParkWriter`); then one transaction writes the `parks` row, ends the run and emits `story.state` and `story.parked`. The base keeps the status it had at the claim (Ready) until the story PR merges. A park from reconcile (`RunControl.parkForReconcile`, `run/control.ts`) is not written on the branch, because the worktree is no longer trusted.
2. **Resume.** Only two kinds of stop come back. A plan-limit hold resumes by itself or by `work.resume` (registered in `run/plan-limit.ts`). A `needs-permission` park resumes when the maintainer answers its permission question (`dipo answer`, `hooks/park-answers.ts` to `RunOutcomes.resumePark` in `run/outcomes.ts`). Every other park answers `work.resume` with `story.notPausedOrParked`, and `parkActions` hides `work.resume` from a parked story (`NOT_FOR_PARKED` in `run/park.ts`).
3. **The resume path that exists** (DIPO-75) is the template for all of them: lift the park on the branch (`gitUnparkWriter`: F16 removed, status back to `park.from`, task-file commit, push), reopen the same run in one transaction (`reopenParkedRun`: park resolved `resume`, `runs.ended_at` cleared, the parked time added to `runs.parked_ms`), then start the next session of that run (`RunResumer` in `run/resume.ts`): `--resume` of the native session when `canResume` holds, else a new session with a 0014 handoff, with what remains of the caps.
4. **Caps on resume** come from the office configuration in force, not from the run: `caps: (office, run) => capsOf(tierOf(office, run))` in `daemon/src/runs.ts`. `runs` stores `budget_limit` and `loop_cap` at start (0007 section 4) but not the turn or minute caps. So a tier edit made while a story is parked reaches it when it resumes.
5. **Questions.** A turn whose report is `blocked` parks at once: `needs-permission` with the tool and action, else `ambiguous-spec` with the question as detail (`run/control.ts`, "Waiting for an answer before the park is M1"). No `questions` row is written for an `ambiguous-spec` park. `timeouts.questionWaitMinutes` (default 15) is in the config schema and read by nothing (`config/schema.ts`).
6. **Handoff.** `gatherHandoff` (`prompts/handoff.ts`) reads worker notes that nothing writes: `recordWorkerNotes` (`prompts/notes.ts`) and `recordContextPack` (`context/pack.ts`) have no production caller, the report schema still asks for `notes` (`workers/claude-cli/report-schema.ts`), and `RunResumer` passes `openFeedback: []`.
7. **Commands.** `story.hold`, `story.drop`, `work.discard`, `work.steer`, `work.pause`, `work.reassign`, `gate.approve`, `gate.reject` are defined in `contract/src/office.ts` as provisional and are not registered. The CLI has `stop` and `answer`, no `resume`, `hold`, `drop`, `discard`, `steer`, `pause` or `desk` (`cli/src/index.ts`).
8. **Waiting commands.** Four of five office commands that exist (`work.run`, `work.stop`, `work.answer`, `work.resume`) run on a second executor path: the idempotency check in one transaction, the handler outside it with its own commits, the `requests` row last (`commands/execute.ts`, invariant stated in its comment). 0005 does not describe this path.
9. **Done detection** looks only at the story's own branch: a merged PR whose head is that branch, or `git merge-tree` showing the branch adds nothing (`worktree/teardown.ts`, `detectDone`). A parked story keeps worktree, branch and slot (`worktree/done.ts`). Reconcile reads a claimed story's status on its branch, not on the base (`reconcile/reconcile.ts`, step 3).
10. **Scope.** The scope check at `done` reads the scope the run started with (`runs.scope`, copied from the base view in `run/work-run.ts`), not the task file on the branch (`run/verify-commit.ts`). The `PostToolUse` nudge says an out-of-scope path "will be rejected"; the worker contract says the same (`prompts/contract/implement.md`).
11. **Backstop.** After every turn the engine compares HEAD, the checked-out branch, the stash and `git status -- backlog .dipo` with the run-start snapshot (`run/backstop.ts`); a difference parks `scope-violation`. Separately, every engine git call checks that the worktree's git links (`<worktree>/.git`, `commondir`, `gitdir`) still match the claim's snapshot; a mismatch (`git.worktreeTampered`) parks `scope-violation` and no more git runs in that worktree (0008 section 2, "Engine git calls").
12. **Closed shapes.** `QuestionKind` is a closed `z.enum(["question", "permission"])` (`contract/src/work.ts`). `parks.resolved_how` is checked against `resume`, `amend`, `drop`, `discard`, `reconcile` (migration 20). `questions.kind` has an SQL check (migration 22). No contract minor has been released (`.release-please-manifest.json` is `0.0.0`).
13. **Web tools.** The developer role's tools are `Read,Edit,Write,Glob,Grep,Bash`; 0008 section 2 keeps WebFetch and WebSearch out. In Claude Code these tools run outside the Bash sandbox and follow permission rules only (0008 section 2, "Bash sandbox").

### Real cases from the cutover (DIPO-115 findings 7, 9 and 11)

DIPO-105, the first story dipo ran on itself, parked `budget-exceeded` with "turn cap (--max-turns) after 61 turns" on a tier S run (default turn cap 60), leaving seven changed and two new files uncommitted in the worktree. M0 could neither resume it (no resume for that reason) nor discard it (`work.discard` unregistered), so dipo kept the claim, the worktree and the pushed branch, its base status stayed Ready while the branch said Parked, and `dipo run` skipped it as `notRunnable`. The story was then finished by hand on another branch, whose PR set Done on main. dipo did not notice: its Done check looks only at its own branch, so the claim, worktree and branch stayed behind. Two lessons for this ADR: the cap that fires can be the turn cap rather than the token budget, and a story can reach Done outside dipo.

## Maintainer decisions

From M1 planning (2026-10-16):

- **Budget-exceeded resume:** only with an explicit top-up (`dipo resume <id> --budget +50%` or a fixed token amount), recorded as a fact with who and why, resuming the same session; a plain resume is refused for this reason with a message naming the option; never topped up silently. (Section 4.)
- **A worker can ask for more:** (a) extra write paths as a scope request, granted by code when small and collision-free, else on `dipo desk`, and the same session resumes; (b) more input or research before it can do the work well; (c) improvements beyond the story, filed as proposed follow-up stories for the maintainer, never done in place. (Section 11.)

Spike answers (2026-10-16):

1. **Top-up:** (a) all three caps (tokens, turns, minutes) grow by the same share; (b) the same story run continues, with the native session only when the 0014 section 6 cost check passes, else a handoff; the same holds after a scope answer. (Section 4, section 11a.)
2. **Caps:** fixed at run start (snapshot) plus recorded grants, the review loop's limits included. (Section 5.)
3. **Scope requests:** any valid, collision-free request inside a package the story already writes is granted by code; a path outside that package, or outside the worktree, is always refused; dependency manifests, lockfiles, CI workflows, `CLAUDE.md` and decision records still wait for the maintainer even inside the package. (Section 11a.)
4. **Research:** for now, workers get Claude's web search and web fetch tools; refined later by a follow-up story (budget, domains, what is logged). Read here as the WebSearch and WebFetch tools only, not network for shell commands; their cost counts toward the story budget. (Section 11b.)
5. **Leftovers of a story finished outside dipo:** kept, one desk item; `dipo discard` removes them after showing the loss. (Section 10.)
6. **Notes and extra rounds:** (a) a note is required for `ambiguous-spec`, `verify-failing` (loops and ci), `conflict`, `scope-violation` and `review-blocked`; optional for `stopped`, `interrupted`, `worker-failed` and `on-hold`; `budget-exceeded` needs `--budget` and `--note`. (b) Every resume with a note adds exactly one round of the limit that fired, recorded as a grant; a reviewer cap grows by 50%. (Sections 2 and 3.)
7. **Git-state parks** (`scope-violation` with cause `backstop` or `hand-change`): resumable with a note after the git-link check, with a new snapshot and a fresh session; tampered git links are never resumable. (Section 2.)

At acceptance (2026-10-17):

- **Secrets.** Worker web fetch and search are accepted as a new egress path for development secrets, with a code check: the adapter refuses a web call whose URL or query contains a value from the env files dipo copied into the worktree. The rule that worktree env files hold development secrets only stays. (Section 11b.)
- **Design details beyond the answers** are approved as part of this ADR: new M1a commands use the waiting command path, described in a 0005 note (section 1 and "Amends"); a `Done` status on the base wins over the branch status (section 10); the desk order (section 12); forced removal of a dirty worktree by `dipo discard` and `dipo drop --delete-branch` only, and the merge of the remote branch after a rejected push (sections 2 and 8); hold of a claimed story is refused, and `AGENTS.md` is a restricted path (sections 8 and 11a); the package of a path and `scope.packages` (section 11a).

Also decided for 0019 and used here: a reviewer may run next to one worker (0019 section 12); the maintainer may approve past a blocked review (0019 section 11).

### Interface with 0019

This ADR relies on these parts of 0019. If 0019 changes them, the matching rows of this ADR follow.

| 0019 provides | Used here in |
|---|---|
| One run per claim, whose active period ends at In Review and reopens for review, fix rounds and conflict hand-offs as `reopenParkedRun` does (0019 section 13) | Section 1: a resume reopens the same run |
| Two session places per office: one worker place and one reviewer place, with their start orders; maintainer resumes start first in each (0019 section 12) | Section 1, step 1: a resume waits for the place its session needs |
| `story_prs` (key, run, number, URL, branch, base, pushed head, state) and `StoryView.pr` (0019 sections 14, 16) | Sections 8 and 10: which PR to close; the desk's PR links |
| A conflict park leaves the merge in progress in the kept worktree; its merge state (`MERGE_HEAD`, unmerged index entries, cleanly merged blob ids) is derived from git, not stored (0019 section 10) | Section 2: `conflict` resume continues that merge, or merges again when the base moved |
| `mergeSlot.conflictAttempts` (2 failed hand-offs) and `runs.conflict_cap`; `mergeSlot.ciAttempts` (2) and `runs.ci_cap`; `review.maxRounds` (3 failed rounds) and `runs.review_round_cap`; `runs.review_max_turns` and `runs.review_max_minutes`; `review.budgetTokens` and `runs.review_allowance`; all snapshot at run start (0019 sections 4, 6, 8, 16) | Section 5: grants add to these caps |
| `feedback_items` with send-once signatures and the rendered item text (0019 section 8) | Section 6: open feedback in a handoff; section 2: the CI and conflict items on resume |
| `review-blocked` detail is the last verdict's blocking findings; `conflict` detail is the conflicted or unwritable paths (0019 section 14) | Section 2: the first message on resume |
| Park causes 0019 sets: `review` (`budget-exceeded`, `worker-failed` after two crashes, `stopped` during a review), `review-cap` (`worker-failed` on the reviewer's own turn or minute cap), `rounds` (`review-blocked`), `backstop` (`scope-violation` after a review), `merge-in-progress`, `unwritable-path`, `slot-refused` (`conflict`), `ci` (`verify-failing` from red checks), `pr-closed` (`stopped`). 0019 owns why they park, this ADR owns their resume (0019 sections 4, 8, 9, 10) | Sections 2 and 4 |
| Merge gates waiting on the maintainer with a code-built summary naming the reasons 0019 section 11 lists, `dipo approve` and `dipo reject`; `gate.handMergeOnly` for `autorelease: pending`; a PR whose head changed outside dipo gets no gate, only `pr.headChanged` (0019 sections 7, 9, 11) | Section 12: desk rows, their reason and commands |
| A `review-blocked` park also opens a merge gate; `gate.approve` with a note overrides the verdict and resolves the park as `override` (0019 section 11; story L adds the `override` value) | Section 2: the `review-blocked` row; section 12: one desk row with both actions |
| Office config versions: DIPO-133, then 0019 story A (`review` and `mergeSlot` blocks), then this ADR's story 17 (`worker.web`) and story 13 (`scope`); DIPO-116 (M1b) after these | Sections 11a, 11b and 15 |
| Stories D (places), E (story PR), G (verdicts), I (fix rounds and feedback items), J (conflicts), K (merge slot, close-out), L (merge gates, override) | Implementation stories, dependencies |

## Decision

### 1. One resume path for every park

Options. A: a resume flow per park reason, each with its own code. B: one path with a per-reason policy table (chosen). DIPO-75 already built the steps (lift the park, reopen the run, next session), and 0019 reopens the same run for its rounds, so every reason reuses them and only the policy differs: what the resume needs from the maintainer, what the first message says, and whether a cap grows.

The path, for a story whose park has a run:

1. **Check** (no writes): the story is Parked; the policy for its reason and cause is met (section 2); no host of the run is alive (`run.hostAlive`, retryable); the daemon schedules work (`scheduling.off`, retryable); what remains of the run's caps is above zero, counting any top-up or grant in this command (else `resume.capReached`, naming `--budget`). If the place the next session needs is taken (0019 section 12: the worker place for a developer session, the reviewer place for a fresh review), the resume is still accepted: steps 2 to 4 run, the intent stays stored, the session of step 5 starts when that place frees (maintainer resumes go first in each place), and the reply says it is queued.
2. **Intent first.** An `answer` intent tagged `park-resume` with the request is stored on the run, as DIPO-75 does, so a daemon restart finishes the resume.
3. **Lift the park on the branch** (lane a, `gitUnparkWriter`), in the same task-file commit adding what the resume writes to the story: a resolved unknown for an answered question (section 7) or granted scope paths (section 11a). A park that was never written on the branch (reconcile) lifts nothing; the commit only sets the status.
4. **One transaction:** park resolved `resume` with the maintainer's note, grants recorded (section 5), run reopened, question closed, `story.state` back to `park.from`, intent marked sent.
5. **Next session of the same run**, never a new run: `--resume` of the native session when `canResume` holds (the 0014 section 6 checks, with the DIPO-51 constants), else a new session with a handoff (section 6). The first message is the reason's delta (section 3). The run keeps its loop and round counts; caps are the run's caps (section 5).

A park without a run (`on-hold`) lifts in lane b instead (section 8). A resume to Ready goes through the pickup re-check (R01b) at the next `work.run`, as 0005 says.

`work.resume` moves out of `run/plan-limit.ts` into its own module that handles both held runs and parks, and park resume moves out of `RunOutcomes` before it grows (the 2026-10-16 review's CC3 split, story 1 below).

### 2. The resume matrix

Each park records a **cause** next to its reason (new `parks.cause` column, open string), because one reason has several causes that resume differently. Code reads the cause; it never parses the detail text.

"Resume, else handoff" means section 1 step 5: the native session when the 0014 section 6 checks pass, a new session with a handoff otherwise. "+1 when noted" means: the resume needs a note, and the note adds exactly one round of the limit that fired, recorded as a grant (decision 6b).

| Reason / cause | What `resume` needs | Returns to | Session | First message (L5) | After resume |
|---|---|---|---|---|---|
| `ambiguous-spec` / `question` | An answer: `dipo resume <id> --note <answer>` or `dipo answer <question> --text <answer>`; refused without one | `park.from` | Resume, else handoff | The question and the maintainer's answer (`feedback/answer.md`) | Answer written as a resolved unknown (section 7). Loop count unchanged |
| `ambiguous-spec` / `no-report` (no valid report after the report feedback turn) | A note | `park.from` | Handoff always | Handoff plus the note | Loop count unchanged |
| `ambiguous-spec` / `rule-conflict` (project rules against the contract) | A note | `park.from` | Resume, else handoff | The conflict the worker named, then the note | Loop count unchanged |
| `verify-failing` / `loops` (local verify red at the tier's loop cap) | A note | `park.from` | Resume, else handoff | The last verify feedback item with its evidence, then the note. With a merge in progress (a red verify during a conflict hand-off) it behaves like the `conflict` / `merge-in-progress` row: if the base moved since, the engine aborts the kept merge and merges again | Loop cap +1 when noted (grant `loop`) |
| `verify-failing` / `ci` (required checks red `mergeSlot.ciAttempts` times, 0019 section 8) | A note | `park.from` | Resume, else handoff | The last CI feedback item, read from `feedback_items`, then the note | CI attempts +1 when noted (grant `ciAttempt`) |
| `verify-failing` / `refused` (verify could not run: `srt`, launch refusal) | Nothing; note optional (nothing failed within the worker's caps) | `park.from` | Resume, else handoff | `feedback/resume.md` with the cause, then the note | Verify runs again; no grant |
| `conflict` / `merge-in-progress` (0019 section 10: the second failed hand-off) | A note | In Progress | Resume, else handoff | The conflict item (conflicted paths and hunks, rebuilt from the kept merge, whose state is derived from git, and the item stored in `feedback_items`), then the note. Nothing is merged again while the base is where the merge left it. If the base moved since, the engine aborts the kept merge and merges the base again through the 0019 hand-off, and the worker gets the new conflict item | Conflict hand-offs +1 when noted (grant `conflictHandoff`) |
| `conflict` / `unwritable-path` (a conflict in a path the worker cannot write, 0019 section 10) | A note; the maintainer first resolves the unwritable path on the base | In Progress | Resume, else handoff, only when a hand-off follows | The engine merges the base again through the 0019 hand-off. If an unwritable path still conflicts, it parks again at once; otherwise it continues as a conflict hand-off with the conflict item, then the note | No grant; `dipo discard` stays the alternative; the desk detail shows the paths |
| `conflict` / `push-rejected` (0010 failure row: non-fast-forward push) | A note | In Progress | Resume, else handoff | The engine fetches the remote branch and merges it into the local branch through the 0019 hand-off (left in progress on a conflict); the worker gets the commits that were only on the remote (subject, author, files), then the note | The merged result passes verify and review again. `dipo discard` stays the alternative |
| `conflict` / `slot-refused` (host refused the merge 3 times because the base moved, 0019 section 9) | A note | In Review (`park.from`) | none: no model session | none | The story re-enters the merge slot with a fresh per-stay count; the slot keeps the close-out commit or writes it again on re-entry (0010) |
| `scope-violation` / `paths` (written outside scope at `done`) | A note, or a scope grant for those paths (section 11a) | `park.from` | Resume, else handoff | The scope feedback (paths and declared scope), then the note; with a grant, "these paths are now in scope" | No loop counted |
| `scope-violation` / `tampered` (the worktree's git links changed, `git.worktreeTampered`, 0008 section 2 "Engine git calls") | Not resumable: refused with `resume.notResumable`, naming `dipo discard` | none | none | none | The engine runs no git in that worktree again |
| `scope-violation` / `backstop` (HEAD, branch, stash, `backlog/` or `.dipo/` changed after a turn, `run/backstop.ts`) and `scope-violation` / `hand-change` (reconcile: worktree or branch changed by hand, `RunControl.parkForReconcile`, 0010 section 7) | A note (decision 7); the engine first checks the git links against the claim snapshot (a mismatch makes it `tampered`) and then takes a new backstop snapshot of the current state | `park.from` | Handoff always (the session's view of the worktree is stale). When `park.from` is In Review (the park was raised during a review, cause `backstop`, 0019 section 4), no developer session: the story returns to In Review and a fresh review of the resulting code tree starts in the reviewer place | The evidence of what changed, then the note (a review gets the review task message only) | The new snapshot is the baseline |
| `review-blocked` / `rounds` (0019: the third failed round) | A note. Or `dipo approve <id> --note` on the merge gate this park opens (0019 section 11): `gate.approve` resolves the park with `resolved_how = override`, sets the status back to In Review, starts no session, and the PR enters the merge slot after its required checks | In Review, then at once In Progress as a fix round (0012); with the override, In Review | Resume, else handoff; none with the override | The last verdict's blocking findings, then the note | Review round cap +1 when noted (grant `reviewRound`) |
| `budget-exceeded` / `build` (token, turn or minute cap of the developer session; CLI turn backstop) | A top-up (`--budget`) and its why (`--note`); a plain resume is refused with a message naming `--budget` (decided) | `park.from` | Resume, else handoff (decision 1b) | "The maintainer raised this story's budget by <n>; continue where you stopped" (`feedback/topup.md`), then the note | Caps raised by the grant (section 4) |
| `budget-exceeded` / `review` (budget used up during a review, 0019 section 4) | A top-up and its why | In Review | A fresh reviewer session on the same head, in the reviewer place; no developer session | The review task message (0019); no `topup.md` | The review round is started again; it is not counted as failed |
| `worker-failed` / `review` (the reviewer crashed twice in one round, 0019 section 4) and `stopped` / `review` (the maintainer stopped a review) | Nothing; note optional, never sent to the reviewer (0002). No top-up: the story budget is not what stopped it | In Review | A fresh reviewer session of the same round on the same head; no developer session | The review task message (0019) | The round is not counted as failed |
| `worker-failed` / `review-cap` (the reviewer hit its own turn or minute cap, 0019 section 4) | Nothing; note optional (never sent to the reviewer). The cap that fired grows by 50% as a recorded grant (kind `reviewCap`, decision 6b) | In Review | A fresh reviewer session of the same round on the same head; no developer session | The review task message (0019) | The round is not counted as failed |
| `on-hold` | Nothing; note optional | `park.from` (Refined or Ready), in lane b | none (no run) | none | Ready goes through the pickup re-check |
| `stopped` / `maintainer` (a developer session stopped; a stop during a review has cause `review`, row above) | Nothing; note optional | `park.from` | Resume, else handoff | `feedback/resume.md` ("stopped by the maintainer"), then the note | Remaining caps |
| `stopped` / `pr-closed` (0019 section 9) | Nothing; note optional | In Review | none at first | none | A new story PR opens for the same head, its body naming the closed one ("replaces #n"); review and CI as 0019 |
| `interrupted` | Nothing; note optional | `park.from` | Resume, else handoff | `feedback/resume.md` with the cause, then the note | Remaining caps |
| `needs-permission` | A decision: refused with a message naming `dipo answer <question> allow\|deny` (M0 flow, unchanged) | `park.from` | As DIPO-75 | Allow or deny message | Allow once for that run only |
| `needs-scope` (new, section 11a) | A decision: `dipo answer <question> allow\|deny [reason]`; `resume` is refused naming it | `park.from` | Resume, else handoff (decision 1b) | Granted: "these paths are now in scope"; denied: "do it without writing <paths>", plus the reason | Granted paths recorded |
| `worker-failed` (crashed after one resume, init rejected, start refused with work in the worktree) | Nothing; note optional. Refused while the adapter hold that caused it is still set, naming the hold | `park.from` | Launch checks again; resume, else handoff | `feedback/resume.md` with the last error, then the note | The one automatic crash resume is available again |

**Options weighed per reason** (where there was a real choice):

- *Answering a question.* A: the answer as a plain first message only. B: the first message plus a resolved unknown in the story (chosen, section 7). A loses the answer when a later session starts fresh.
- *No valid report.* A: resume the same session. B: always a handoff (chosen). The session has already failed the schema twice; a fresh session with the handoff is the cheaper bet.
- *Cap parks (`verify-failing` loops and CI attempts, `conflict` hand-offs, `review-blocked` rounds).* A: resume without more room, so the next failure parks at once. B: every resume with a note adds one round, recorded as a grant. C: the command names how many rounds to add (`--rounds +n`). The maintainer chose B: each extra spend is one decision.
- *Conflict, merge in progress.* A: abort the kept merge and merge the base again. B: continue the kept merge with its conflict item (chosen), unless the base moved since, then abort and merge again. Aborting by default throws away the worker's partial resolution; continuing a merge against an old base would only conflict again at the merge slot.
- *Conflict, push rejected.* A: force-push (never, 0010). B: take the remote branch and drop local work. C: merge the remote branch into the local one and give the divergence to the worker (chosen), or discard. B loses work silently; C keeps both and puts the result through verify and review.
- *PR closed on the host.* A: reopen the closed PR. B: open a new PR for the same head and name the old one (chosen). C: refuse and require discard. A silently undoes a human act on the host and fails when the branch was deleted; C forces losing work for a PR-level act.
- *Backstop or hand change.* A: never resumable, discard only. B: resumable with a note after a git-link check and a new snapshot. The maintainer chose B, because A loses every commit on the branch and amend (the other way back) is M3.
- *Budget used up, or the reviewer failed, during review.* A: resume the developer. B: a fresh review session of the same round on the same head (chosen, 0019). Nothing for the developer to fix; the reviewer is never resumed (0008, 0014). The top-up rule applies to `budget-exceeded` only.

Rules that hold for every row:

- **Never silent.** A resume that would give a capped run more of anything (budget, turns, minutes, a loop, a round, a hand-off, a CI attempt, reviewer time) needs the maintainer's command, and the engine records it as a grant (section 5). A resume never raises a cap by itself.
- **Notes** (decision 6a). Required for `ambiguous-spec`, `verify-failing` (causes `loops` and `ci`), `conflict`, `scope-violation` and `review-blocked`; optional for `stopped`, `interrupted`, `worker-failed` and `on-hold`. `budget-exceeded` needs `--budget` and `--note`. `needs-permission` and `needs-scope` need a decision instead. A required note missing answers `resume.noteRequired`.
- **Plan-limit holds** are not parks and keep their M0 path (0008 section 7).
- **`resume` on a story that is not parked** keeps 0005's meaning: a paused run continues (section 9), a held run is lifted.

### 3. Notes on resume and how they reach the worker

Options. A: the note replaces the reason's delta. B: the note goes after the reason's delta, in a fixed template (chosen). C: the note goes into the story as extra instructions (F17). An answer (F10, a resolved unknown) and a granted path (F8) are narrow facts code checks (R15, R12, R26), so this ADR does write them into the story. A free-text note can say anything, including changing what the story asks for, and changing the contract of a claimed story is amend's job (0012). So notes stay run input, not story facts.

Decided: the first message of a resumed session is code-built from L5 templates (0014 section 1), in this order: the reason's delta from the matrix (evidence first, 0014 section 7), then `feedback/maintainer-note.md`: "Note from the maintainer: {{text}}". In a new session the same items go into the `<feedback>` section of the task message, with the handoff block (section 6). The note is a maintainer-authored fact (0005 section 9, 0007 section 8): stored on the resolved park row, kept with tier S, never sent to the reviewer.

Every maintainer text the engine sends a worker (note, answer, steer) is wrapped in a template and never sent verbatim as the start of a message, so it can never begin with `/` (DIPO-130: a message starting with `/<name>` expands a project skill). `--disable-slash-commands` stays the guard; the template is a second one.

### 4. Budget top-up (decided)

`dipo resume <id> --budget +50% --note "<why>"` or `dipo resume <id> --budget +200000 --note "<why>"`.

- **Who and why.** The grant records the maintainer's note (required with `--budget`), the command's `origin` and `client.name` (0005 section 9), the time, and the caps before and after. It is a fact in `run_grants` (section 15), shown in `story.detail` and counted in the run's outcome for retro.
- **What a share is relative to:** the run's starting caps from its tier, not what remains. `+50%` on a tier S run adds 150,000 budget tokens.
- **Which caps grow** (decision 1a): all three caps by the same share, because DIPO-105 fired on turns, not tokens, and a token-only top-up would hit the next cap at once. A fixed amount is tokens; turns and minutes grow by the same share that amount is of the starting budget.
- **Too small.** A top-up after which the cap that fired would still be reached is refused with `resume.topUpTooSmall`, naming the smallest share that clears it.
- **Confirmation.** The top-up spends plan usage, so every client asks before sending it. `commands.describe` gains `confirmWhen?: string[]`, the argument names that make a command need confirmation; `work.resume` declares `confirmWhen: ["budget"]`. The CLI shows the caps before and after and asks yes/no (`--yes` skips it); a conversation client must send `confirmed: true` (0005 section 9).
- **Which session** (decision 1b): the same story run, which is certain, and the same native session only when the 0014 section 6 checks pass (the 2026-10-10 answer, with the DIPO-51 constants), else a handoff on the same run, as 0019 does for fix rounds. 0014 section 6 is unchanged.
- **During review.** A `budget-exceeded` park with cause `review` resumes as a fresh review of the same head (0019 section 4), not a developer session.
- **Never automatic.** No config key tops up a budget (0019's `review.budgetTokens` allowance is a per-round limit set in advance, not a top-up), and a resume without `--budget` on a `budget-exceeded` park answers `resume.topUpRequired`: "DIPO-105 parked on its turn cap (61 of 60). Resume with `dipo resume DIPO-105 --budget +50% --note <why>`." The CLI's `--max-turns` backstop gets the remaining turns of the raised cap, as `RunResumer.#remaining` computes today.

### 5. Caps come from the run, plus grants (decided)

Options weighed. A: keep reading the tier from the office config at every resume (today). B: snapshot all caps at run start and add recorded grants. C: read the config in force, but record any difference from the run's last caps as a grant-like fact when the run resumes. A lets a tier edit raise or lower a parked story's caps with no fact at all, which is the silent change 0001 and 0011 forbid. The maintainer chose B (decision 2), review loop limits included.

`runs` gains `max_turns` and `max_minutes` next to `budget_limit`, `loop_cap` and `review_round_cap`; 0019 story G adds `ci_cap`, `conflict_cap`, `review_max_turns`, `review_max_minutes` and `review_allowance`. A run's caps are its snapshot, plus 0019's review allowance for each review round started (budget only), plus the sum of its grants of each kind (`budget` with tokens, turns and minutes; `loop`; `reviewRound`; `ciAttempt`; `conflictHandoff`; `reviewCap` with reviewer turns and minutes). Run control, the resumer, re-attach and the 80% budget nudge all read this one function. `run_outcomes` gains the grant totals, so retro and the 0014 measurement see them. A tier edit affects new runs only.

### 6. The handoff a new session gets

Options for the model-written part. A: no worker notes, handoff from git and facts only. B: notes from every turn's report, replaced per agent (chosen). C: ask the worker for notes only at park time. C needs an extra turn on a run that has just hit a cap, which is the worst time. B costs nothing extra: the report already carries `notes`.

Decided, all written by engine code, no extra model call:

- **Worker notes.** Run control stores the `notes` of every turn report with `recordWorkerNotes` (at most 1,500 characters, 0014), keyed by worktree and agent, replacing that agent's earlier notes. A park keeps them. Teardown deletes them (tier T). So a cap that fires mid-turn, with no report from that turn, still leaves the previous turn's notes.
- **Context pack record.** The launcher and the resumer call `recordContextPack` whenever they build a task message (first session and every handoff), with the head SHA and blob ids of the scope and input files. It serves 0014 section 10: after a daemon restart the engine compares those ids with the worktree and rebuilds only changed packs. The input-changed nudge on a resumed session does not read it; it reads the session's `nudge_sources` (DIPO-99).
- **Open feedback.** The handoff's `feedback` is no longer empty: the run's feedback items not yet answered by a later green verify or approval (verify, CI, reviewer findings, conflict, scope), read with their text from 0019's `feedback_items`, plus the resume note.
- **What each kind of restart reads:**

| Restart | Reads |
|---|---|
| Native resume (`--resume`) | Only the first message (section 3); the transcript holds the rest |
| New session on the same run (handoff) | The full task message rebuilt from the base (story, context pack, inputs) plus the handoff block: commits since the claim's base, uncommitted diffstat and untracked files, criteria of the last report, last verify, open feedback, the newest worker notes |
| Re-claim of a released branch (after amend, M3, or an orphaned claim) | A handoff from git facts only; notes and pack were deleted with the worktree |
| After `work.discard` | A fresh first session, no handoff (branch and worktree are gone) |
| Reviewer | Never a handoff (0002, 0014) |

### 7. Answer before park

0008 section 6 already decides the wait: a worker that reports `blocked` with a question keeps its process waiting on stdin for `timeouts.questionWaitMinutes` (default 15); an answer in time goes in as the next user message (`delivered: "now"`); otherwise stdin closes and the story parks `ambiguous-spec`, and a later answer resumes the native session with the answer first (`on-resume`). Options weighed again: A, wait only while the maintainer is present, as for permissions; B, always wait (0008, kept); C, park at once (M0). B is kept: the wait costs no tokens and an answer within 15 minutes keeps the cache warm. The waiting process holds the office's one worker place for at most that long (0019 section 12); reviews keep running in the reviewer place. A stays a later tuning if waits block parallel workers in M2.

What M1a adds to make it work:

- The question is stored as a `questions` row (kind `question`, linked to the run and, after the park, to the park) and emitted as `question.asked` at once, so it shows on the desk during the wait.
- The wait time is left out of the run's minute cap, as `parked_ms` already does for parks.
- `work.answer` with text on such a question delivers it now or resumes the park. `dipo resume <id> --note` on an `ambiguous-spec` park with an open question answers that question.
- **CLI.** A worker question's answer is a flag, `dipo answer <question> --text <answer>`, so an answer that happens to be the word "allow" is never read as a decision. Permission and scope questions keep `dipo answer <question> allow|deny [reason]`. The M0 help text "any other text answers a worker question" changes accordingly (unreleased).
- **The answer is a story fact.** In the unpark commit (lane a), the engine adds it to the story's unknowns as `{q, status: "resolved", answer}` through the single field write path, so it reaches the base with the story PR and every later session through `<answers>` (0014 section 2). If adding it would break R26 (`prompt.contractMax`), the answer is still delivered but not written, with an `engine.notice`. The `questions` row keeps the full text either way.

### 8. Hold, drop and discard

All three are lane-b transitions or claim releases (0010 sections 2 and 2a). Code checks, journals and writes; nothing asks a model. Which PR a story has comes from 0019's `story_prs`.

| Command | From | Refused | What it does | Story PR | Branch and worktree |
|---|---|---|---|---|---|
| `story.hold` (`dipo hold <id> --note`) | Refined, Ready | Running: `story.notHoldable` naming `dipo stop`. Parked with a claim: `story.notHoldable` naming resume and discard | Journals a lane-b `hold` (F16 `{reason: on-hold, from, note}`, status Parked); the pending-op skip applies at once, even while the base still says Ready (0010) | None can exist | Untouched; a released branch stays released |
| `work.resume` of `on-hold` | Parked `on-hold` | | Lane-b op removing F16 and setting `park.from` | None | Untouched |
| `story.drop` (`dipo drop <id> [--delete-branch]`) | Draft, Refined, Ready, Parked | In Progress or In Review: `story.active` naming `dipo stop`. Another active story depends on it: `story.hasDependents`. Without `--delete-branch`, a worktree with uncommitted or untracked files: `story.dirtyWorktree` listing them | Releases the claim if any (0010 section 2a), then lane b archives (`task archive` or `draft archive`); `story.state` to Removed | Closed with a comment naming the drop | Worktree removed. Branch kept and recorded as released, unless `--delete-branch`: then worktree removed with `--force` and branch deleted locally and remotely |
| `work.discard` (`dipo discard <id> --note`) | In Progress, In Review, Parked; also the leftovers of a story Done elsewhere (section 10) and a PR whose head changed outside dipo (0019 section 9) | A PR in `story_prs` already merged (nothing to discard). A remote branch whose tip the engine did not push: the remote delete is refused with a notice, the rest goes on | Stops the run if active (as `work.stop`; `run.hostAlive` while the host lives), releases the claim, removes the worktree with `--force`, deletes the branch locally and remotely, closes questions, frees the slot; lane b writes Refined, so the story must pass the Ready gate again. For a story already Done on the base, no lane-b write | Closed with a comment naming the discard | Both gone |

**Options weighed.**

- *Hold of a claimed story.* A: allow it, turning any park into `on-hold` while the claim, worktree and slot stay. B: refuse (chosen). 0012 defines hold for unclaimed stories; a claimed story already shows on the desk, and listing it under "Held by you" would hide a story that still holds a worktree and a port slot.
- *An open PR on drop or discard.* A: leave it open. B: close it with a comment (chosen). An open PR for an archived or reset story can still be merged by hand on the host and would bring back a task file the backlog has moved past; a comment tells anyone on the host why it closed.
- *The branch on drop.* A: always delete. B: keep unless `deleteBranch` (chosen, 0005). Drop says the story is not wanted, not that its code is worthless; the flag is the maintainer's call per story.
- *A dirty worktree.* A: refuse every removal of a dirty worktree. B: allow forced removal only behind a typed confirmation that lists what is lost (chosen). Under A a parked story with uncommitted work, like DIPO-105, could never be cleaned up from dipo. So exactly two commands remove a dirty worktree with `--force`: `work.discard` and `story.drop` with `deleteBranch`. `work.discard` is `irreversible` and `story.drop` declares `irreversibleWhen: ["deleteBranch"]` in `commands.describe` (0009 section 8), so clients ask for the typed story id after listing the commits not on the base and the uncommitted and untracked files. Every other teardown keeps refusing a dirty worktree (0010).

Order follows 0010 section 2a: journal first, then the host PR, then release steps, then lane b. `parks.resolved_how` takes `drop`, `discard` and the new `done-elsewhere`. Confirmations otherwise stay as 0009 section 5: hold none (note required), drop yes.

### 9. Steer and pause

0008 section 6 decides the mechanics; M1a registers the commands and adds what the code needs.

- **`work.steer`** (`dipo steer <id> <text>`): one user message with priority `next`, wrapped in `feedback/steer.md` ("The maintainer says: {{text}}"), stored first as a `steer` intent. A paused or parked story stores the steer and sends it with the first message on resume; the reply says `delivered: "on-resume"`. No confirmation. A steer to a story whose live session is its reviewer is refused with `story.notSteerable` (0002: the reviewer gets no maintainer text), as is a steer to a follow-only host (0006).
- **`work.pause`** (`dipo pause <id>`): a `pause` intent and a now-priority message; the run stays In Progress with health `paused` (0009) and keeps its claim, its slot and its session place. After 10 minutes stdin closes and the process exits, which frees the place; `dipo resume <id>` continues it with `--resume` when allowed, queued if the place is taken. Paused time is left out of the minute cap. A pause that arrives while the engine itself runs verify takes effect before the next worker turn. No confirmation.
- `work.reassign` stays provisional in M1a (0003's M1a list names hold, drop, discard, steer and pause).

### 10. A story finished outside dipo

Options. A: leave it to the maintainer (M0). B: reconcile only, at daemon start and rescan. C: the Done poll and reconcile both check the story's status on the base, and code releases a claim whose story is Done there (chosen). The base status is a story fact (0001, 0007 section 6); when it says Done, code knows the story is finished and must not ask anyone.

**Trigger:** a live claim whose story reads `Done` on the base (`_base`, after a fetch) while its own branch is not detected Done. Checked by the Done poll (`polling.prStateSeconds`) and by reconcile. Base Done wins over the branch status for a claimed story; this narrows 0007 section 6's "story branch while claimed" for the one terminal state.

**A live worker is not stopped by code.** Options: A, stop it at once; B, raise a desk item and an `engine.notice` and release at the run's next end (chosen). The base can say Done because of a mistaken hand edit; stopping a working session on that alone is a guess. Under B the maintainer sees it at once and can `dipo stop`; otherwise the release happens when the run next ends (a park, In Review, or a stop).

**Release** of a parked or idle claim, in order, each step idempotent:

1. One transaction: claim released with reason `done-elsewhere`; run ended; open park resolved `done-elsewhere`; questions closed `ended`; `story.state` to Done; a notice naming the base commit that last changed the task file, as the evidence.
2. Close dipo's open story PR (from `story_prs`) with a comment naming that commit.
3. Worktree: removed when clean; kept when it holds uncommitted or untracked files.
4. Branch: deleted locally and remotely when `git merge-tree` shows it adds nothing to the base; otherwise kept and recorded in `released_branches` with reason `done-elsewhere`.
5. Anything kept is one desk item, "leftovers", with the commits not on the base and the dirty files, and the action `dipo discard <id>`, which removes them after showing the loss, with no lane-b write (section 8).

No lane-b write happens: the base already says Done, and Done is terminal (0012). Leftovers are never deleted automatically (decision 5). For DIPO-105 this releases the claim, keeps the worktree (it holds uncommitted files) and the branch, and puts one leftovers item on the desk.

### 11. When a worker asks for more

The worker's report (0014 section 2, 0008 section 1) gains two optional fields with fixed schemas and sizes, so code decides with no model call.

```ts
WorkerReport += {
  scopeRequest?: { paths: string[], why: string },                    // (a), with status "blocked"
  proposals?: { kind: "follow-up" | "spike", title: string,           // (c), and spikes from (b); at most 3
                outcome: string, why: string, paths?: string[] }[],
}
```

#### (a) Extra write paths

Options for how the worker asks. A: the worker writes first and the scope check at `done` turns out-of-scope paths into a request. B: the worker asks first with a blocked report that carries `scopeRequest`, and waits (chosen). A softens the hard gate 0014 decided (open question 2 there: nudge in the session, scope check at `done` is the gate) and gives no reason. B keeps the gate and costs one short turn.

**The package of a path.** In an office with a workspace (the root manifest's workspace list, as the 0013 scan reads it; in this repository `packages/*`), a path inside a workspace member belongs to that member's directory (`packages/engine/`). Any other path belongs to its top-level directory (`docs/`, `scripts/`, `.github/`). A file directly at the repository root belongs to no package. An office may replace this with `scope.packages`, a list of directory globs (for example `["packages/*", "apps/*"]`); a path matching none of them falls back to its top-level directory. A story **writes** a package when one of its declared or granted scope paths lies in it.

Code decides, in this order (decision 3):

1. **Valid:** every path passes R12, is not under `backlog/`, `.dipo/` or `.git/`, is not a path the adapter's deny rules protect (the `WorkerPort` lists them; for Claude, its settings files, 0008 section 2), and resolves inside the worktree (the nearest existing parent's real path, so a symlink cannot point outside it). Otherwise **refused** at once with the rule as the reason.
2. **Inside a package the story writes.** A path in any other package, or in no package, is **refused** at once: "outside the packages this story writes". The worker continues without it, asks a question (section 7), or proposes a follow-up (section 11c).
3. **Collision-free:** no prefix overlap with the declared or granted scope of another live claim (0012, 0010), and the component check when a map exists (0010 section 10). Otherwise refused, naming the colliding story.
4. **Contract size:** R26 still holds with the paths added. Otherwise refused.
5. **Restricted paths wait for the maintainer**, even inside the package: dependency manifests and lockfiles (names from the run profile, 0013), CI workflows (`.github/**`), `CLAUDE.md` and `AGENTS.md`, and decision records (`docs/decisions/**`). The list is `scope.restricted` (office config; these defaults, and an office may add globs but not remove these).
6. Otherwise **granted by code** at once, with no count limit beyond R26.

A grant: the engine adds the paths to the story's references (F8) on the story branch with `backlog task edit --add-ref` (lane a, a task-file commit `<ID>: scope add <paths>`, pushed), records the grant (`run_grants` kind `scope`, and a closed `questions` row kind `scope` decided by `rule`), and answers the waiting session now: "These paths are now in scope: …". The same session continues.

A restricted path: **the maintainer decides.** A `questions` row kind `scope` and `question.asked`; the session waits `timeouts.questionWaitMinutes` (section 7). `dipo answer <question> allow|deny [reason]` answers it; allow writes and records the grant as above, deny sends "do it without writing <paths>" plus the reason. No answer in time: the story parks with the new reason **`needs-scope`**, the question stays open, and the answer later resumes the run as decision 1b says.

A request mixing paths is decided per path: refused paths are refused, restricted ones wait, the rest are granted in the same commit.

Elsewhere: the scope check at `done` reads the run's starting scope plus its granted paths (0010 note). The nudge and the worker contract say "outside the declared scope; if the story needs it, report blocked with a scopeRequest" instead of "will be rejected" (0014 note). A grant is not an amend: criteria stay checked and only R11, R12, R26 and the collision check run on the new paths (0012 note). The base gets the widened scope when the story PR merges. The database journals the request and the decision; the granted path itself lives in the task file (0001, 0007).

#### (b) More input or research (decided: web search and fetch for now)

Options weighed. A: the worker reads only the worktree and the story's inputs (F9); anything wider becomes a question or a proposed spike. B: give the developer role Claude's `WebSearch` and `WebFetch` tools. C: a separate research session started by the engine. The maintainer chose B for now, to be refined later.

Decided:

- **What opens.** With the office key `worker.web` (default `true`), the developer role's tools gain `WebSearch` and `WebFetch` (`--tools`), and the run settings file allows both (with `--permission-prompts none` a tool call nothing allows is denied). Nothing else changes: Bash keeps the closed network (`strictAllowlist`, empty `allowedDomains`), so shell commands, tests and scripts still reach no host; the Safe-Chain install proxy stays the only package route. The reviewer never gets web tools (0019 section 4). `worker.web: false` restores M0's tool list.
- **Visible.** Every web call is a tool call in the stream, so the query or URL shows in the worker output (`work.output`, 0008 section 3) with its time. The run counts web calls by tool, stored on the run outcome, so retro and the overview see them.
- **Cost.** Search results and fetched pages enter the model's context, so their tokens count toward the story's budget like any other input; no separate research budget in M1a.
- **The contract.** L1 tells the worker it may search the web for documentation it needs, that every query and URL is shown to the maintainer, never to send repository content, secrets or file contents in a query or URL, and to ask a question when the answer is a decision, not a fact. A worker that needs a decision (an architecture choice) still reports `blocked` with a question, and may add a `proposals` entry of kind `spike`; the question follows section 7 and the proposal goes on the desk (c).
- **Risk accepted for now.** WebSearch and WebFetch run outside the Bash sandbox and follow permission rules only (0008 section 2). A fetched page is untrusted text that can try to steer the worker; the deny rules, the sandbox for Bash, the scope check and the backstop still bind what it can do. A URL can carry data out of the machine: anything the worker read could leave in a query string, including a worktree env file a script printed, so 0008's rule that worktree env files hold development secrets only matters more. No domain allowlist yet. The follow-up story "Refine worker research access" (story 18) decides domains, a research budget or call cap, and what is logged as facts.
- **Env values never leave in a web call** (maintainer, 2026-10-17). The Claude adapter refuses a WebFetch whose URL, and a WebSearch whose query, contains a value from the env files dipo copied into the worktree (the `copy` entries of `worktree.files`, 0010 section 8, read as `KEY=value` lines as for 0019 section 3's redaction), as written or percent-encoded. Neither path the adapter has today can do this: the relay's `PermissionRequest` hook fires only for a call no rule allows, and the run settings allow both tools; Claude Code's permission rules match WebFetch by domain only and cannot look at values. So the check runs in the hook relay, as part of story 17: the run settings register a `PreToolUse` hook with matcher `WebFetch|WebSearch`; `dipo hook PreToolUse` relays the URL or query whole and waits for the engine's answer within the relay's 2-second limit, as the nudge hooks do (DIPO-60); the engine's hook code compares it with the values and answers allow, or deny with the reason ("the URL contains a value from `<file>`; never send env values"), naming the file and key, never the value; the adapter prints Claude's `PreToolUse` deny. Because a silent relay would let the call through the allow rule, this hook fails closed: no answer in time prints a deny. A refused call shows in the worker output like any tool call. This accepts web fetch and search as a new egress path for development secrets with that check; the rule that worktree env files hold development secrets only stays. Data that is not an env value (a source file, a command's output) is not caught by the check; the follow-up story decides more.

#### (c) Improvements beyond the story

Options. A: proposals wait on the desk and become Backlog drafts only when the maintainer accepts them (chosen). B: a draft is created at once through a backlog PR. The M1 planning decision says "filed as a proposed follow-up story for the maintainer", which reads as a proposal the maintainer accepts. B would make every run add drafts and backlog PRs the maintainer then cleans up; A keeps the backlog the maintainer's.

Decided: never done in place. A worker that sees a refactor, a bug or a missing test outside its outcome adds a `proposals` entry of kind `follow-up` to any report, done or blocked. Code stores each proposal (`proposals` table: story, run, kind, title, outcome, why, paths, state `open`, `accepted`, `dismissed`) with caps on count and length, dedupes by a hash of title and paths, and shows it on the desk. It changes nothing about the story's own status. `dipo propose accept|dismiss <id>`: accept creates a Backlog draft (`backlog draft create`) through lane b with the title, the outcome line, the paths as references and the source story in the description; dismiss closes it. Promotion to a real story stays M3 (`refine`).

#### Who decides what

| Ask | Code decides | Waits for the maintainer | On the desk as |
|---|---|---|---|
| Scope request inside a package the story writes, valid, collision-free, within R26, not restricted | Granted at once | | Not listed; `story.detail` shows the grant |
| Scope request for a restricted path inside such a package | | Allow or deny | `SCOPE` row with paths and why |
| Scope request outside the story's packages, outside the worktree, invalid, colliding or too large | Refused at once with the reason | | Not listed |
| Facts from outside the repository | The worker searches and fetches (section 11b) | | Not listed; the calls show in the worker output |
| Question needing a decision | Wait, then park | An answer | `QUESTION` (during the wait) or `PARKED ambiguous-spec` |
| Proposed spike | Stored | Accept or dismiss | `PROPOSAL spike` |
| Proposed follow-up | Stored, deduped | Accept or dismiss | `PROPOSAL follow-up` |

### 12. The plain-text desk

Options. A: the CLI filters `office.snapshot` itself. B: a new engine read, `office.desk`, returns the items already ordered, with the command each item offers (chosen). 0005 and 0009 forbid clients from deriving status, and the TUI's desk view (M1b) and `dipo desk` must show the same thing in the same order.

`office.desk { office }` returns `DeskItem[]`: `{ kind, story?, key?, question?, gate?, pr?, proposal?, reason?, cause?, detail, since, blocks: StoryId[], actions: { command: CommandName, cli: string }[] }`, where `cli` is the exact command line to type, built by code, and `pr` comes from `story_prs`.

Order, by what unblocks work soonest:

1. `QUESTION`, `PERMISSION`, `SCOPE` with a live worker waiting on it (oldest first, with the time left).
2. `MERGE` gates waiting on the maintainer (0019 section 11), with the PR number and link and the waiting reason read from the gate's code-built summary, with the reasons 0019 section 11 lists (the desk does not keep its own list); actions `dipo approve` and `dipo reject`. A gate held by `autorelease: pending` offers no `dipo approve` (it would answer `gate.handMergeOnly`); its action is a hand merge on GitHub.
3. `PARKED`, needing a decision: `needs-permission`, `needs-scope`, `ambiguous-spec`; then needing a direction or grant: `review-blocked` (with the blocking findings), `conflict` (with the conflicted or unwritable paths), `verify-failing`, `scope-violation`, `budget-exceeded`; then restarts: `worker-failed`, `interrupted`, `stopped`. A `review-blocked` story, whose park also opened a merge gate (0019 section 11), is one `PARKED` row with both actions, `dipo resume --note` and `dipo approve --note`, not a second `MERGE` row.
4. `PR HEAD CHANGED` (0019 section 9, `pr.headChanged`: the story stays out of the merge slot and no merge gate opens; actions: a hand merge on GitHub, picked up by the Done poll, or `dipo discard`), `DONE ELSEWHERE` with a live worker, `LEFTOVERS` (section 10), a `BACKLOG PR` that failed its structural check or cannot rebuild, and notices that ask for a hand action (for example `done.claimGone`).
5. `PROPOSAL` (spike before follow-up).
6. "Held by you": `on-hold` stories, listed apart so they do not nag (0009).

Within a group, items that block the most other stories (dependents) come first, then the oldest. This replaces the "newest first" of 0009's desk mock (0009 note).

CLI: `dipo desk [--office <id>] [--json]`. Plain text, never Ink (0009 section 9), one line per item, a second indented line with the command to type, a count line on top. `--json` prints the read's result. Exit 0 always; an empty desk prints "Nothing waits on you." Example:

```
dipsaus-orchestrator · desk 4 · held 1
QUESTION DIPO-140  "Keep the old flag?" · worker waiting, 9 min left        6m
         dipo answer qst_01J… --text "<answer>"
PARKED   DIPO-105  budget-exceeded · turn cap 61 of 60 · 7 files uncommitted  9h
         dipo resume DIPO-105 --budget +50% --note "<why>"
LEFTOVERS DIPO-98  Done on main (a1b2c3d) · branch has 3 commits not on main  1d
         dipo discard DIPO-98 --note "<why>"
PROPOSAL DIPO-122  follow-up "Split RunOutcomes" · from run_01J…             2d
         dipo propose accept prp_01J… | dipo propose dismiss prp_01J…
Held by you (1)  DIPO-129 "after M2"   dipo resume DIPO-129
```

### 13. The structured summary on park and close

0001 asks the engine to write a short structured summary onto the task on park and close, so git carries the highlights.

Options. A: extend the F16 block with more keys (strict schema, R02 for every story). B: Backlog's native implementation notes and final summary (chosen). C: a model-written summary. B is native, visible in every Backlog view, needs no schema change, and code fills it from facts; C asks a model for something code knows.

- **On park:** in the same task-file commit as F16, `backlog task edit --append-notes` adds one block: date, reason and cause, detail (one line), run id, criteria met of total (claimed), loops of cap, review rounds and failed rounds, budget used of limit per cap, last good commit, number of uncommitted files.
- **On resume:** one line appended: date, resumed, grants, the note's first line.
- **On close:** in the close-out commit (0019 section 9 step 1), `--final-summary` with criteria met, loops, review rounds, budget used of limit, runs and resumes, each park in one line, grants, web calls, proposals filed.
- All values come from stored facts. The write path refuses a line of 50 dashes (0010).

### 14. Contract changes (all minor, contract 1.1, unreleased)

- **ParkReason:** new known value `needs-scope` (open enum since 2026-10-12). No other park reason: research questions stay `ambiguous-spec`, and done-elsewhere is not a park.
- **SkipReason:** no addition. A story with a pending lane-b hold or a scope question is already covered by `notRunnable` and `parked`.
- **QuestionKind** becomes an open enum with known values `question`, `permission`, `scope`. Allowed because contract minor 1 is unreleased: the DIPO-52 amendment of 2026-10-14 reshaped `Verdict.run` on the same ground, and the 2026-10-12 amendment made other kind enums open.
- **`work.resume`** args gain `budget?: { share: number } | { tokens: number }`; the result gains `grants?` and `queued?`. New errors: `resume.topUpRequired`, `resume.topUpTooSmall`, `resume.noteRequired`, `resume.notResumable`, `resume.capReached`, `resume.decisionRequired` (needs-permission, needs-scope).
- **`commands.describe`** gains `confirmWhen?: string[]` (`work.resume` declares `["budget"]`) and `irreversibleWhen?: string[]` (`story.drop` declares `["deleteBranch"]`).
- **`work.steer`** result: `delivered` becomes `"next-turn" | "on-resume"`.
- **`work.answer`** accepts `decision` on scope questions as on permission questions.
- **New read** `office.desk` [`desk`]. **New commands** `proposal.accept`, `proposal.dismiss` [`proposals`].
- **Registered** (no longer provisional): `story.hold`, `story.drop`, `work.discard`, `work.steer`, `work.pause`, each with its `since`. `story.parked.actions` lists `work.resume` for every reason and cause it now handles, `gate.approve` for `review-blocked`, and `work.answer` for `needs-scope`.
- **Events:** `story.parked` gains `cause?`; `question.asked` carries kind `scope`; new `proposal.filed` and `proposal.closed`.
- **Errors:** `story.notSteerable`, `story.dirtyWorktree`.

### 15. Database changes (0007 note)

- `parks`: `cause` (text), `resolved_note` (text); `resolved_how` gains `done-elsewhere` (this ADR's story 10) and `override` (0019 story L).
- `runs`: `max_turns`, `max_minutes`; 0019 story G adds `ci_cap`, `conflict_cap`, `review_max_turns`, `review_max_minutes`, `review_allowance`.
- New `run_grants`: run, grant id, kind (`budget`, `loop`, `reviewRound`, `ciAttempt`, `conflictHandoff`, `reviewCap`, `scope`), amount JSON, note, origin, client, at; tier S with its run.
- New `proposals`: story key, run, kind, title, outcome, why, paths, hash, state, decided by, draft id, times; tier S.
- `questions`: kind `scope` (the SQL check of migration 22 gains it), and `paths` for it.
- `claims` release reason and `released_branches` reason `done-elsewhere`. The story's PR is read from 0019's `story_prs`; this ADR adds no PR column.
- `run_outcomes`: grant totals and web calls by tool.

Office configuration, after 0019 story A's version: `worker.web` (story 17), then `scope.packages` and `scope.restricted` (story 13); each takes the next version with its in-memory migration (0017 amendment of 2026-10-12). DIPO-116 (M1b) comes after them.

### 16. CLI forms

| Form | Command | Confirmation |
|---|---|---|
| `dipo resume <id> [--note <text>] [--budget +<n>%\|+<tokens>] [--yes]` | `work.resume` | yes/no with `--budget` (`confirmWhen`), showing caps before and after |
| `dipo answer <question> allow\|deny [reason]` | `work.answer` on permission and scope questions | none |
| `dipo answer <question> --text <answer>` | `work.answer` on a worker question | none |
| `dipo hold <id> --note <text>` | `story.hold` | none |
| `dipo drop <id> [--delete-branch] [--yes]` | `story.drop` | yes; typed id after the loss list with `--delete-branch` |
| `dipo discard <id> --note <text>` | `work.discard` | typed id, after the loss list |
| `dipo steer <id> <text>` | `work.steer` | none |
| `dipo pause <id>` | `work.pause` | none |
| `dipo propose accept\|dismiss <proposal>` | `proposal.accept`, `proposal.dismiss` | none |
| `dipo desk [--json]` | `office.desk` | read only |

All take `--office <id>` as the other office commands do. `dipo approve` and `dipo reject` are 0019's.

## Amends

Dated notes, one per touched ADR, each added under its "Amendments" (maintainer, 2026-10-17):

- **0005:** "2026-10-17, DIPO-132 (maintainer): sections 1 and 9. Office commands whose effects take time run on a waiting path: the idempotency check and the story references in one transaction; the handler outside it, committing each fact with its change-log entries in its own transaction; the `requests` row last. A duplicate that arrives while the first runs waits for the same reply. Every waiting handler must be target-state under a re-run: a retry after a crash between a commit and the record runs the handler again, and it must see its earlier facts and not repeat their effects. Each waiting command has a test that injects a crash at that point. Today `work.run`, `work.stop`, `work.answer` and `work.resume` use it. M1a adds `story.hold`, `story.drop`, `work.discard` (also on the leftovers of a story Done on the base, where it writes nothing to the backlog), `work.steer` (also when the run is paused or parked: the steer is stored once, keyed by its request, and sent on resume) and `work.pause`. `office.rescan` and other commands that finish in one transaction keep the rule of section 1. Sections 4, 5 and 7, contract 1.1: `needs-scope` park reason; `QuestionKind` open with `scope`; `work.resume` gains `budget`, `grants` and `queued` and the `resume.*` errors; `commands.describe` gains `confirmWhen` and `irreversibleWhen`; `work.steer` may reply `on-resume`; `work.answer` takes `decision` on scope questions; new read `office.desk` and commands `proposal.accept` and `proposal.dismiss`; `story.hold`, `story.drop`, `work.discard`, `work.steer` and `work.pause` ship; `story.parked` gains `cause`; new events `proposal.filed` and `proposal.closed`; errors `story.notSteerable` and `story.dirtyWorktree`."
- **0007:** "2026-10-16, DIPO-132 (maintainer): section 4. `parks` gains `cause` and `resolved_note`, and `resolved_how` gains `done-elsewhere` and `override`; `runs` gains `max_turns` and `max_minutes`, so every cap of a run is a snapshot taken at its start; new `run_grants` (tier S) and `proposals` (tier S); `questions` gains kind `scope` and `paths`; `run_outcomes` gains grant totals and web calls. A run's caps are its snapshot plus its recorded grants; an office config edit affects new runs only. Section 6: for a claimed story, a `Done` status on the base wins over the branch's status, and the claim is released as `done-elsewhere`."
- **0008:** "2026-10-16, DIPO-132 (maintainer): sections 1, 2, 6 and 7. `WorkerReport` gains `scopeRequest` and `proposals`; the `WorkerPort` lists the paths its deny rules protect. With the office key `worker.web` (default true) the developer role also gets Claude Code's WebSearch and WebFetch tools, allowed in the run settings; this replaces 'WebFetch, WebSearch ... stay out' for the developer role only. The Bash sandbox network stays closed and the reviewer gets no web tools. WebSearch and WebFetch run outside the Bash sandbox, so a URL can carry data off the machine; accepted for now, with the rule that worktree env files hold development secrets only; domains and limits follow in a later story. The Claude adapter refuses a WebFetch whose URL, or a WebSearch whose query, contains a value from the env files dipo copied into the worktree (0010 section 8), through a `PreToolUse` hook for those two tools in the hook relay: the relay waits for the engine's answer as the nudge hooks do, and for this hook prints a deny when no answer arrives (permission rules match WebFetch by domain only, and the `PermissionRequest` hook does not fire for an allowed call). This accepts web calls as a new egress path for development secrets with that check, and the rule that worktree env files hold development secrets only stays (maintainer 2026-10-17). The question wait stores a question row, is left out of the minute cap and holds the worker place. Caps of a resumed run are its start snapshot plus recorded grants. `budget-exceeded` resumes only with a recorded top-up that grows tokens, turns and minutes by the same share; 'never raise the budget' means never without the maintainer's command."
- **0009:** "2026-10-16, DIPO-132 (maintainer): sections 4, 5 and 8. The desk is ordered by what unblocks work soonest (questions with a waiting worker, merge gates, parks needing a decision, then a direction, then restarts, hand actions, proposals, held stories), replacing 'newest first'. `dipo desk` is the plain-text desk next to `dipo watch`; the TUI desk (M1b) reads the same `office.desk`. `commands.describe` gains `confirmWhen` and `irreversibleWhen`."
- **0010:** "2026-10-16, DIPO-132 (maintainer): sections 2a and 7. The scope check at `done` reads the run's starting scope plus the paths granted by scope requests. `work.discard`, and `story.drop` with `deleteBranch`, remove a dirty worktree with `--force` after a typed confirmation that lists what is lost; every other teardown still refuses one. The Done poll and reconcile release a claim whose story is `Done` on the base through another branch (release reason `done-elsewhere`), keeping a worktree or branch that holds work not on the base as a desk item. A story parked on a rejected push resumes by merging the remote branch into the local one through the 0019 conflict hand-off, never by force."
- **0012:** "2026-10-16, DIPO-132 (maintainer): section 2. A scope request adds F8 paths to a claimed story in lane a without amend, checked by R11, R12, R26 and the collision check on the new paths: code grants a path inside a package the story already writes, refuses a path outside those packages or outside the worktree, and asks the maintainer for dependency manifests, lockfiles, CI workflows, `CLAUDE.md`, `AGENTS.md` and decision records. New park reason `needs-scope` (In Progress to Parked; resume returns to `park.from`). `hold` of a claimed story is refused. Discarding the leftovers of a story Done on the base writes nothing to the backlog."
- **0014:** "2026-10-16, DIPO-132 (maintainer): sections 2, 3, 6 and 8. The report gains `scopeRequest` and `proposals`. The scope nudge and the worker contract say 'outside the declared scope; if the story needs it, report blocked with a scopeRequest'. L1 for the developer says the worker may search the web for documentation, that every query and URL is shown to the maintainer, and never to put repository content or secrets in a query or URL. New L5 templates `answer`, `topup`, `steer`, `maintainer-note`. The handoff carries open feedback from `feedback_items`; worker notes are stored from every turn report and context packs whenever a task message is built. Section 6 is unchanged: a resume after a top-up or a scope answer uses the native session only when its cost check passes."

## Consequences

- Every park has a way back or an explicit reason why not, and every way back that gives a run more is a recorded command. The desk and `story.detail` show who raised what and why.
- A tier edit affects new runs only; a parked story gets more only by a recorded grant.
- A worker can widen its scope inside the packages it already writes without the maintainer; restricted files wait on the desk, and anything outside is refused, so the story's reach stays bounded by its own packages.
- Workers can look things up on the web. That saves parks on missing facts and adds a path for data to leave the machine and for untrusted text to reach the worker, accepted until the follow-up story narrows it. A URL or query that holds a value from a copied env file is refused by code; other data is not caught.
- The wait before a park holds a worker process idle, and the office's worker place, for up to 15 minutes per question. It costs no tokens and keeps the cache warm.
- Writing answers and granted paths into the task file adds task-file commits on the story branch; they change no code and need no verify (0010).
- Leftovers of a story finished by hand show on the desk until the maintainer discards them.
- The engine grows: a resume policy table, grants, proposals, a desk read. Moving park resume out of `RunOutcomes` first keeps that class from growing further (2026-10-16 review, CC3).
- This ADR depends on 0019's tables and stories (D, E, G, I, J, K, L); a change there moves the matching rows here.

## Implementation stories for slice:m1a

All in milestone `m-1`, label `slice:m1a` (story 18 excepted), after DIPO-115 (cutover gate, maintainer decision 2026-10-16). Letters refer to 0019's stories. CLI tests live next to the code in `packages/cli/src/`. The 0005 amendments of DIPO-131 and DIPO-132 already list the contract additions of stories 4, 8, 9, 11, 12 and 14, so those stories do not list `docs/decisions/`; a story whose additions are not listed there adds them to 0005's Amendments.

| # | Title | Outcome (one line) | References | Depends on | Tier |
|---|---|---|---|---|---|
| 1 | Move park resume and work.resume out of RunOutcomes into one resume module | Park resume and `work.resume` live in one module with a policy table, and `RunOutcomes` no longer holds them, with behaviour unchanged | `packages/engine/src/run/`, `packages/engine/src/hooks/park-answers.ts`, `packages/engine/test/run/`, `packages/daemon/src/runs.ts` | DIPO-115, DIPO-128 (or folded into DIPO-128); 0019 story D depends on this story | M |
| 2 | Take a run's caps from its start and its grants | A run's caps are its start snapshot plus recorded grants, read by one function everywhere, and a tier edit reaches new runs only | `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/src/run/`, `packages/engine/src/hooks/nudges.ts`, `packages/engine/src/retention/`, `packages/daemon/src/runs.ts`, `packages/engine/test/run/`, `packages/engine/test/db/` | 1 | S |
| 3 | Write worker notes and context packs for the handoff | Every turn's notes and every session's context pack are stored, and a handoff carries notes and open feedback | `packages/engine/src/run/`, `packages/engine/src/prompts/`, `packages/engine/src/context/pack.ts`, `packages/engine/test/run/`, `packages/engine/test/prompts/` | 1, 0019 I | S |
| 4 | Resume a parked story with dipo resume | `dipo resume <id> [--note]` resumes the matrix rows that need no grant and no review loop (stopped by the maintainer, interrupted, developer worker-failed, verify refused, scope paths, backstop and hand change with a new snapshot, tampered refused), with required notes, note templates and `parks.resolved_note` (`parks.cause` comes from 0019 D); a resume that finds its place taken is queued (section 1, 0019 section 12) | `packages/contract/src/`, `packages/contract/schema/`, `packages/engine/src/run/`, `packages/engine/src/prompts/feedback/`, `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/src/retention/`, `packages/cli/src/`, `packages/engine/test/run/`, `packages/engine/test/db/` | 1, 2, 3, 0019 D, E | M |
| 5 | Top up a budget-exceeded story | `dipo resume <id> --budget +N% --note` raises tokens, turns and minutes by the same share as a recorded grant after confirmation, resuming the developer or a fresh review; a plain resume is refused naming the option | `packages/contract/src/`, `packages/contract/schema/`, `packages/engine/src/run/`, `packages/engine/src/commands/`, `packages/engine/src/reads/describe.ts`, `packages/cli/src/`, `packages/engine/test/run/`, `packages/engine/test/reads/`, `docs/decisions/` | 4, 0019 G | M |
| 6 | Resume capped, conflicted and review-loop stories | Resuming `verify-failing` (loops, ci), `conflict` (merge in progress, unwritable path, push rejected, slot refused), `review-blocked` (one more round with a note), `stopped` / `pr-closed`, `stopped` / `review`, `worker-failed` / `review` and `worker-failed` / `review-cap` works per the matrix, each noted resume adding one round as a grant | `packages/engine/src/run/`, `packages/engine/src/merge-slot/`, `packages/engine/src/story-pr/`, `packages/engine/test/run/`, `packages/engine/test/merge-slot/` | 4, 0019 G, J, K, L | M |
| 7 | Wait for an answer before parking on a worker question | A worker question waits `questionWaitMinutes` on the desk while holding the worker place, an answer goes in now or resumes the park, `dipo answer --text` exists, and the answer is written as a resolved unknown | `packages/engine/src/run/`, `packages/engine/src/hooks/`, `packages/engine/src/backlog/fields/`, `packages/engine/src/views/`, `packages/cli/src/`, `packages/engine/test/run/`, `packages/engine/test/hooks/` | 4, 12 | M |
| 8 | Hold and drop stories through the backlog lane | `dipo hold` and `dipo drop` work as section 8 says, including the resume of an on-hold story and closing an open story PR | `packages/contract/src/`, `packages/contract/schema/`, `packages/engine/src/backlog/lane/`, `packages/engine/src/stories/`, `packages/engine/src/worktree/`, `packages/engine/src/features.ts`, `packages/daemon/src/`, `packages/cli/src/`, `packages/engine/test/backlog/`, `packages/engine/src/run/`, `packages/engine/test/run/` | DIPO-115, 0019 E | M |
| 9 | Discard a story's work | `dipo discard <id>` lists what is lost, then ends the run, removes worktree and branch, closes the PR and returns the story to Refined | `packages/contract/src/office.ts`, `packages/engine/src/worktree/`, `packages/engine/src/run/`, `packages/engine/src/backlog/lane/`, `packages/engine/src/features.ts`, `packages/daemon/src/`, `packages/cli/src/`, `packages/engine/test/worktree/` | 8, 0019 E | M |
| 10 | Release a claim when a story is Done on the base through another branch | The Done poll and reconcile release a parked or idle claim whose story is Done on the base, flag one with a live worker, and put kept leftovers on the desk | `packages/engine/src/worktree/`, `packages/engine/src/reconcile/`, `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/src/views/`, `packages/daemon/src/`, `packages/engine/test/worktree/`, `packages/engine/test/reconcile/`, `packages/engine/test/db/` | 9, 12, 0019 E | M |
| 11 | Steer and pause a running worker | `dipo steer` and `dipo pause` reach the worker as 0008 section 6 says, a steer to a paused or parked story is sent on resume, a steer to a reviewer is refused, and paused time is left out of the minute cap | `packages/contract/src/office.ts`, `packages/contract/schema/`, `packages/engine/src/run/`, `packages/engine/src/prompts/feedback/`, `packages/cli/src/`, `packages/engine/test/run/` | 1, 0019 D, F | M |
| 12 | List what waits on the maintainer with dipo desk | `office.desk` returns ordered items with the command to type, and `dipo desk` prints them in plain text | `packages/contract/src/`, `packages/contract/schema/`, `packages/engine/src/views/`, `packages/engine/src/reads/`, `packages/cli/src/`, `packages/engine/test/views/` | 4, 0019 L | M |
| 13 | Let a worker request extra write paths inside its packages | A blocked report with `scopeRequest` is granted by code inside the story's packages, refused outside them or outside the worktree, asked on the desk for restricted files, and grants reach the task file and the scope check; `scope.packages` and `scope.restricted` arrive in the next office config version | `packages/contract/src/`, `packages/contract/schema/`, `packages/engine/src/workers/`, `packages/engine/src/run/`, `packages/engine/src/hooks/`, `packages/engine/src/prompts/`, `packages/engine/src/config/`, `packages/engine/src/scan/`, `packages/engine/schema/`, `packages/engine/scripts/write-schema.ts`, `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/src/views/`, `packages/engine/test/run/`, `packages/engine/test/workers/`, `packages/engine/test/config/`, `packages/engine/test/office/`, `packages/engine/test/db/`, `docs/decisions/` (the `questions.kind` SQL check of migration 22 gains `scope`) | 2, 7, 12, 17, DIPO-133, 0019 A | L |
| 14 | File follow-up and spike proposals from a worker | Report proposals are stored, shown on the desk, and accepted ones become Backlog drafts through the backlog lane | `packages/contract/src/`, `packages/contract/schema/`, `packages/engine/src/workers/`, `packages/engine/src/run/`, `packages/engine/src/backlog/lane/`, `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/src/retention/`, `packages/engine/src/reads/hello.ts`, `packages/engine/src/features.ts`, `packages/daemon/src/`, `packages/cli/src/`, `packages/engine/test/run/`, `packages/engine/test/db/` | 8, 12 | M |
| 15 | Write the structured summary on park, resume and close | The task file carries a code-built summary in implementation notes on park and resume and in the final summary on close | `packages/engine/src/run/park.ts`, `packages/engine/src/backlog/fields/`, `packages/engine/src/merge-slot/`, `packages/engine/test/run/` | 4, 14, 17, 0019 K | S |
| 16 | Prove waiting commands are safe to re-run | Each waiting office command has a test that crashes between its commit and its request record and shows a retry repeats no effect | `packages/engine/src/commands/`, `packages/engine/test/commands/` | 5, 7, 8, 9, 11 | S |
| 17 | Give workers web search and fetch | With `worker.web` (default true, next office config version after 0019 A) the developer role gets WebSearch and WebFetch allowed in its run settings, the reviewer and the Bash sandbox network stay as they are, every call shows in the worker output and is counted on the run outcome, a `PreToolUse` hook in the hook relay refuses a URL or query holding a value from the copied env files and fails closed (section 11b), L1 gets the research lines, and a live recording shows a search, a fetch and a refused fetch | `packages/engine/src/workers/`, `packages/engine/src/hooks/`, `packages/daemon/src/`, `packages/engine/test/hooks/`, `packages/engine/src/prompts/`, `packages/engine/src/config/`, `packages/engine/schema/`, `packages/engine/scripts/write-schema.ts`, `packages/engine/src/run/`, `packages/engine/src/db/migrations/`, `packages/engine/src/db/schema.ts`, `packages/engine/test/db/`, `packages/engine/test/run/`, `packages/engine/test/workers/`, `packages/engine/test/prompts/`, `packages/engine/test/config/`, `packages/engine/test/office/`, `packages/engine/test/recordings/claude-cli/`, `tools/recordings/`, `docs/decisions/` | DIPO-115, 0019 A | M |
| 18 | Refine worker research access (follow-up, not slice:m1a; the maintainer sets its slice) | A decision and its code on which domains a worker may fetch, a research budget or call cap per story, and which web calls are stored as facts, replacing the open web access of story 17 | `packages/engine/src/workers/`, `packages/engine/src/config/`, `docs/decisions/` | 17 | M |

## Sources

1. ADRs 0001, 0003 (amendment of 2026-10-16), 0005, 0006, 0007, 0008, 0009, 0010, 0012, 0013, 0014, 0015, 0017, with their amendments; 0019 (DIPO-131); maintainer decisions of 2026-10-16 (M1 planning and the spike answers) and 2026-10-17 (secrets, design details).
2. Code on main at b3f847e: `packages/engine/src/run/park.ts`, `run/outcomes.ts`, `run/resume.ts`, `run/control.ts` (`parkForReconcile`), `run/backstop.ts`, `run/caps.ts`, `run/plan-limit.ts`, `run/verify-commit.ts`, `run/work-run.ts`, `hooks/park-answers.ts`, `hooks/permissions.ts`, `hooks/questions.ts`, `prompts/handoff.ts`, `prompts/notes.ts`, `prompts/contract/implement.md`, `prompts/feedback/`, `context/pack.ts`, `workers/claude-cli/report-schema.ts`, `workers/claude-cli/plan.ts`, `worktree/done.ts`, `worktree/teardown.ts`, `reconcile/reconcile.ts`, `commands/execute.ts`, `config/schema.ts`, `db/migrations/0010`, `0020`, `0022`, `0023`; `packages/daemon/src/runs.ts`; `packages/contract/src/office.ts`, `work.ts`; `packages/cli/src/index.ts`.
3. Milestone review 2026-10-16 (`docs/reviews/`, not committed): rows 1.3 and 1.4, CC3, the 0005.3 drift and open question 6.
4. DIPO-115 cutover findings 6, 7, 9, 11 and 13 (DIPO-105).
5. Backlog.md 1.53.0 `task edit --help`: `--add-ref`, `--append-notes`, `--final-summary`; `draft create`.
6. Claude Code docs, settings and permissions (WebSearch and WebFetch permission rules, tools outside the Bash sandbox), as cited in 0008; hooks reference (`PreToolUse` matchers and `permissionDecision: "deny"`).
7. Code on main at 107a2cb: `packages/engine/src/workers/claude-cli/hooks.ts` (`REGISTERED_HOOKS` has no `PreToolUse`; `WAITING_HOOK` is `PermissionRequest`), `packages/daemon/src/hook.ts` (the relay is silent on every failure and keeps only written paths of a tool input for a call that does not wait).

## Amendments

- 2026-10-19, DIPO-205 (maintainer): maintainer decision "Budget-exceeded resume", decision 6a and sections 2 and 4. A run whose cap-crossing turn carried a done report does not park `budget-exceeded` (0008 note of 2026-10-19). If the verify of that done path fails, no turn is left for feedback, so the story parks `verify-failing` with the new cause `capped` and the failure as its detail; `capped` wins over `loops` when the same verify reaches the loop cap. Its resume needs a note, like the `loops` and `ci` causes (decision 6a gains `capped`), and grants the section 4 top-up: all three caps grow by 50% of the starting caps as one budget grant recorded with who and why. Writing the note is the explicit act, so no further confirmation is asked (section 4's `confirmWhen: ["budget"]` covers `--budget` only); the reply names the grant. The first message is the verify failure from the park detail, then the note (a design detail following the `loops` row). A resume without a note answers `resume.noteRequired`; when one crossing turn overshot so far that the +50% still leaves a cap reached, the resume answers `resume.topUpTooSmall` (section 4, "Too small") and `--budget` may give a larger share. A later round the engine sends back to the worker after a capped done path (a review or CI fix round, a conflict hand-off) whose caps are still used up parks `budget-exceeded` before any worker session starts; its top-up resume sends that round's undelivered feedback first, then `feedback/topup.md` (a design detail). A maintainer resume of such a run follows section 1 step 1 (`resume.capReached`, naming `--budget`).
- 2026-10-20, DIPO-227 (maintainer): section 8. `story.drop` also answers the retryable `run.hostAlive` while a worker host of the parked run whose claim it would release still runs, as `work.discard` does, with and without `deleteBranch`. That drop changes nothing: no journal entry, no closed story PR, no worktree or branch removed; the maintainer drops again once the host has exited.
- 2026-10-20, DIPO-186 (maintainer): section 11. The worker report gains an optional field `decisionNotes`, at most 3 entries of decision file, section and note text, for a note the worker proposes for a decision record. dipo carries it as data and shows it to the maintainer, and never writes it to `docs/decisions/`.
- 2026-10-20, DIPO-256 (maintainer): sections 5 and 6. Every feedback message and the handoff carry a budget line: the turns, minutes and tokens used and left. The worker contract (L1) says that at about 80% of any cap the worker stops new work, finishes, and reports done or blocked with what is left.
- 2026-10-21, DIPO-263 (maintainer, decision 0021): a worker's question is live only while a TUI is connected at that moment, else the story parks with it (0021 section 11). Park and resume keep the story's box (0021 section 6). Web access is open to the whole internet with registries only through Safe-Chain (0021 section 3); the §11b allowlist idea is replaced.
- 2026-10-22, DIPO-161 (maintainer): sections 8 and 10. A remote branch is deleted by discard or release only when its tip is one dipo pushed (the local tip, an ancestor of it, or a commit that adds nothing to the base), and the delete is pushed with a lease on that tip; any other remote tip is kept and named. dipo discard deletes exactly what its loss list showed. The leftovers of a story Done elsewhere are kept as a fact until dipo discard clears them, and the desk lists them. A done-elsewhere release whose PR close fails warns once and does not retry.
