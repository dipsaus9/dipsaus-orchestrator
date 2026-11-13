# 0010 Backlog.md and git

Status: accepted. First written 2026-10-10 (spike DIPO-7). Rewritten 2026-10-24 for the simplified design. The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Decision in short

Every backlog change is a commit in a pull request, so it reaches a protected base and survives a re-clone. A running story's own changes travel in its story PR (the **story lane**). Planning changes travel in one backlog-only PR per office (the **planning lane**). **One module makes every commit, ref change and push** (`git/write.ts`); the story-git modules use it. It works in dipo's own copies, never in the maintainer's checkout and never in a box. A claim is a branch, and a story has no Mac worktree.

## 1. The Backlog CLI

- **Version.** dipo supports Backlog.md **1.53.x**, pinned in `package.json`. It checks `backlog --version` at office load and refuses any other version. A new minor is adopted by recording its `--plain` output as fixtures and passing the parser tests.
- **Only through the CLI.** dipo runs `backlog … --plain` through the platform module and never edits a task file by hand. It reads the CLI's output from a file, never from a pipe. The only files it reads directly are `backlog/config.yml`, for the status list, a root `backlog.config.yml`, for the folders the StoryStore keeps its stories in, and, in the check before each CLI call, the files of those folders the CLI could read: each folder's `config.yml` and the task files. The task files of those folders are also read in one pass for the Ready gate's other active tasks (their id, status, dependencies and frozen branch), never written (0012); the pass reuses that check and the runner's front-matter preparation and parse, and a task file it cannot parse fails the read.
- **Never run:** `task complete`, `cleanup`, `task demote`, `doctor --fix`, `config set statuses`, and any edit to the status `Draft`.
- **Refused inputs.** dipo refuses to run the CLI on a folder whose files it cannot check (0008).
- **The parser.** One parser covers `task view`, `draft view`, `task list` and `draft list`, and is tested against recorded output.
  - An error is a non-zero exit or a `not found` line.
  - Every write is read back and compared.
  - A section starts at a known name followed by a line of exactly 50 `-`. Each known name appears once, in fixed order, or the parse fails (R02).
  - dipo refuses to write text that contains a line of 50 `-`.
  - Unknown keys or sections are kept raw and logged, never guessed.

## 2. Where backlog writes land

**The story lane.** From the claim until the claim is released, every change to a story is a commit on its own branch, and it travels in the story PR:

- status `In Progress` at the claim;
- criteria ticks and `In Review` (0002);
- the park record, status `Parked` and its lift (0020);
- the close-out: final summary and status `Done` (0002).

Each edit runs the CLI in a fresh folder of dipo's own. The folder holds only the Backlog configuration from the base and the story's task file as committed at the branch tip, both read from git objects. dipo then commits the changed task file alone with `commit-tree`, as `<ID>: status <state>`, and pushes. These commits change no code and need no verify. A story branch may change no other `backlog/` file. Because the base shows a story's lifecycle only when its PR merges, `Done` and "merged" happen together.

**The planning lane.** Changes that belong to no story PR go on an engine branch `dipo/backlog-<UTC time>`: office init, park and resume of a story that has no run, drop, accepted ideas filed as drafts, the stories a planning session files, edits and refines from drafts (0022), and the other M3 rituals.

