# 0012 Story standard and the Ready gate

Status: accepted. First written 2026-10-10 (spike DIPO-8). Rewritten 2026-10-24 for the simplified design. The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Decision in short

A story has a fixed set of fields, stored natively in Backlog.md where possible and otherwise in labels and one `dipo` field block (0010). It moves through a fixed lifecycle. Before it runs it passes the **Ready gate**: rules over structured data that code evaluates with no model and no file contents, so the same story always gets the same answer. The gate checks structure and completeness, never quality. Quality is a judgment for refine, the maintainer and the reviewer.

## 1. Story fields

| # | Field | Meaning | Required for Ready | Stored as |
|---|---|---|---|---|
| F1 | Id | `DIPO-n`, stable from Refined on; a draft has `DRAFT-n` | Yes | Native id |
| F2 | Title | Short name | Yes | Native title |
| F3 | Story | Who wants what, and why, in plain words | Yes | One `Story:` line in the description; technical context goes below it |
| F4 | Acceptance criteria | Done-when statements, one checkable fact each | At least one | Native criteria |
| F5 | Type | `feature`, `bug`, `enhancement`, `task`, `chore`, `docs`, `spike` | Yes | Native type |
| F6 | Milestone | The milestone it belongs to (milestones replace epics) | Yes | Native milestone |
| F7 | Dependencies | Stories that must be Done before this one runs | Optional | Native dependencies |
| F8 | References | The planner's **forecast** of the files the story will touch. Used to schedule stories that probably won't collide, and as context. Not a write fence (0008) | At least one | Native references, paths only |
| F9 | Inputs | Files or URLs the worker reads but does not change | Optional | Native documentation |
| F10 | Unknowns | Questions to answer before Ready, each `open` or `resolved` with its answer | From Refined on; none `open` at Ready | Field block |
| F11 | Tier | `S`, `M` or `L`; chooses model and caps (0008) | Exactly one | Label `tier:<t>` |
| F12 | Role | The role that does the work, naming a role file of the office (0017); a story with no label has no role | Optional | Label `role:<name>` |
| F13 | Test before merge | The maintainer tests before merge (0002); set only by the maintainer | Optional | Label `test-before-merge` |
| F14 | Test plan | Automated entries (tests the worker writes) and manual entries (steps with an expected result), or "not applicable" with a reason | Every non-spike story; a manual entry when F13 is set | Field block |
| F15 | Branch | `<ID>/<slug>`, frozen when the story gets its id | Yes | Field block |
| F16 | Park record | Reason (0001), the state it left, a note | Only while Parked | Field block |
| F17 | Extra instructions | Text on top of the role's instructions (0014) | Optional | Native implementation plan |
| F18 | Priority, ordinal | Order inside the Ready queue | Optional | Native |

dipo itself writes the final summary at close (0020). Assignee, parent and subtasks, and definition of done are not used.

**The Story line** says who wants what and why. What makes the story done goes in the criteria, and technical context goes below the line. For example:

```
Story: As maintainer I want a parked story to show the command that resumes it so that I can unblock work without reading logs.
Story: We need to decide how stories that touch the same files are ordered so that parallel runs rarely end in a conflict.
```

## 2. Lifecycle

Drafts use Backlog.md's draft feature: an idea has a temporary `DRAFT-n` id until it is promoted at refine (M3), so dropped ideas never take a real id. The configured statuses are `Refined`, `Ready`, `In Progress`, `In Review`, `Parked` and `Done`, and new tasks start `Refined`, or `Ready` at the maintainer's planning confirm when the gate passes.

