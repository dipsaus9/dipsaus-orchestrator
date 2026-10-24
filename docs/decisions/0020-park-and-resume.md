# 0020 Park, resume and the maintainer's desk

Status: accepted. First written 2026-10-17 (spike DIPO-132). Rewritten 2026-10-24 for the simplified design: one waiting state, one resume path, no causes, no scope requests.

## Decision in short

A story that cannot go on is **Parked** with one of the eight reasons in 0001. Parked is the only waiting state. `dipo resume` is the only way back, apart from one resume code does by itself after a plan limit (section 6), and every resume works the same way. The maintainer's other actions on a story are `park`, `drop`, `discard`, `steer` and `answer`. Everything that waits on the maintainer is one ordered list, the desk.

## How a run ends

A run ends in one of three ways, and every other word for an ending is a detail:

- `done`: its story is Done, merged by dipo or by hand, or finished outside dipo (section 7);
- `parked`, with one of the eight reasons;
- `dropped`: its story was dropped or discarded (section 5).

A parked run reopens on resume. The run's outcome row keeps what retro needs (0007).

## 1. Parking

- **What a park writes.** dipo sets the story's status to `Parked` with the reason and a one-line detail, through the Backlog CLI on the story branch, and pushes it. Backlog.md owns this fact (0001). One transaction then ends the run, records the park detail on the run and emits `story.parked`.
- **The detail is text.** A park has a reason and a one-line detail, such as "turn cap 61 of 60" or "conflict in packages/engine/src/run/park.ts". There is no cause vocabulary, and code never decides anything from the detail.
- **The box stays.** A parked story keeps its branch and its box. dipo stops the box while the story waits and starts it again on resume (0008).
- **The structured summary.** In the same commit, dipo appends one block to the task's implementation notes, built from stored facts: date, reason, detail, criteria met of total, loops of cap, review rounds, budget used of limit, and the last pushed commit.
- **By the maintainer.** `dipo park <id> --note <why>` parks any story that is Refined, Ready, In Progress or In Review, with reason `by-maintainer`. A running worker is stopped first. A story with no run is parked through the backlog lane (0010). This replaces the former stop, hold and pause.

## 2. One resume path

`dipo resume <id> [--note <text>] [--budget +<n>% | +<tokens>]`:

1. **Check, without writing anything.** The story is Parked. What its reason requires is present (the table below). Nothing of its run is still alive. The office does not have starts paused (section 6).
2. **Lift the park.** dipo sets the status back to the one the story had before, on the story branch, and appends one line to the implementation notes: date, resumed, grants, and the first line of the note.
3. **One transaction.** The park is resolved with the note, grants are recorded (section 3), the run is reopened and the open question is closed.
4. **Next session.** A new developer session of the same run starts in the story's box, with a handoff (0014). Its first message is the reason's feedback, then the note. A story parked with no run (from Refined or Ready) only gets its status back; the next `dipo run` picks it up through the pickup check (0012).

| Reason | Resume requires | First message |
|---|---|---|
| `ambiguous-spec` | `--note` with the answer, or `dipo answer <question> --text` | The question and the answer |
| `review-blocked` | `--note` with a direction. Or `dipo approve <id> --note` overrides the verdict (0002) | The blocking findings, then the note |
| `budget-exceeded` | `--budget` and `--note` | "The maintainer raised your budget by n", then the note |
| `verify-failing` | Nothing; note optional | The last red check or verify output, then the note |
| `conflict` | Nothing; note optional | The conflicting paths, then the note |
| `scope-violation` | Not resumable. A part that touched a protected file or held a secret means the box can no longer be trusted, so the way on is `dipo discard` and a new run (0008) | None |
| `by-maintainer` | Nothing; note optional | "Resumed by the maintainer", then the note |
| `worker-failed` | Nothing; note optional | The last error, then the note |

A resume of a story whose reviewer was the one that stopped (budget or a failed reviewer session) starts a fresh review of the same head instead of a developer session (0002).

## 3. Caps and grants

- **Caps are fixed at run start.** Tokens, turns, minutes, loops, review rounds, CI attempts and conflict attempts come from the tier when the run starts and are stored on the run. A tier edit affects new runs only.
- **A grant is the only way a cap grows.** There are two kinds:
  - `budget`: the `--budget` top-up. It grows tokens, turns and minutes by the same share of the run's starting caps, because the cap that fires is often the turn cap, not the token cap. A top-up too small to clear the cap that fired is refused, with the smallest share that would.
  - `round`: one more round of the cap that fired (loops, review rounds, CI attempts or conflict attempts). A resume of a story parked on such a cap adds it.
- **Every grant is a recorded fact** with the note, the maintainer, the time and the caps before and after. Nothing grows by itself: no per-round allowance, no implicit share.
- **The reviewer has its own caps** (0002), separate from the story's, so a review never eats into the developer's budget.

## 4. Questions

- A worker that needs a decision reports `blocked` with a question. dipo stores it as a question on the run and emits `question.asked`.
- **Now:** the story parks `ambiguous-spec` at once. The orchestrating Claude session that builds dipo, or the maintainer, answers with `dipo answer <question> --text <answer>`, which resumes the story.
- **Later** (0003): while the maintainer has declared themselves online, the worker waits a fixed time on stdin for the answer before it parks. Presence is a fact the maintainer sets, never the presence of a TUI.
- **An answer is a story fact.** dipo writes it into the story as a resolved unknown, in the resume commit, so every later session sees it (0014).
- An answer always goes through `--text`, so an answer that happens to read "allow" is never taken as a decision.