- **Journaled.** Each operation is a target-state entry in the database journal: `pending`, `applied`, `committed`, `pushed`, `merged`, `dropped`, `withdrawn`, or `failed`. It is applied through the CLI in the `_backlog` worktree and committed as `backlog: <op> <ID>`. When the CLI exits with a code other than 0 on an operation, or what it wrote does not read back, that operation is closed as `failed` with a notice, and the operations after it go on. A killed, timed-out or unstarted CLI, a refused file or a git error still fails the whole flush, and its operations stay journaled.
- **One PR per office.** dipo pushes the branch and opens or updates one backlog-only PR. Later operations append to it until it merges, so many stories can change in one bulk PR.
- **Fast.** A backlog-only PR runs the light CI path (0016), so it merges in minutes. It blocks nothing but its own stories.
- **A structural check by code,** with no model, stands in for the reviewer (0002). The PR passes only when:
  - it changes only `backlog/` paths, or the role files `.dipo/roles/<name>.md` of the role operations below;
  - every changed task parses;
  - each status change is an allowed 0012 transition, among them a new task or a promoted draft at `Ready`, which a PR that also changes code may not add: CI refuses that on every PR, against the PR's base;
  - each new `Ready` matches a passing gate decision for that task's content, stored under its key, or with no key when the lane filed the story before the base held it;
  - it touches no story with a live claim.
- **Merged by GitHub.** When the check passes, dipo runs `gh pr merge --auto --squash`, as for story PRs (0002). When the maintainer merges by hand, the check runs again afterwards, and on a failure `work.run` skips the affected stories, with a notice, until a new backlog PR fixes them.
- **A pending operation wins over pickup.** `work.run` skips any story with an unmerged journaled operation. A park on a Ready story takes effect the moment it is journaled. A park whose operation `failed` still holds its story from pickup until the maintainer sends the park again and it is written, drops or discards the story, or dismisses the park with `dipo resume`, whatever the story's status; retention keeps it while it holds.
- **Rebuild, never force.** When the base moves under the open branch and the changes conflict, dipo resets `_backlog` to the base and applies the unmerged operations again. An operation that no longer applies is dropped with a notice. A rebuilt branch gets a new name and its old PR is closed.
- **Role files.** The operations `role-add`, `role-edit` and `role-remove` (0022) write or delete `.dipo/roles/<name>.md` (0017) in the `_backlog` worktree. They are the only operations that may change paths outside `backlog/`, and only under `.dipo/roles/`: the lane drops any change to another path outside `backlog/`. Each checks again when it applies: an addition whose file exists, an edit or removal whose file is gone, an edit whose result does not load, and a removal while a story that is not Done has the role's label do not apply and are dropped with that reason.
- **Filing and editing stories.** What the maintainer confirms in a planning session (0022) reaches the lane as two operations, each a target state read back after it is applied.
  - `file` creates a story Refined to the story standard (0012): `task create` with the title, the description (the `Story:` line and the context below it), the status `Refined`, the type, the milestone, the label `tier:<t>`, the criteria, the references and the dependencies, then the field block with the branch `<ID>/<slug>` frozen from the id the CLI gave, an empty `unknowns` list and the test plan. Its commit is `backlog: file a new story`. Applied again, it finds the task with its title whose description starts with its Story line and creates none. Once the task reads back, the same operation evaluates the Ready gate (0012, `ready` mode) on it in `_backlog`, stores the decision for its content with no key, which the index gives the story's key once the base holds it, and sets the task `Ready` when it passes, read back with that content; when it fails it stays Refined, and the gate's answer is the operation's notice, which the planning view shows. A refined draft is filed the same way. The id goes into the planning session's record (0007) once the lane created the story; a rebuild that gives the story another id replaces it there.
  - `revise` changes an existing task while it is Refined, Ready or Parked, as `backlog: revise <ID>`: its title, its Story line and context with the field block kept byte for byte, its criteria (`--clear-ac`, then one `--ac` each, since 1.53 takes neither with the other) and its references (`--ref` for each, which 1.53 reads as the whole list), each only when it differs. A story in another status, or gone, no longer applies. A Ready story is gated again on its revised content in the same operation and stays Ready only when it passes. A split is one `file` and one `revise`.

**Pickup reads the base.** `work.run` reads stories from `_base`, a detached worktree moved to `origin/<base>` after every fetch, and picks only stories that are `Ready` there.

