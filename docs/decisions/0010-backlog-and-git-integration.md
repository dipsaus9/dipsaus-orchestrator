# 0010 Backlog.md and git integration

Status: Accepted (spike DIPO-7, maintainer approval 2026-10-10). Amends accepted 0012 and 0002 (see "Amends 0012 and 0002").

## Context

Code owns everything it can know about stories, branches and worktrees (0001, 0011 item 4). Git is the history engine for code and for the durable story record (0001), and this repository's `main` is protected: PRs required, linear history, admins included. 0012 left these to DIPO-7: final storage of the non-native fields (F10 to F16), the slug algorithm, parsing `--plain` output, draft promotion as one retry-safe operation, the `To Do` to `Refined` migration, and how `completed/` and archived tasks are treated. 0011 and the vision add gitignored files such as `.env` missing in a fresh worktree, and ports for parallel worktrees. Research ideas 7, 12 and 18 are owned here. Related: 0013 (accepted) supplies the run profile (install, `setup`, `dev`, verify, env example files, fixed ports); 0005 (Proposed) gives every story a `StoryKey`; 0006 (Proposed) runs workers in detached worker hosts and keeps software state under `<state>`; 0014 (Proposed) makes the engine, not the worker, run git, Backlog.md and verify; 0017 (Proposed) pins Backlog.md 1.53.0 and puts office configuration in `.dipo/office.yaml`.

Maintainer rules added during this spike (2026-10-10): the engine's verify runs once before In Review, not per worker round or commit, and CI runs verify on every PR's merge ref; base sync is not done by default, only on a conflict detected by code or for a riskier story.

### Facts checked in scratch repositories (Backlog.md 1.48.0 and 1.53.0, git 2.50.1, Bun 1.3.5)

1. `task view --plain`: `File:` line, `Task <ID> - <title>`, a rule of 50 `=`, `Key: value` header lines (Status with an icon such as `○` or `✔`, Priority, Type, Ordinal, Created with minute precision, Updated, Labels, Milestone, References, Documentation), then sections: a name line and a rule of exactly 50 `-`. In 1.53 dependencies are a `Dependency Graph:` section (`└─ DIPO-1 - One [To Do]`) instead of a header line, and `task list` adds `(ac: 0/1)`. The output format changes between minor versions.
2. A description containing `Acceptance Criteria:` plus a 50-dash rule prints a second, fake section (both versions).
3. Unknown id: 1.48 prints `not found` and exits 0; 1.53 exits 1, as it does for a missing dependency or an invalid status.
4. `--dep` replaces the whole list; `--add-label` and `--remove-label` leave other labels alone.
5. 1.48 cannot edit drafts; 1.53 has `draft edit` with all fields. `draft promote` prints no new id, gives the task `default_status`, keeps labels, references, criteria and dependencies, and does not rewrite `DRAFT-n` dependencies elsewhere. A freed `DRAFT-n` and an archived `DIPO-n` are both reused by the next create (both versions).
6. `config set statuses` is refused; `config set defaultStatus` accepts a name not in the list; `config set checkActiveBranches` works.
7. **Cross-branch reading.** On 1.48 with `check_active_branches: true`, a task committed as `In Progress` on another branch vanished from `task list --plain` on main, and the effect was not stable between runs. On 1.53, `task list` and `task view` read only the local working copy (the CLI says so), whatever other branches hold, even an archive on another branch. The flag still matters on 1.53 for **id allocation**: with `true`, a task created on main skipped an id already used by a committed task on another branch (DIPO-7, not 6); with `false` it reused it (DIPO-6). The browser view resolves each task to its most progressed copy [1].
8. `git worktree add -b <branch>` run twice in parallel: one wins, the other fails with `cannot lock ref` and leaves nothing. A branch checked out in one worktree cannot be checked out in another [2].
9. `git worktree remove` refuses modified or untracked files and locked worktrees, and removes ignored files with the worktree [2].
10. `git merge-tree --write-tree A B` prints a tree OID and exits 0 when clean; on conflict it exits 1 and prints the tree OID followed by conflicted files and messages [3].
11. `.git/info/exclude` is shared by all worktrees [4]. `Bun.YAML.parse` exists and types scalars (`0123` becomes 123) [5].

## Options

**Where backlog writes land.** A: uncommitted edits in the maintainer's main checkout (lost on stash, reset or re-clone; never reach a protected main; `pull --ff-only` aborts on an edited file). B: engine commits pushed straight to the base (blocked by branch protection). C, **chosen**: everything goes through PRs. Lifecycle changes of a running story travel in its own story PR, as this repository works today; planning changes go in backlog-only PRs from an engine branch.