## 5. Drop, discard and steer

| Command | From | What it does |
|---|---|---|
| `dipo drop <id> [--delete-branch]` | Draft, Refined, Ready, Parked | Archives the story as Removed through the backlog lane, closes its PR with a comment, and deletes its box. The branch is kept unless `--delete-branch` is given. Refused while another live story depends on it |
| `dipo discard <id> --note <why>` | In Progress, In Review, Parked, or the leftovers of a story Done elsewhere | Shows what is lost (commits not on the base), then stops the worker, closes the PR, deletes the box and the branch, and moves the story back to Refined, so it must pass the Ready gate again |
| `dipo steer <id> <text>` | In Progress, Parked | Sends the text to the developer through the one feedback path (0002). A steer to a parked story is stored and sent on resume. A steer is never sent to the reviewer |

- **Remote branches.** dipo deletes a remote branch only when its tip is one dipo pushed, and pushes the delete with a lease on that tip. Any other tip is kept and named.
- **Confirmation.** `discard`, and `drop --delete-branch`, ask for the typed story id after showing the loss.
- **Maintainer text.** Every text the maintainer sends a worker (note, answer, steer) goes in a template and never starts a message, so it can never begin with `/`.

## 6. Starts paused

Some problems belong to the office, not to a story: the subscription's plan limit, or a broken Claude CLI or box token. For these the office has one state, **starts paused**, with a reason and, when known, a time. While it holds, no new session starts in that office. The desk shows it with what lifts it. It lifts by itself when its condition clears (the reset time passes, the check passes again), or with `dipo daemon resume-scheduling`.

A session already running when the plan limit hits ends, and its story parks `worker-failed` with the detail "plan limit until <time>". When the office's starts paused lifts, dipo resumes exactly those parks by itself. This is the one resume that needs no command: no cap grows, nobody has to decide anything, and code knows both the cause and the time. That way overnight work continues after the reset.

## 7. A story finished outside dipo

A story can reach Done without dipo, for example when it was finished by hand on another branch. The one Done check (0002) also covers this case. When the story's status on the base is `Done` while dipo holds a claim on it, dipo:

1. Releases the claim and ends the run. An open park is resolved as `done-elsewhere`. A live worker is not stopped; the desk shows it, and the release happens at the run's next end.
2. Closes dipo's open PR with a comment naming the base commit.
3. Deletes the box, and deletes the branch when it adds nothing to the base.
4. Keeps a branch with commits not on the base as a desk item, "leftovers". `dipo discard` removes them after showing the loss. Leftovers are never deleted by themselves.

## 8. Proposals

A worker may add up to three proposals to any report: a follow-up, a spike or a tool it would need. A proposal is never done in place. dipo stores it with an id made from a hash of its title and paths, and shows it on the desk. `dipo propose accept <id>` files it as a Backlog draft through the backlog lane, with the worker's words marked as the worker's. `dipo propose dismiss <id>` closes it. Nothing is filed without the maintainer's accept.

## 9. The desk

`office.desk` is an engine read that returns the items in order, each with the exact command to type, built by code. `dipo desk [--json]` prints it as plain text, and the TUI's desk shows the same read.

Order, by what unblocks work soonest:

1. Starts paused, with its reason and what lifts it.
2. Open questions.
3. Merge gates waiting for the maintainer (0002), with the PR link and the reason, plus `dipo approve` and `dipo reject` (or "merge by hand on GitHub" for a release-path PR).
4. Parked stories: `ambiguous-spec`, then `review-blocked` (one row with both `dipo resume --note` and `dipo approve --note`), `budget-exceeded`, `verify-failing`, `conflict`, `scope-violation`, `worker-failed`, and last `by-maintainer`, listed apart as "Parked by you".
5. Hand actions: leftovers, a backlog PR that failed its check, and a PR whose head changed outside dipo.
6. Proposals, spikes before follow-ups.

Within a group, items that block the most other stories come first, then the oldest.

## Replaced

- Parks with 11 reasons and 28 causes, and a resume matrix of about 25 rows. Replaced by 8 reasons, a text detail and one resume table (2026-10-24).
- `on-hold`, `pause` and `stop` as separate mechanisms with their own resume paths, plus an `on-hold` label. Replaced by `dipo park` with reason `by-maintainer` (2026-10-24).
- The plan-limit hold and the adapter hold. Replaced by the office's starts paused (2026-10-24).
- Seven grant kinds and a per-round review allowance that grew the story's budget. Replaced by two grant kinds and a separate reviewer budget (2026-10-24).
- An implicit +50% top-up on a capped verify. Replaced by: every top-up is a `--budget` command (2026-10-24).
- Native `--resume` versus handoff, chosen by a cost check. Replaced by: a resume always starts a new session in the box with a handoff (2026-10-22, box runs).
- Scope requests, `needs-scope`, the package-of-a-path rule and restricted paths (2026-10-16). Removed when the box made references a forecast (2026-10-21).
- `needs-permission` and its allow-or-deny answers. A box worker has every permission (2026-10-22).
- The web-value gate on the developer's web calls and the domain allowlist idea. The box has open web access and holds no real secrets (2026-10-21). No session has a web gate: the reviewer box holds no secrets either (0008, 2026-10-24).
- A question wait that depended on a TUI being connected (2026-10-21). Replaced by section 4.
- The waiting command path with a crash-injection test per command. Idempotency is limited to commands that start or change a run (0005).