**Several stories at once.** An office runs up to `caps.parallelRuns` stories at the same time (default 3, 0002), and `work.run` claims a story while others run. Each running story has its own claim, branch, story PR and box; the office's one git queue orders their refs and pushes, and the planning lane stays one per office. A start at the limit is skipped as `capacity`, naming the limit and the setting.

**Next up: how a free slot gets its story.** While a run slot is free and a Ready story can start, dipo puts one NEXT UP item per free slot on the desk, with the desk notification (0020). Each names the story and one line of why. The order is the Ready stories of the earliest milestone, by milestone number, that still has one, then priority, ordinal and id; stories without a milestone come last. A story with a dependency not Done, a live claim, a pending planning operation or a story PR dipo recorded as merged is never offered, even before the base's next fetch says Done. Each item lists the files its references share with the references and changed files of the running stories, or says it shares none. The maintainer decides on that: nothing acts on overlap while stories run, and a conflict is fixed at merge (0002). `dipo next confirm <ID>` starts the story through the same start as `dipo run <ID>`, and each confirm starts without waiting for another story's box. `dipo next decline <ID>` removes the item and offers the next story at once. A declined story is not offered again until its task file changes or the maintainer starts it by hand; the decline is local work state (0007). `nextUp.autoStart` in `.dipo/office.yaml` (0017) is `none` or `no-overlap`, `none` by default, and is not allowed in `office.local.yaml`. With `none` nothing starts without a confirm. With `no-overlap`, after each refresh dipo takes the offers in order, one at a time while slots stay free, and starts each through the same start as the confirm, in a request of its own with origin `other` (the run records that dipo started it), when all of these hold: its references are not empty; it shares no file with the references and changed files of the running stories, nor the references of the stories still starting or started in this pass; the changed files of every running story were read in this refresh without an error; the office's starts are not paused (0020) or at a plan limit, dipo is not updating and the desk does not offer `dipo update`; and `work.run`'s pickup checks pass. Anything unknown starts nothing. It logs the start at INFO and puts an `engine.notice` `run.nextUpStarted` ("started <ID> by itself: it shares no files with the running stories"), and no NEXT UP item is left for it. An offer it does not start stays a NEXT UP item, its why saying "not started by itself" and the reason, the shared files and story included. It tries an offer once: a start that was skipped, threw or failed later is not tried again until the story's task file or the next-up signature changes, and the maintainer can still confirm it.

## 2a. The StoryStore seam

The engine reads and writes stories only through one interface, `StoryStore`:

- **reads:** list the stories of a base or a branch, and read one story with its fields;
- **writes:** set the status, tick criteria, write the park reason and notes, write the final summary, add a resolved unknown, file a draft, create a Refined story, and change a story's title, Story line and context, criteria and references.

The Backlog.md implementation is this ADR: the CLI, the task-file commits of the story lane and the backlog PRs of the planning lane. Every other part of the engine only knows the interface. Another tracker, such as Jira, would be another implementation of it; that is Later (0003), and it would also change where story facts live (0001).

## 3. Stories in the task file

- **Labels** carry enumerations, because the CLI filters on them: tier `tier:S|M|L`, role `role:<name>`, the flag `test-before-merge`, and `slice:<name>`. These names are reserved. dipo sets labels with `--labels` only when it creates a story, and changes them only with `--add-label` and `--remove-label`.
- **The field block** carries structured data: one fenced block with the info string `dipo`, last in the description.

  | Key | Holds |
  |---|---|
  | `branch` | The frozen branch name (0012 F15) |
  | `unknowns` | `{ q, status: open \| resolved, answer? }` entries; answers to worker questions land here (0020) |
  | `test_plan` | `{ entries: [{ kind: automated \| manual, check, expect? }] }`, or `{ not_applicable: <reason> }` |
  | `park` | `{ reason, from, note }`, only while Parked, with a reason from 0001 |

  The block is parsed with `Bun.YAML.parse` and a strict zod schema: unknown keys fail, and every text value must be a YAML string. A write changes only the block, writes it back with `task edit --description`, and reads it back to compare.