| From | To | Trigger | Who |
|---|---|---|---|
| (none) | Draft | A new idea, as a Backlog.md draft | Maintainer, with AI |
| (none) | Ready | At the maintainer's planning confirm (0022), with a passing decision for its content | Maintainer, decided by code |
| Draft | Refined | Promotion at refine: a real id and a frozen branch (M3; until then the maintainer creates stories as Refined) | Maintainer |
| Draft | Ready | At the maintainer's planning confirm (0022), with a passing decision for its content | Maintainer, decided by code |
| Refined | Ready | The Ready gate passes (section 3). At the maintainer's confirm in a planning session (0022) dipo gates the story as filed and files it Ready in the same backlog PR when it passes, Refined with the gate's messages when it fails: the lane's operation that files a new story, the new story of a split or a refined draft evaluates the gate on the task as filed, stores the decision for its content and sets the task Ready, read back with that content. `story.ready` stays for any Refined story on the base, from the Queue (`space` marks rows, `Y` sets them after one confirm) or `dipo ready <id>...`: only the maintainer's commands send it, never a worker, reviewer or planner (0008, 0022), and it refuses, with the reason, a story that is not Refined, whose filing PR has not merged, with an edit still open in the lane, or that fails the gate; a list with an unknown, archived or draft id changes nothing. The end-of-session confirm (`planning.ready`) keeps its own choice of stories, the ones the session filed or edited, and both call one function, which sets the stories that pass Ready in a backlog PR. Otherwise the maintainer sets the status in a backlog PR. CI runs the gate on every story a backlog PR sets Ready, on the light path for backlog-only PRs (0016); a PR that also changes code may not add a task at Ready or promote a draft to Ready | Maintainer, decided by code |
| Ready | Refined | A gated field changed and the re-gate failed, or the pickup check failed. A planning edit of a Ready story is gated again on its revised content in the operation that writes it, and stays Ready when it passes; an edit of a Refined or Parked story keeps its status | Engine |
| Ready | In Progress | `work.run` picks it: the pickup check passes, every dependency is Done | Engine |
| In Progress | In Review | The done report passed and the last part is pushed (0002) | Engine |
| In Review | In Progress | A fix round: a blocked review, red checks, a conflict, a reject or a failed test (0002). Red checks on a close-out head count too: the close-out's Done stands only on the story branch until the PR merges, so the fix round's commit sets In Progress over it | Engine |
| In Review | Done | The PR merged (0002) | GitHub, on dipo's request or the maintainer's merge |
| Refined, Ready, In Progress, In Review | Parked | A park reason from 0001; `by-maintainer` through `dipo park` | Engine or maintainer |
| Parked | The state it left | `dipo resume` (0020) | Maintainer, or code after a plan limit |
| Parked | Done | The story's PR merged while it was parked (0020). The story PR carried the park's status to the base, so dipo sets Done in a backlog PR once its claim is released. The backlog PR check, in dipo and in CI, accepts it only when the one Done check (0002) answers merged for the story PR whose merge commit is the last commit on the base that touched the task file, with the branch of the task's field block on the base. Any later commit that touched the task file refuses it | Engine, decided by code |
| In Progress, In Review, Parked | Refined | `dipo discard`: the work is thrown away (0020) | Maintainer |
| Draft, Refined, Ready, Parked | Removed | `dipo drop` archives the story; refused while an active story depends on it | Maintainer |

Every other transition is refused. Three more rules:

- **Done is terminal.** Rework is a new story.
- **No renumbering.** dipo never runs `task demote`, never sets the status `Draft`, and never runs `task complete` or `cleanup`.
- **Dependencies are not part of Ready.** A Ready story runs only once all its dependencies are Done.

## 3. The Ready gate

`dipo gate <id>` evaluates every rule and reports every failure, not only the first. The gate passes with zero failures.

- **Inputs:** the story, the other active tasks in the office's backlog (their id, status, dependencies and branch, read in one pass over the task files, 0010), and the office config (tier set, roster, banned phrases, contract size).
- **No model, no file contents.** The gate reads no repository files and calls no model.
- **Recorded.** Each result is stored as a gate decision keyed on the story's content hash.
- **Two modes.** The `ready` mode checks R01a. The pickup mode, which `work.run` runs before every claim, checks R01b. Both modes check R02 to R26 and R30; the pickup mode also checks R31.

| Rule | Check |
|---|---|
| R01a | (`ready`) The story is an active task with status `Refined` |
| R01b | (pickup) The story is an active task with status `Ready` |
| R02 | The field block parses and has no unknown fields |
| R03 | The story has no subtasks |
| R04 | Title of 1 to 100 characters |
| R05 | Exactly one `Story:` line of the shape `As <maintainer\|worker\|reviewer> I want <capability> so that <value>.`, or for a spike `We need to decide <question> so that <value>.` The role may read "a maintainer" or "the maintainer" and take a comma, and the closing full stop is optional. The capability or question, and the value, each have at least 20 characters. The line holds no backtick, no path (a word with two or more slashes, or one slash and a leading `/`, `~` or `./`, a trailing slash or a file extension), no URL, domain with a path, file name or dotfile, and no code: a call, braces, an operator, a tag, a shell variable, a flag, or a snake_case, camelCase or dotted camelCase name. A plain dotted name such as `github.com` or `node.js` is prose |
| R06 | Type is set and is a configured type |
| R07 | Milestone is set and exists |
| R08 | At least one criterion |
| R09 | Every criterion is unchecked and at least 10 characters |
| R10 | No criterion contains a banned phrase (office list; a word match, ignoring path tokens and code spans) |
| R11 | At least one reference |
| R12 | Every reference is a repo-relative POSIX path: no leading `/`, no `..`, no URL, no whitespace, no glob characters, not under `backlog/` |
| R13 | Every dependency is an active task other than the story itself |
| R14 | No dependency cycle through the story |
| R15 | The unknowns list exists, none is `open`, and every resolved one has an answer |
| R16 | Exactly one tier from the configured set |
| R17 | At most one role, naming a roster role |
| R18 | Branch matches `^<ID>/[a-z0-9]+(-[a-z0-9]+)*$` with a slug of at most 40 characters |
| R19 | No other active task has the same branch |
| R20 | A non-spike story has a test plan: entries each with a kind, a check of at least 10 characters and, for manual entries, an expected result; or `not_applicable` with a reason of at least 10 characters |
| R21 | A flagged story has at least one manual entry |
| R22 | A spike names its ADR (`docs/decisions/NNNN-name.md`) in a criterion and in its references |
| R23 | A spike has no test plan and no flag |
| R24 | A design story (M4) writes only under `docs/design/<ID>/` |
| R25 | An input under `docs/design/<X>/` has `<X>` as a dependency |
| R26 | The story contract (title, Story line, criteria, references, test plan, resolved unknowns, extra instructions) is at most `prompt.contractMax` characters (0014) |
| R30 | A story whose title or Story line names a security phrase (`story.securityPhrases`) has criteria for what the old barrier caught, the bypass forms to test and a fail-closed test against the real path (CLAUDE.md). Spikes are exempt |
| R31 | (pickup only) No reference names a path the box protects (`protectedKind`, the check the scope-violation park uses), except a link. A story for a builder or the maintainer may name such a path and stay Ready; the pickup refuses it before any claim |