**Field block format.** YAML in a fenced block (readable, typeable, the format 0017 picks), JSON (tiring by hand), or `key: value` lines (cannot hold lists). YAML with a strict schema.

**Claim.** Status (does not cross branches, fact 7 and dipsaus-ai's measurement [6]), assignee, or **the branch ref**, shared by all worktrees through the one `.git`.

**Worktree location.** Inside the repository makes Node module resolution walk up into the main checkout's `node_modules` [7] and lets indexers see nested checkouts (research 7.5). A **configurable root, default a sibling directory**, avoids both.

**Env files.** Symlink (a worker could write through it into the main checkout) or **copy**.

## Decision

### 1. Backlog CLI, version and parsing

- Supported: **Backlog.md 1.53.x**, the version 0017 pins. The engine checks `backlog --version` at office load and refuses others. A new minor is adopted by adding recorded `--plain` fixtures and passing the parser tests. 1.48 is not supported (no `draft edit`, unstable list results, fact 7).
- The engine runs `backlog … --plain` through the platform module (0004) in an engine-owned worktree (section 2), never in the maintainer's main checkout. It never reads task files directly, except `backlog/config.yml` for the status list (section 6).
- **Never run:** `task complete`, `cleanup`, `task demote`, `doctor --fix`, `config set statuses`, and any edit to status `Draft`. `doctor` without `--fix` runs at reconcile; reported duplicates become an `engine.notice`.
- **Parser.** One parser for `task view`, `draft view`, `task list`, `draft list`, tested against recorded output. Lines are LF-split, NFC-normalised. An error is any non-zero exit or a `not found` line (fact 3); every write is read back and compared. Line 1 must be `File:`, line 2 `Task <ID> - <title>`. Header lines match known keys only; lists split on `, ` (safe: labels follow the grammar in section 3, scope paths have no whitespace per R12, and the write path rejects documentation entries containing `, `). Dependencies are the first-level entries of the dependency graph. A section starts at a known name followed by a line of exactly 50 `-`; each known name appears at most once and in fixed order, otherwise it is a parse error shown as R02 (fact 2). The engine refuses to write any text containing a line of 50 `-`. Unknown keys or sections are kept raw and logged, never guessed.

### 2. Where backlog writes land

**(a) Story lane.** From the claim until the claim is released, every change to the story is committed by the engine on that story's branch and travels in the story PR: status `In Progress` (claim commit), criterion check-offs, implementation notes, park record (F16) and status `Parked`, `In Review`, and the close-out (final summary, modified files, status `Done`) in the last commit before merge. The engine runs the CLI inside the story worktree and commits only the story's own task file in separate commits (`<ID>: status <state>`), which change no code and need no verify. The engine pushes the story branch (no PR yet) right after the claim commit and after each park commit, so the claim is visible to `ls-remote` from other clones and in-flight facts survive the loss of the machine; before that push they are durable only locally. **The story's own task file is the only `backlog/` path a story branch may change**; any other `backlog/` change is a scope violation. The base shows the story's lifecycle exactly when the PR merges, so `Done` and "merged" coincide.

**(b) Planning lane.** Changes that belong to no story PR, namely `plan` (drafts), `refine` (promotion, field edits), `ready` and `unready`, `hold` and `resume` of a story that is not running, `amend`, drop, office init and migrations, go on an engine branch `dipo/backlog-<UTC yyyymmddThhmmss>` in the engine's backlog worktree (`<root>/_backlog`). Each operation is journaled (DIPO-4), applied through the CLI, and committed (`backlog: <op> <ID>`). The engine pushes the branch and opens or updates one backlog-only PR per office; further operations append to the open branch until it merges. It is merged under the normal review rules (0002). **The reviewer contract for a backlog-only PR is a structural check by code**, no model: only `backlog/` paths change; every changed task parses (R02); each status change is an allowed 0012 transition; each new `Ready` matches a passing gate decision stored for that task's content; no task with a live claim is touched. The check runs when the PR is opened or updated and again immediately before the engine merges it. When the maintainer merges by hand, it runs again right after the merge; a failure becomes a notice and the affected stories are not run until a new backlog PR fixes them (until M1 adds it as a required status check). Auto-merge after a passing check extends 0002 (Amends 0002, item 3; open question 1).

Consequences of the two lanes:

- Planning operations refuse a story with a live claim (it belongs to lane a). They apply once the claim is **released**: after `story.drop` following `work.stop`, after `work.discard` (0005), and after `amend` of a parked story (section 2a).
- `run` picks only stories that are `Ready` **on `origin/<base>`**, so a Ready transition takes effect when its backlog PR merges. Story branches are cut from `origin/<base>`, so the claim commit edits the same task-file version the base has.
- **A pending lane-b operation always wins over pickup.** `run` and the pickup re-check skip any story with an unmerged journaled lane-b operation (hold, unready, drop, amend, discard or any field edit), with SkipReason `notRunnable` and the notice "pending backlog PR". A hold on a Ready story takes effect the moment it is journaled, even while `origin/<base>` still says Ready.
- Reads for `run` and the pickup re-check come from a second engine worktree, `<root>/_base`, detached at `origin/<base>` and moved there after every fetch. `_backlog` is for planning only.
- **Updating the backlog worktree.** Before each planning batch and after any fetch that moves `origin/<base>`: fetch; for each backlog file the engine changed on the open branch, if the incoming blob on `origin/<base>` equals the engine's blob the local change is dropped (it has merged); otherwise the branch is rebuilt by resetting the backlog worktree to `origin/<base>` and re-applying the unmerged journaled operations, which are target-state, through the CLI. An operation that no longer applies (the story was changed or claimed meanwhile) is dropped with a notice. If the open backlog PR was already pushed, rebuilding pushes a new branch name and closes the old PR; it never force-pushes.
- **The maintainer's main checkout is never written by the engine.** The maintainer switches, stashes or resets it freely; nothing of the engine's is pending there.
- Without a remote, branches stay local and the maintainer merges them by hand; the engine reports what is waiting.

**2a. Releasing a claim.** Every transition from a claimed story back to Refined, Ready or Removed runs in this order:

1. **Journal first.** In one office-database transaction the engine journals the lane-b target-state operation and, where the branch is kept, the "released for StoryKey" record. From this moment the pending-op skip covers the story, so no pickup can re-claim it.
2. **Check the host PR.** If the story PR is already merged, the release is refused with a notice and the journal entry is withdrawn. Otherwise an open PR is closed; the next In Review opens a new one.
3. **Release steps** from the table below. Each is idempotent (ending an ended run, removing a removed worktree, deleting a deleted ref, a restore commit that already exists), and after a crash the engine replays unfinished releases from the journal before any pickup.
4. **Lane b** writes the operation; the story stays covered by the pending-op skip until its backlog PR merges.

**Ordering in the office git queue.** Two kinds of work each run as one item in the office's serial git queue, so they never interleave: (a) the pickup re-check (reading the journal and `_base`) together with the claim (`git worktree add -b`) and the claim commit; (b) journaling a lane-b operation together with its live-claim check. A hold therefore lands either before the pickup re-check, which then skips the story, or after the claim, where the live-claim check refuses it and points to `work.stop`.

| Transition | Branch | Release steps |
|---|---|---|
| `work.discard` (0005, if accepted): In Progress, In Review or Parked to Refined | deleted | End the run, remove the worktree, delete local and remote branch; lane b writes Refined |
| `amend` of a parked story (0012): Parked to Refined | **kept**, with its work | On the branch: restore the story's task file to its merge-base version (`git checkout <merge-base> -- <file>`), commit `<ID>: release claim`, push; remove the worktree; record the branch as released for this story. Lane b writes Refined, the amended fields and unchecked criteria |
| `story.drop` after `work.stop` | kept or deleted as asked (0005) | End the run, remove the worktree; lane b archives |

A later claim of a story with a released branch reuses it (`git worktree add <path> <branch>`) and always merges `origin/<base>` into it before the claim commit, a deterministic exception to "no sync by default", so the branch picks up lane b's task file. That merge cannot conflict on the task file, because the branch holds the merge-base version. If it conflicts in code, the engine aborts the merge (`git merge --abort`), completes the claim, and starts the worker with the conflict as its first feedback; the worker merges within its caps, else the story parks `conflict` with `park.from` In Progress.

### 3. Non-native fields (final storage)

**Labels** for enumerations and the flag, because the CLI filters on them: F11 tier `tier:S|M|L` (set from office config, exactly one, R16); F12 role `role:<name>` (at most one, R17); F13 `test-before-merge`. These prefixes and the label are reserved. Label grammar `[a-z0-9-]+(:[A-Za-z0-9-]+)?`. The engine changes labels only with `--add-label` and `--remove-label`.

**The field block** for structured data: one fenced block with info string `dipo`, last in the native description, after the `Outcome:` line and free context:

````markdown
Outcome: the daemon restarts without losing running workers.

```dipo
branch: "DIPO-12/daemon-restart-keeps-workers"
unknowns:
  - q: "Does the host survive SIGKILL of the daemon?"
    status: "resolved"
    answer: "Yes, tested on macOS and Linux."
test_plan:
  entries:
    - kind: "manual"
      check: "Kill the daemon during a run, start it again"
      expect: "The run continues and the TUI shows it"
park: { reason: "on-hold", from: "Ready", note: "Waiting for Bun 1.4.3" }
```
````

| Key | Field | Schema |
|---|---|---|
| `branch` | F15 | R18 pattern |
| `unknowns` | F10 | list of `{q, status: open \| resolved, answer?}` |
| `test_plan` | F14 | `{entries: [{kind: automated \| manual, check, expect?}]}` or `{not_applicable: <reason>}` |
| `park` | F16 | `{reason, from, note}`, only while Parked; `reason` is 0005's `ParkReason` enum (includes `on-hold`, `stopped`, `interrupted`, `needs-permission`, `worker-failed`) |
Parser: zero or one block; a line exactly ```` ```dipo ```` opens it, the next line exactly ```` ``` ```` closes it; a second block, an unclosed block or text after it fails R02. Content goes through `Bun.YAML.parse` behind the platform module, then a strict zod schema shared from `contract`: unknown keys fail, and every text value must be a YAML string, so `answer: 5173` fails with "quote this value" (fact 11). The StoryKey (0005) is never written to the repository; it lives only in the state database (open question 7).

Single write path, the same in both lanes: `task view` (or `draft view`), parse, change the typed value, emit canonically (fixed key order, double-quoted strings, two-space indent), splice so every byte outside the block is unchanged, write with `task edit --description` (or `draft edit`), read back and compare. Just before writing the engine re-reads; if the description changed, it parses again and reapplies the target-state operation. One serial write queue per worktree.

### 4. Slug algorithm (F15)

Computed once when the story gets its real id, from the title at that moment, then frozen: (1) NFKD-normalise, drop combining marks, lowercase; (2) replace each run of characters outside `[a-z0-9]` with a space and split into words; (3) drop `a an the and or of to for in on with` unless nothing remains; (4) join with `-`, adding whole words while the result is at most 40 characters, cutting a single over-long first word at 40; (5) if empty, `story`. Branch `<ID>/<slug>` matches R18 by construction. Because ids are reused after archive (fact 5), an existing local or remote ref starting with `<ID>/` produces a notice at promotion; the claim compares exact branch names, never `<ID>/*`.

### 5. Draft promotion, retry-safe

Dependencies on drafts are native `DRAFT-n` dependencies (`draft edit --dep`, `task edit --dep`), as 0012 describes. `DRAFT-n` numbers are reused once freed (fact 5), so the promotion and the rewrite of every reference to the old number run as **one item in the office git queue** (section 2a), and no other backlog write, in particular no draft creation, can run until its journal entry is closed. A Refined story with a `DRAFT-n` dependency fails R13, since a draft is not an active task.

`refine <id>` on a draft runs in lane b:

1. **Journal** in one database transaction: the StoryKey, the `DRAFT-n`, a hash of the draft's `draft view --plain` output, and the set of active task ids (pre-promote snapshot).
2. **Promote.** If the active ids already differ from the snapshot, promotion happened before a crash: go to step 3. Otherwise check that `DRAFT-n` still exists and its view hashes to the journaled value (refuse with a notice if not), then `backlog draft promote DRAFT-n`.
3. **Identify the new id**: the active ids minus the snapshot must be **exactly one** id, guaranteed by the serial queue. Zero or several new ids is an error with a notice; the engine never guesses (no title or content matching).
4. **Rewrite references**: in every draft and active task, replace the dependency `DRAFT-n` with the new id (`--dep` with the full list, fact 4).
5. Write `branch` (section 4) and `unknowns: []` if absent. Status is `Refined` via `default_status`.
6. Record `story.renumbered` (0005), map the StoryKey to the new id in the database, and close the journal entry.

After a crash the engine replays an open promotion entry before any other queue item.

### 6. Removed, completed, archived; status list and migration

- Drop runs `task archive` or `draft archive` (lane b). Archived tasks are not active and their ids are reused, so the engine tracks identity by StoryKey in its database. After a database loss, reconcile rebuilds identity from the frozen branch, then the created date (minute precision, a last resort), as 0005 describes. 0005's wording "StoryKey stored in the field block when present" no longer applies, because the key is never in the repository; 0005 needs a one-line amendment on acceptance.
- Tasks moved to `completed/` by hand are not active; a dependency on one fails R13 and the notice suggests moving it back.
- **Office init and the cutover migration** run as one backlog-only PR, each step target-state: (1) rewrite only the `statuses:` line of `backlog/config.yml` to include both old and 0012 statuses, check with `config get statuses`; (2) `config set defaultStatus Refined`; (3) every `To Do` task gets `task edit -s Refined`; tasks `In Progress` on their own branches are left alone and listed; (4) a later backlog PR, once no task uses `To Do`, sets the 0012 list. The previous values are stored in office state for removal.
- **Office checks at load:** `check_active_branches: true`, `remote_operations: true` and `auto_commit: false` (the engine makes its own commits). Office init sets any that differ through the backlog PR and records the previous values. With lanes a and b, other branches carry task edits, and `check_active_branches` makes Backlog.md skip ids already used there (fact 7). The skip only sees branches with commits within `active_branch_days` (default 30), and remote branches only with `remote_operations`; a story branch idle longer falls out of the window, so promotion also checks the new id against the engine's record of claimed and released branches and stops with a notice on a clash. The engine fetches before any create or promotion. Because 1.53's CLI reads only the local working copy, the flag no longer changes what the engine reads. At cutover this repository keeps its current setting; stories already in progress on their branches continue as lane-a stories once claimed by reconcile.

### 7. The git contract

| Item | Rule |
|---|---|
| Base, remote | `base` in `.dipo/office.yaml`; else `refs/remotes/origin/HEAD`; else `run` is refused. Remote `origin` unless configured |
| Branch | F15, frozen, one story one branch, never reused for another story (a branch released for the same StoryKey is reused, section 2a) |
| Worktree root | `worktree.root`, default `../<repo>.worktrees`; story worktree `<root>/<ID>`, backlog worktree `<root>/_backlog`, base read worktree `<root>/_base` (detached). The root must resolve outside the main checkout (0008); setup refuses otherwise. Tests set it to a temporary directory |
| Start point | `git fetch origin <base>`, then `origin/<base>` (local `<base>` without remote). Start SHA recorded |
| Claim | Exact local ref absent, `git ls-remote --heads origin <branch>` empty, no worktree at the path; then `git worktree add -b <branch> <path> <start>`, atomic (fact 8). A lost race is a skip. Then setup (section 8), the claim commit (lane a) and a push. A released branch is reused as in section 2a |
| Lock | `git worktree lock --reason "dipo <run-id>"` while the worktree exists; one git queue per office serialises refs, worktrees and pushes; the daemon PID lock (0006, one central database per 0007) keeps out a second engine |
| Who runs git | Only the engine (0014). The worker gets read-only git, no `backlog`, no `gh` |
| Verify and commit | When the worker reports done: scope check on every modified, staged and untracked path (`git status --porcelain=v1 -z --untracked-files=all`); a path outside declared scope and outside the story's own task file is `scope-violation`. Then verify on the worktree state. Green, in this order: stage exactly the code paths and commit them; record the verify result against a **code tree key**, the hash of `git ls-tree -r HEAD` without the story's own task file; then the CLI writes check-offs and `In Review`, committed alone as `<ID>: status In Review`. Red: feedback to the worker. Task-file-only commits keep the result; any other change to the code tree invalidates it |
| Conflict check | `git rev-parse --verify` both `origin/<base>` and the branch first; then `git merge-tree --write-tree`. Exit 0: clean. Exit 1 with stdout starting with a tree OID and conflict lines: conflict. Anything else: an error, not a conflict. Runs before In Review and on each fetch while In Review |
| Base sync | While building: not by default, only on a conflict or for a riskier story (open question 3). At merge time: always, by the engine, when the base requires up-to-date branches (this repository does, 0016): merge, push, wait for the required checks, merge when green; red CI returns the story for a fix round; merges run one at a time per office in the git queue. `git merge origin/<base>` into the branch by the engine, never a rebase or force push; conflicts go to the worker as feedback within caps, else park `conflict`. After a sync: reinstall if the lockfile changed, verify again before In Review |
| Push and PR | Engine pushes after the In Review commit, never force, never the base. The PR opens in M1. CI runs verify on the PR merge ref [8] |
| Merge and Done | Offices with linear history use squash merge. Done is detected from the host's PR state, or without it when `git merge-tree --write-tree origin/<base> <branch>` returns the tree of `origin/<base>` (the branch adds nothing new), never by ancestry |
| Teardown | After Done or drop: unlock, `git worktree remove <path>` without `--force`. Parked stories keep worktree and branch. The local branch is deleted (`-D`) only after Done is detected as above; then the engine also deletes the remote branch (`git push origin --delete <branch>`, open question 8). The host's auto-delete may already have removed it; a missing remote branch is fine |

**Failure cases.**

| Case | Detected by | Action |
|---|---|---|
| Ref belongs to this story and is running or parked | claim checks, office state | Skip silently as `notRunnable` |
| Ref released for this same StoryKey | office state | Reuse it (section 2a) |
| Ref tracked for a different StoryKey | claim checks, office state | Skip `collision` with a notice |
| Code conflict when a re-claim merges `origin/<base>` into a kept branch | `git merge` exit | Abort the merge; the worker gets the conflict as first feedback within caps, else park `conflict` with `park.from` In Progress |
| Ref unknown to the engine | claim checks | Skip `collision` with a notice (for example a stale ref of a reused id). Never delete a ref the engine did not create |
| Pending lane-b operation | journal | Skip `notRunnable`, notice "pending backlog PR" |
| Worktree path exists | claim check | Skip; notice; the directory is not touched |
| Lost race | `cannot lock ref` | Skip; nothing to clean (fact 8) |
| Fetch fails | exit code | Pickup and planning pushes wait (retryable); running work continues |
| Setup fails | exit code, timeout | Remove the worktree, delete the branch only if it still points at the start SHA, story stays Ready, skip `pickupCheckFailed` (0005) with the setup log as detail |
| `index.lock` or ref lock held | git error | Retry three times with backoff, then fail the step. Lock files are never deleted |
| Path outside scope | scope check | Park `scope-violation` |
| Verify red | exit code | Worker continues within caps, else park `verify-failing` |
| Conflict with base | merge-tree exit 1 | Sync as above |
| merge-tree or rev-parse error | anything else | Notice; story stays where it is |
| Push rejected | exit code | Non-fast-forward: park `conflict`. Auth or protection: notice. No force |
| Backlog PR conflicts or is rejected | host state, rebuild fails | Rebuild from the journal (section 2); operations that no longer apply are dropped with a notice |
| Dirty or locked worktree at teardown | `worktree remove` refusal | Keep everything; notice listing the files |
| Worktree or branch changed by hand | reconcile (`worktree list --porcelain`, recorded SHAs) | Notice; a running story parks. `worktree prune` only after confirmation. Git wins on facts (0001) |

### 8. Per-office worktree setup contract (research idea 7)

In `.dipo/office.yaml` (0017):

```yaml
worktree:
  root: "../{repo}.worktrees"
  files:
    - { path: ".env", mode: "copy", required: false }
    - { path: "apps/server/.dev.vars", mode: "copy", required: true }
    - { path: ".cache/fixtures", mode: "link" }
  ports: { stride: 10, named: { PORT: 5173, API_PORT: 8787 } }
  env: { VITE_HMR_PORT: "{port:24678}" }
  post_create: [["bun", "run", "db:seed"]]
```

After `git worktree add` and the lock, in order, with the run environment below and the 0013 timeouts:

1. **Files** from the main checkout. Each path is repo-relative and inside the repository. For a file, `git check-ignore -q` in the new worktree must say ignored; for a directory, every file under it is checked and the directory is refused if any is not ignored. A path git would track is refused, so a secret cannot be committed by accident. `copy` (default) copies with modes; `link` symlinks, meant for large read-only data. A missing source fails setup if `required`, else it is skipped with a notice. Contents are never read, hashed or logged (0013). With an empty list the engine proposes the real env files the 0013 scan found, for the maintainer to confirm.
2. **Install** from the run profile; again when the lockfile hash changes after a sync.
3. **`setup`** script from the run profile, if present.
4. **`post_create`** steps in order, as argument lists without a shell.

**Run environment** for every process the engine starts in a worktree (setup, verify, `dev`, the worker host of 0006): `DIPO_SLOT=<n>`, `DIPO_PORT_OFFSET=<n × stride>`, `DIPO_STORY=<ID>`, `DIPO_WORKTREE=<path>`; each `ports.named` entry as `NAME=<base + offset>`, or `PORT=<dev port from the run profile + offset>` when none are named; `env` entries with only `{slot}`, `{offset}`, `{port:N}`, `{id}`, `{worktree}` substituted, no shell expansion.

### 9. Port allocation

- **Slots are machine-wide**, because all offices share `localhost`: the daemon keeps one slot table in `<state>` (0006). The main checkout is slot 0; a worktree takes the lowest free slot from 1 to `maxSlots` (default 20) and frees it at teardown; parked worktrees keep theirs. The stride is per office, so two offices with different strides can still overlap.
- **The bind check is the guarantee.** Before `dev` or a test command starts, the engine binds each assigned port once. A busy port fails with `port.busy` naming the port. The engine never hunts for another port.
- A repository with dev ports fixed in code (0013) cannot use the offset: the office allows one running `dev` at a time and names the file to change.

### 10. Optional declared component map (research idea 18)

Optional `.dipo/components.yaml`:

```yaml
components:
  contract: { paths: ["packages/contract/**"] }
  engine:   { paths: ["packages/engine/**"], depends_on: ["contract"] }
```

- Validated on load and rescan: names `[a-z0-9-]+`, every `depends_on` exists, no cycles, each glob matches a tracked file (`git ls-files`) or warns. Globs use `Bun.Glob` behind the platform module.
- A scope path maps to each component whose globs match the path (new file) or a tracked file under it (directory).
- Scope check at refine (M3): scope mapping to no component warns; R11 and R12 stay the gate. Collision check at pickup (M2): prefix overlap (0012) or a shared component collides; touching a component an in-flight story's component depends on is reported, not blocked. No map: prefix overlap only. The context provider may use it.
- The engine never writes the map except a first draft on request (`dipo components init`, name per DIPO-2), only when none exists, for the maintainer to edit and commit.

### 11. Additive and removable (research idea 12)

| Written | Where | Removed by |
|---|---|---|
| `statuses`, `default_status` | `backlog/config.yml`, through a backlog PR | `office uninstall`: a backlog PR mapping Refined, Ready, Parked to To Do and In Review to In Progress, then restoring stored values |
| Reserved labels, `dipo` field block | stories | `office uninstall --strip-fields`, a backlog PR through the CLI |
| `.dipo/` files, component map draft | repository, created only if absent, never overwritten (0017) | deleting them |
| Worktrees, locks, copied and linked files | worktree root, `.git/worktrees` | teardown; `office uninstall` removes clean worktrees, lists the rest |
| Story and `dipo/backlog-*` branches | refs | deleted after merge (section 7); the rest kept and listed |
| Slot table, journal, office state | `<state>`, office state | `office forget`, deleting state |

No git hooks, no edits to existing `.gitignore` files or `info/exclude`, no git config changes. The one ignore file the engine adds is the new `.dipo/.gitignore` (0007), through the office-init backlog PR. Command names are placeholders until DIPO-2.

## Amends 0012 and 0002 (approved 2026-10-10)

### 0012

1. **Where transitions are written:** lane a while a claim is held (In Progress onward), lane b for the rest; Refined to Ready takes effect for `run` when its backlog PR merges, and any pending lane-b operation blocks pickup.
2. **Leaving a claim** (section 2a): `amend` of a parked story (Parked to Refined, branch kept, its task file restored to the merge-base version) and 0005's `work.discard` (branch deleted; this part depends on 0005 being accepted) are journaled first, release the claim, and are then written in lane b. A later claim on a kept branch merges `origin/<base>` first.

### 0002

3. **Auto-merge of backlog-only PRs** after the engine's structural check extends 0002's auto-merge rule (reviewer pass on unflagged stories) to a code-only check on PRs that change only `backlog/`.

## Consequences

- Every backlog change is a commit in a PR, so it survives re-clones, reaches a protected base and stays reviewable; the maintainer's main checkout is never touched.
- Planning has latency: Ready counts only after the backlog PR merges. Auto-merge of structurally checked backlog PRs keeps that short.
- The base shows a story's lifecycle only when its PR merges; in-flight state is in the engine's overview and on the story branch, visible in the Backlog.md browser through cross-branch reading.
- The engine depends on one Backlog.md minor at a time; a CLI upgrade is a deliberate change with new fixtures.
- Verify runs once per review round, so a failure is found later than with per-commit verify.
- M0 stories: CLI runner and parser with fixtures; field block schema, parser and writer; slug; promotion; backlog lane with journal and rebuild; office init and migration; worktree create, setup contract, teardown; slot table. M2: component map, collision check, push serialisation.

## Open questions for the maintainer

1. **Backlog PRs — answered 2026-10-10: auto-merged after the structural check** (one open backlog PR per office). Approved as an extension of 0002.
2. **Ready latency — answered 2026-10-10: accepted.** `run` only picks stories whose Ready transition is merged on the base; clients show "Ready, waiting for backlog PR" meanwhile.
3. **Riskier stories — answered 2026-10-10: tier `L` or flagged `test-before-merge`.** Such stories sync with the base before In Review even without a conflict; all others sync only on a conflict.
4. **Worktree root — answered 2026-10-10: `../<repo>.worktrees`**, next to the repository, configurable per office.
5. **Env files — answered 2026-10-10: copy** by default (agents can never change the maintainer's file; contents are never read by the engine or shown to the model, see 0008).
6. **Ports — answered 2026-10-10: stride 10, 20 slots** as defaults; repositories read `PORT` (required for `dev`, 0013) and optionally `DIPO_PORT_OFFSET`; the bind check is the guarantee.
7. **StoryKey in the repository — answered 2026-10-10: no.** The key lives only in the state database. Promotion identifies the new id from the journaled pre-promote snapshot; after a database loss identity is the frozen branch, then the created date.
8. **Branch deletion — answered 2026-10-10: delete** the story branch locally and remotely, and remove the worktree, after a detected merge.

## Sources

1. Backlog.md source, `src/core/cross-branch-tasks.ts`, `src/core/backlog.ts` (`taskResolutionStrategy` default `most_progressed`), and `groma/systems/backlog-md/containers/backlog-cli/components/cross-branch-loading.md`, main at v1.53.0, read 2026-10-10. https://github.com/MrLesk/Backlog.md
2. git-worktree(1). https://git-scm.com/docs/git-worktree ; git-update-ref(1). https://git-scm.com/docs/git-update-ref
3. git-merge-tree(1), `--write-tree` output and exit status. https://git-scm.com/docs/git-merge-tree
4. gitrepository-layout(5), `info/exclude`. https://git-scm.com/docs/gitrepository-layout
5. Bun docs, YAML. https://bun.com/docs/runtime/yaml
6. dipsaus-ai `skills/backlog-deliver/reference/parallel-delivery.md` and `git-contract.md`, local repository, inspiration only (0015).
7. Node.js docs, loading from `node_modules` folders. https://nodejs.org/api/modules.html#loading-from-node_modules-folders
8. GitHub Docs, `pull_request` event: `GITHUB_REF` is `refs/pull/<n>/merge`. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request
9. Research `docs/research/2026-10-comparable-tools.md`: agent-orchestrator `postCreate`, `symlinks`, `env` (section 1); codegraph nested-worktree issues (7.5); ideas 7, 12, 18.
10. Local experiments 2026-10-10 with Backlog.md 1.48.0 and 1.53.0 (installed in the scratchpad), git 2.50.1, Bun 1.3.5 (facts 1 to 11).

## Amendments

- 2026-10-10, decision 0008 (maintainer): setup step 1 also copies the main checkout's `.claude/settings.local.json` into the worktree when present, under the same rules as other copied files (it must be gitignored), and drops `permissions.allow`, `permissions.ask`, `permissions.additionalDirectories` and `permissions.defaultMode` from the copy. The worktree root must resolve outside the main checkout; setup refuses otherwise. The first time the engine copies env files for an office it shows the rule "worktree env files hold development secrets only" once as a notice and lists the files copied. Install (setup step 2, and reinstall after a sync) runs inside the sandbox runtime `srt` with the run's policy; if `srt` is unavailable the run refuses. The `park` field accepts 0008's new park reasons `needs-permission` and `worker-failed`.
- 2026-10-10, consistency with open question 8 (maintainer): the Teardown row now has the engine delete the remote branch after Done (`git push origin --delete <branch>`); a branch the host already removed is fine.
- 2026-10-10, decision 0007 (maintainer): one central state database; the daemon PID lock replaces the per-office lock as the guard against a second engine.
- 2026-10-10, decision 0007 (maintainer): office init adds a new `.dipo/.gitignore` with `office.local.yaml` through the office-init backlog PR; existing ignore files are still never edited.
- 2026-10-10, decision 0016 (maintainer): this repository's `main` requires branches to be up to date before merging (`strict` on, no merge queue), and CI runs on every push to `main`. Sync while the worker builds is unchanged. At merge time the engine always merges `origin/<base>` into the branch (never rebase or force), pushes, waits for CI and merges when green; a conflict goes to the worker as feedback like any conflict, red CI returns the story for a fix round, and merges run one at a time per office through the git queue. The Base sync row says so.