- **The StoryKey** is never written to the repository. It lives only in the database (0005).
- **The slug** is computed once, when the story gets its real id, and then frozen:
  1. NFKD-normalise, drop combining marks, and lowercase.
  2. Treat every run of characters outside `[a-z0-9]` as a space, and split into words.
  3. Drop the short words (`a`, `the`, `and`, `of` and the like), unless nothing would remain.
  4. Join with `-`, up to 40 characters.

  The branch is `<ID>/<slug>`.

## 4. Office init

Office init is one backlog PR, and each step is target-state:

1. Rewrite the `statuses:` line of `backlog/config.yml` to the 0012 list, keeping any old status still in use.
2. Set `defaultStatus` to `Refined`.
3. Move every `To Do` task to `Refined`.
4. Set `check_active_branches: true`, `remote_operations: true` and `auto_commit: false`.
5. Add `.dipo/.gitignore` with `office.local.yaml` (0007).
6. Seed the developer role: write `.dipo/roles/developer.md` (version 1, a one-line purpose, the bundled developer instructions as the body), only while the base's `.dipo/roles/` holds no role file (0017).
7. Label the open stories: add `role:developer` to every task that is not `Done` and has no `role:` label, under the same condition as step 6. A task that has a role label is never changed.

Once a role file is on the base, steps 6 and 7 are not planned again, so a maintainer who removes the developer role later is left alone.

dipo records the previous values. Existing ignore files are never edited.

## 5. The git contract

| Item | Rule |
|---|---|
| Who runs git | On the maintainer's repository, only dipo's git module. A box has its own local repository that shares nothing with it and that dipo never runs git in from the Mac (0008); the reviewer reads a `git archive` copy; the maintainer's main checkout is never written |
| Hardened calls | Every call runs with `GIT_CONFIG_NOSYSTEM=1`, `GIT_DIR` and `GIT_COMMON_DIR` set from recorded paths, `core.hooksPath=/dev/null`, `core.fsmonitor=false` and `commit --no-verify` |
| One queue | One serial git queue per office orders refs and pushes |
| Base and remote | `base` in `.dipo/office.yaml`, else `refs/remotes/origin/HEAD`; else `run` is refused. The remote is `origin` |
| Worktrees | Only dipo's own two: `_base` (detached at `origin/<base>`, for reads) and `_backlog` (the planning lane), under `worktree.root` (default `../<repo>.worktrees`), outside the main checkout |
| Claim | The exact local ref is absent and `git ls-remote --heads origin <branch>` is empty. Then `git update-ref refs/heads/<branch> <start> ""` creates the branch atomically, and a `claims` row with unique indexes holds it (0007). Then come the claim commit, the push and the box (0008). A lost race is a skip |
| Parts | Committed from git objects on the branch ref, then pushed (0008) |
| Code tree key | The hash of `git ls-tree -r <commit>` without the story's own task file. Verdicts are keyed on it (0002) |
| Conflict check | `git merge-tree --write-tree origin/<base> <branch>`. Exit 0 is clean, exit 1 with a tree and conflict lines is a conflict, and anything else is an error, not a conflict |
| Base sync | When the base moved, before a resumed or fix round session, and on a conflict, as a merge from objects committed with its markers (0002). Never a rebase |
| Push | Never forced, never to the base. A rejected push parks the story `conflict` |
| Merge and Done | GitHub merges with `--squash` (0002). Done is the one Done check of 0002: the PR merged, or the story reads `Done` on the base while dipo holds its claim. It never comes from ancestry. `merge-tree` showing that a branch adds nothing to the base only decides whether the branch may be deleted (0020) |
| Teardown | After Done, drop or discard: delete the local branch, delete the remote branch with a lease on the tip dipo pushed, and delete the box. A ref dipo did not create is never deleted |

**When something fails:**

