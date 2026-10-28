# 0010 Backlog.md and git

Status: accepted. First written 2026-10-10 (spike DIPO-7). Rewritten 2026-10-24 for the simplified design. The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Decision in short

Every backlog change is a commit in a pull request, so it reaches a protected base and survives a re-clone. A running story's own changes travel in its story PR (the **story lane**). Planning changes travel in one backlog-only PR per office (the **planning lane**). **One git module makes every commit and push**, in dipo's own copies, never in the maintainer's checkout and never in a box. A claim is a branch, and a story has no Mac worktree.

## 1. The Backlog CLI

- **Version.** dipo supports Backlog.md **1.53.x**, pinned in `CLAUDE.md`. It checks `backlog --version` at office load and refuses any other version. A new minor is adopted by recording its `--plain` output as fixtures and passing the parser tests.
- **Only through the CLI.** dipo runs `backlog … --plain` through the platform module and never edits a task file by hand. It reads the CLI's output from a file, never from a pipe. The only file it reads directly is `backlog/config.yml`, for the status list.
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

**The planning lane.** Changes that belong to no story PR go on an engine branch `dipo/backlog-<UTC time>`: office init, park and resume of a story that has no run, drop, accepted proposals, and later the M3 rituals.

- **Journaled.** Each operation is a target-state entry in the database journal: `pending`, `committed`, `pushed`, `merged`, or `dropped`. It is applied through the CLI in the `_backlog` worktree and committed as `backlog: <op> <ID>`.
- **One PR per office.** dipo pushes the branch and opens or updates one backlog-only PR. Later operations append to it until it merges, so many stories can change in one bulk PR.
- **Fast.** A backlog-only PR runs the light CI path (0016), so it merges in minutes. It blocks nothing but its own stories.
- **A structural check by code,** with no model, stands in for the reviewer (0002). The PR passes only when:
  - it changes only `backlog/` paths;
  - every changed task parses;
  - each status change is an allowed 0012 transition;
  - each new `Ready` matches a passing gate decision for that task's content;
  - it touches no story with a live claim.
- **Merged by GitHub.** When the check passes, dipo runs `gh pr merge --auto --squash`, as for story PRs (0002). When the maintainer merges by hand, the check runs again afterwards, and on a failure `work.run` skips the affected stories, with a notice, until a new backlog PR fixes them.
- **A pending operation wins over pickup.** `work.run` skips any story with an unmerged journaled operation. A park on a Ready story takes effect the moment it is journaled.
- **Rebuild, never force.** When the base moves under the open branch and the changes conflict, dipo resets `_backlog` to the base and applies the unmerged operations again. An operation that no longer applies is dropped with a notice. A rebuilt branch gets a new name and its old PR is closed.

**Pickup reads the base.** `work.run` reads stories from `_base`, a detached worktree moved to `origin/<base>` after every fetch, and picks only stories that are `Ready` there.

## 2a. The StoryStore seam

The engine reads and writes stories only through one interface, `StoryStore`:

- **reads:** list the stories of a base or a branch, and read one story with its fields;
- **writes:** set the status, tick criteria, write the park reason and notes, write the final summary, add a resolved unknown, and file a draft.

The Backlog.md implementation is this ADR: the CLI, the task-file commits of the story lane and the backlog PRs of the planning lane. Every other part of the engine only knows the interface. Another tracker, such as Jira, would be another implementation of it; that is Later (0003), and it would also change where story facts live (0001).

## 3. Stories in the task file

- **Labels** carry enumerations, because the CLI filters on them: tier `tier:S|M|L`, role `role:<name>`, the flag `test-before-merge`, and `slice:<name>`. These names are reserved, and dipo changes labels only with `--add-label` and `--remove-label`.
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

dipo records the previous values. Existing ignore files are never edited.

## 5. The git contract

| Item | Rule |
|---|---|
| Who runs git | On the maintainer's repository, only dipo's git module. A box has its own local repository that shares nothing with it and that dipo never runs git in from the Mac (0008); the reviewer reads a `git archive` copy; the maintainer's main checkout is never written |
| Hardened calls | Every call runs with `GIT_CONFIG_NOSYSTEM=1`, `GIT_DIR` and `GIT_COMMON_DIR` set from recorded paths, `core.hooksPath=/dev/null`, `core.fsmonitor=false` and `commit --no-verify` |
| One queue | One serial git queue per office orders refs and pushes |
| Base and remote | `base` in `.dipo/office.yaml`, else `refs/remotes/origin/HEAD`; else `run` is refused. The remote is `origin` |
| Worktrees | Only dipo's own two: `_base` (detached at `origin/<base>`, for reads) and `_backlog` (the planning lane), under `worktree.root` (default `../<repo>.worktrees`), outside the main checkout. A story worktree an earlier binary left there (locked `dipo <run-id>`) is removed at office load with `git worktree remove` when it holds no change, untracked or ignored file but `node_modules`; any other is kept and listed on the desk |
| Claim | The exact local ref is absent and `git ls-remote --heads origin <branch>` is empty. Then `git update-ref refs/heads/<branch> <start> ""` creates the branch atomically, and a `claims` row with unique indexes holds it (0007). Then come the claim commit, the push and the box (0008). A lost race is a skip |
| Parts | Committed from git objects on the branch ref, then pushed (0008) |
| Code tree key | The hash of `git ls-tree -r <commit>` without the story's own task file. Verdicts are keyed on it (0002) |
| Conflict check | `git merge-tree --write-tree origin/<base> <branch>`. Exit 0 is clean, exit 1 with a tree and conflict lines is a conflict, and anything else is an error, not a conflict |
| Base sync | Only on a conflict, as a merge from objects committed with its markers (0002). Never a rebase |
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
- Verify and commit at done with a scope check on the worktree, and lockfile pairing (2026-10-10). Replaced by parts, verify in the box with CI as the final gate (0002), and references as a forecast (0008).
- A building-time sync for riskier stories (2026-10-10). Removed; dipo syncs only on a conflict (2026-10-24).
- A conflict merge left in progress in a worktree (2026-10-16). Replaced by a merge committed with markers (0002).
- Seven separate places that made commits, and pushes from eight. Replaced by one git module (2026-10-24).
- Draft promotion with a journaled snapshot (2026-10-10). It moved to M3 and is designed when it is built (0003).
- An optional component map for collision checks (2026-10-10). It is M2 work and is designed then (0003).
- `amend` releasing a claim with its task file restored to the merge base. That is M3 work (0003).