Each failure prints `ready <ID> failed <rule>: <message>`. Rule numbers are stable once released, and new rules get new numbers.

**Warnings that never fail the gate.** An automated test-plan entry that names a path no reference covers (formerly R29) is shown in `dipo gate`, in the gate record and in the CI check. In the `ready` mode only, a story with more criteria or more references than its tier usually holds is shown in `dipo gate` and in the gate record, naming the tier, the count and the ceiling, so the maintainer raises the tier or splits the story before a run hits its caps. The ceilings are constants in code: tier S 5 criteria and 8 references, tier M 10 and 16, tier L 12 and 24. The pickup mode and the CI check, which runs it, do not show it.

**What the gate does not check.** Whether paths exist, whether the Story line describes one story, whether criteria are good, whether the size is right beyond the size warning, and whether a criterion names a step the worker cannot take. These are judgments for refine, the maintainer and the reviewer.

## 4. Spikes and design stories

- **A spike** (type `spike`) ends in an ADR in `docs/decisions/`, not in product code. It has the same fields and needs a tier. Its criteria name the ADR (R22) and usually include "the maintainer approved the decision", which only the maintainer ticks. It has no test plan and no flag (R23).
- **A design story** (from M4) has a non-code role from the roster. It writes only under `docs/design/<ID>/` (R24). Stories that build on it list it as a dependency and its folder as an input (R25).

## Replaced

- The Refined to Ready row's wait for an M3 `ready` command, with the maintainer setting the status in a backlog PR by hand (2026-10-24). Replaced by the planning session's final confirm (2026-11-06).
- The planning session's confirm as the only command that sets Refined stories Ready, for the stories that session filed or edited (2026-11-06). Widened by `story.ready`, the Queue's `Y` and `dipo ready` for any Refined story on the base (2026-11-10).
- Ready only in a second backlog PR after the PR that filed the story merged (2026-11-06). Replaced by filing a story Ready at the maintainer's planning confirm when the gate passes it as filed (2026-11-13).
- R27, which failed criteria that named a step the worker cannot take, matched by a phrase list (2026-10-18). Removed (2026-10-24): it is a judgment for refine and the reviewer, and a phrase list is a blunt way to make it.
- R28, which failed stories labelled `dropped` or `on-hold` (2026-10-20). Removed (2026-10-24): a set-aside story is Parked `by-maintainer`, and a dropped story is Removed (0020). There are no such labels.
- R29 as a hard rule (2026-10-20). Made a warning (2026-10-22), because references are a forecast.
- Story size left wholly to judgment, with no gate output on it (2026-10-24). Replaced by the size warning against the tier's ceilings (2026-11-08).
- References as a write fence with a scope check at done, scope requests and `needs-scope` (2026-10-10, 2026-10-16). Replaced by references as a forecast (2026-10-21).
- The park reasons `on-hold`, `stopped`, `interrupted` and `needs-permission`, and `hold` as its own transition. Replaced by the eight reasons of 0001 and `dipo park` (2026-10-24).
- `amend` of a parked story (Parked to Refined with criteria unchecked). That is M3 work (0003).
- Merge-time sync conflicts and red checks counted against the review round cap (2026-10-10). Replaced by one cap per source (0002, 2026-10-16).
- The In Review to In Progress row without the close-out head (2026-10-24), when a story closed out only after green checks on its reviewed head. Replaced by the row's note on red checks of a close-out head, since a story decided by rule now closes out before its checks run (0002, 2026-10-30).
- Parked left only by a resume, a discard or a drop (2026-10-24), so a story whose PR merged while it was parked stayed Parked on the base. Replaced by the Parked to Done row for a story whose PR merged (2026-11-09).
- The `Outcome:` line, the one result a story delivers (2026-10-10). Replaced by the `Story:` line (2026-11-03), so every story says whom it serves and why.