| Case | What dipo does |
|---|---|
| The story's branch is already held by another story's key, or is unknown to dipo | Skip `collision`, with a notice |
| A released branch of the same story | Reuse it at its kept tip. A conflict with the base is found by the conflict check and settled by a base sync (0002) |
| A fetch fails | Pickup and planning pushes wait (retryable); running work continues |
| An `index.lock` or ref lock is held | Retry three times with backoff, then fail the step. Lock files are never deleted |
| A branch changed outside dipo | A notice. A head dipo did not push is never merged (0002) |

## 6. Additive and removable

| Written | Where | Removed by |
|---|---|---|
| Statuses and default status | `backlog/config.yml`, through a backlog PR | A backlog PR restoring the recorded values |
| Reserved labels and the `dipo` field block | Stories | A backlog PR through the CLI |
| `.dipo/` files | The repository, created only if absent | Deleting them |
| `_base`, `_backlog` | The worktree root | `office forget`, or by hand |
| Story and `dipo/backlog-*` branches | Refs | Deleted after merge; the rest are listed |

There are no git hooks, no changes to existing ignore files or `info/exclude`, and no git config changes.

## Replaced

- A Mac worktree per story at `<root>/<ID>`, locked with `git worktree lock`, plus a setup contract that copied env files, ran install, `setup` and `post_create` on the Mac, and gave each worktree a machine-wide port slot (2026-10-10). Replaced by the box (0008), with files copied through `box.files` and install in the box. The test box needs no port slots (0002).
- A merge slot for story and backlog PRs (2026-10-10). Replaced by GitHub auto-merge (0002, 2026-10-24).
- One running story per office, with `work.run` calls of an office run one after another (2026-10-10). Replaced by up to `caps.parallelRuns` stories at once (0002, 2026-11-04).
- The office-load sweep of story worktrees an earlier binary left, with `worktree.rebuildable` and a desk item for the kept ones (2026-10-29). Gone with the database squash (0007, 2026-11-03).
- Verify and commit at done with a scope check on the worktree, and lockfile pairing (2026-10-10). Replaced by parts, verify in the box with the required checks last (0002), and references as a forecast (0008).
- A building-time sync for riskier stories (2026-10-10). Removed; dipo syncs only on a conflict (2026-10-24).
- A base sync only on a conflict (2026-10-24). Replaced by a sync when the base moved, before a resumed or fix round session, and on a conflict (2026-11-08, DIPO-464), because a box cannot reach the base.
- A conflict merge left in progress in a worktree (2026-10-16). Replaced by a merge committed with markers (0002).
- A reused branch merged with the base at claim, with a conflict as the worker's first feedback (2026-10-10). Replaced (2026-10-28) by reuse at the kept tip, then the conflict check and base sync (0002).
- Seven separate places that made commits, and pushes from eight. Replaced by one module that makes every commit, ref change and push (2026-10-24).
- A lane flush that failed as a whole when the CLI failed on one operation, so every operation after it waited (2026-10-10). Replaced by closing that operation as `failed` (2026-10-30).
- Draft promotion with a journaled snapshot (2026-10-10). It moved to M3 and is designed when it is built (0003).
- An optional component map for collision checks (2026-10-10). It is M2 work and is designed then (0003).
- `amend` releasing a claim with its task file restored to the merge base. That is M3 work (0003).
- The Ready gate's other active tasks read with one CLI view each (2026-10-10). Replaced by one pass over the task files (2026-11-13, DIPO-494): a view loads the whole backlog, so the read cost a process per task.
- "Nothing starts without a confirm" (2026-11-04, DIPO-440). Replaced by `nextUp.autoStart` (2026-11-13, DIPO-499): `none` keeps it, `no-overlap` starts an offer that shares no files with the running stories by itself.
- A StoryStore that could not create a story or change its wording, so the maintainer created and reworded every story by hand (2026-10-24). Replaced by the planning lane's `file` and `revise` operations for what the maintainer confirms in a planning session (0022, 2026-11-06).
