# 0012 Story standard and the Ready gate

Status: Proposed (DIPO-8, 2026-10-09). Needs the maintainer's approval.

## Context

Decision 0001 makes `ready <id>` a hard gate that uses no model, and the engine refuses to run a story that is not Ready. Decision 0002 adds the test-before-merge flag and the manual test script. Decision 0011 adds tiers, roles and design stories. This ADR fixes what a story contains, where each field lives in Backlog.md, the lifecycle, and the exact rules the gate evaluates.

The dipsaus-ai story standard was the starting point. Several of its rules were prose a model had to interpret: "one outcome", "concrete title", "never vague criteria", "pickup-sized", "no unresolved open questions in notes", and the `needs-info` / `needs-refinement` labels. Here each one either becomes a rule over structured data or is left to refine (AI plus maintainer) and is not part of the gate.

Facts about Backlog.md CLI 1.48 that shape this decision (checked in a scratch project):

- Native task fields: title, description, status, type (configured list, includes `spike`), priority, labels (free-form), milestone, dependencies, references, documentation, acceptance criteria (checkable), definition of done (checkable, with config defaults), implementation plan, implementation notes, comments, final summary, modified files, parent, ordinal, assignee.
- Statuses are a free list in `backlog/config.yml` (edited in the file, `backlog config set statuses` refuses). The CLI rejects a status not in the list.
- Drafts are a separate feature, not a status. A draft gets a `DRAFT-n` id and lives in `backlog/drafts/`. `draft promote` gives it a new `DIPO-n` id, and `task demote` turns `DIPO-n` back into a new `DRAFT-n`. Ids are not stable across the draft boundary, and a freed `DIPO-n` number is reused by the next created task.
- The status name `Draft` is reserved. `--status Draft` on create or edit always moves the task into drafts with a new id, even when `Draft` is in the configured status list. Any other name (for example `Drafted`) behaves as a normal status.
- `--dep` accepts a `DRAFT-n` id, which then dangles after promotion.
- `task complete` moves a Done task to `backlog/completed/`. After that `task view` does not find it and `--dep` on it is rejected.
- There is no `--json` output. The engine parses `--plain` output (DIPO-7 owns parsing).

## Decision

### 1. Story fields

"Required" means required for the Ready gate unless stated otherwise. Storage marked **DIPO-7** is not native; the suggestion here is input for DIPO-7, which owns the final convention.

| # | Field | Meaning | Required | Storage |
|---|---|---|---|---|
| F1 | Id | Native id, `DIPO-n`. Stable from creation under option B, from Refined under option A (section 2) | Yes | Native id |
| F2 | Title | Short name of the story | Yes | Native title |
| F3 | Outcome | The one result the story delivers, in plain sentences | Yes | Native description (the text outside the field block, see F10) |
| F4 | Acceptance criteria | Done-when list, one checkable statement each. Workers check them off | Yes, at least one | Native acceptance criteria |
| F5 | Type | `feature`, `bug`, `enhancement`, `task`, `chore`, `docs`, `spike` | Yes | Native type |
| F6 | Milestone | The milestone the story belongs to (milestones replace epics) | Yes | Native milestone |
| F7 | Dependencies | Stories that must be Done before this one runs | Optional | Native dependencies |
| F8 | Declared scope | Repo-relative paths the story may write. Input to the collision check | Yes, at least one | Native references, paths only. URLs and read-only inputs go in F9 |
| F9 | Inputs | Files or URLs the worker should read but not write, for example a design story's output | Optional | Native documentation |
| F10 | Open unknowns | Questions that must be answered before the story is Ready. Each is `open` or `resolved`; a resolved one carries its answer | Field required from Refined on (may be an empty list). Zero `open` at Ready | **DIPO-7.** Suggest a list in one structured field block in the description, for example a fenced ` ```dipo ` YAML block with key `unknowns: [{q, status, answer}]` |
| F11 | Difficulty tier | `S`, `M` or `L` (the set comes from office config). Chooses model, budget and loop cap | Yes | **DIPO-7.** Suggest label `tier:S`, `tier:M`, `tier:L`: native, and filterable with `task list -l tier:M` |
| F12 | Role | Roster role that does the work. Until M4 the only role is the built-in `developer` | Optional. Absent means `developer` | **DIPO-7.** Suggest label `role:<name>` |
| F13 | Test-before-merge flag | The maintainer tests the branch before merge (0002). Set only by the maintainer, never by refine | Optional, default off | **DIPO-7.** Suggest label `test-before-merge` |
| F14 | Manual test script | Numbered steps, each with an action and an expected result | Required when F13 is set. Recommended for every non-spike story | **DIPO-7.** Suggest key `test_script: [{do, expect}]` in the field block |
| F15 | Branch | `<ID>/<slug>`, frozen when the story gets its id so a later title change cannot move it | Yes | **DIPO-7.** Suggest key `branch` in the field block. DIPO-7 owns the slug algorithm |
| F16 | Park record | Why and from where a story is parked: reason (0001 list), state it left, note | Only while Parked | **DIPO-7.** Suggest key `park: {reason, from, note}` in the field block |
| F17 | Extra instructions | Text added on top of the role's instructions (0011) | Optional | Native implementation plan. DIPO-10 decides how it enters the prompt |
| F18 | Priority, ordinal | Order inside the Ready queue | Optional | Native priority and ordinal |

Not used by the engine: assignee (the claim is the branch ref, DIPO-7), parent and subtasks (milestones replace epics), definition of done (office defaults may exist, the gate ignores them), modified files and final summary (written by the engine on close, not inputs).

The non-native fields split in two groups. Enumerations and booleans (tier, role, flag) suit labels because the CLI filters on them. Structured or multi-line data (unknowns, test script, branch, park record) needs one block that code parses. Keeping them in one block in the description means a single parser and a single write path through `task edit --description`.

### 2. Lifecycle

**Where Draft lives is open (question 1).** Two options:

- **Option A, Backlog.md draft feature.** A draft has a `DRAFT-n` id until `refine` promotes it. Promotion must rewrite every other story's `DRAFT-n` dependency to the new `DIPO-n` id, and branch naming moves from `plan` to `refine`. That amends 0001 and the vision, where `plan` assigns ids, branches and dependencies. A multi-story plan has no stable dependency graph until every story is promoted.
- **Option B, a regular status `Drafted`.** `plan` creates normal tasks, so ids, dependencies and branches are stable from the start, as 0001 says. The name cannot be `Draft`, because the CLI reserves it (see Context). Cost: abandoned ideas consume ids (they are archived, not deleted), and the Backlog.md drafts view is unused.

**Recommendation: option B.** It keeps 0001 intact and removes the id rewrite, the most fragile step in option A. The tables below assume B. Under A, the Draft row maps to the draft feature and Draft to Refined runs `draft promote` plus the dependency rewrite.

States and their Backlog.md mapping. Office init sets `statuses: ["Drafted", "Refined", "Ready", "In Progress", "In Review", "Parked", "Done"]` and `default_status: "Drafted"`. Existing `To Do` tasks migrate to `Refined` (DIPO-7 owns the migration).

| State | Backlog.md | Meaning |
|---|---|---|
| Draft | Status `Drafted` (option B) | An idea being shaped. Has an id and branch, but fields may be missing |
| Refined | Status `Refined` | Title and outcome present, unknowns list exists. Other fields being completed. Unknowns may be open |
| Ready | Status `Ready` | Passed the gate. Eligible for `run` |
| In Progress | Status `In Progress` | Claimed by a worker (the machine claim is the branch ref, DIPO-7) |
| In Review | Status `In Review` | PR open. Reviewer, and the maintainer if flagged |
| Parked | Status `Parked` plus park record (F16) | Needs a human. Other work continues |
| Done | Status `Done` | Merged. Terminal |

Transitions. Anything not listed is refused by the engine.

| From | To | Trigger | Who |
|---|---|---|---|
| (none) | Draft | `plan` or a new-story command. Code runs `backlog task create -s Drafted`, then writes the branch (F15) once the id exists | Maintainer, content drafted with AI |
| Draft | Refined | `refine <id>`: code writes an empty unknowns list if absent. Needs R04 and R05 to pass | Maintainer command |
| Draft | (archived) | Drop: `backlog task archive`. Refused while another active story depends on it | Maintainer |
| Refined | Ready | `ready <id>`: rules R01a and R02 to R25 pass | Maintainer command, decided by code only |
| Ready | Refined | Any edit to a gated field through the engine, a failed pickup re-check in `run`, or `unready <id>` | Engine automatically, or maintainer |
| Ready | In Progress | `run` selects it. Code runs the pickup re-check (R01b and R02 to R25), then checks every dependency is Done and no scope collision with in-flight work (M2) | Engine |
| In Progress | In Review | Worker reports done, verify is green, PR is opened | Engine |
| In Review | In Progress | Reviewer blocking finding under the round cap, or maintainer test fail with a note | Engine |
| In Review | Done | Reviewer pass and, if flagged, maintainer test pass; then merge (0002) | Engine, merge authority stays with the maintainer |
| In Progress, In Review | Parked | A park reason from 0001 (`ambiguous-spec`, `verify-failing`, `conflict`, `scope-violation`, `review-blocked`, `budget-exceeded`) | Engine |
| Parked | In Progress or In Review | `resume <id>` after the maintainer answers; returns to `park.from` | Maintainer |
| Parked | Refined | `amend <id>`: the story itself must change. Code unchecks every criterion, then the story must pass the gate again | Maintainer |
| Refined, Ready, Parked | (archived) | Drop: `backlog task archive`. Refused while another active story depends on it | Maintainer |

Rules around the lifecycle:

- The engine never runs `backlog task demote` or sets status `Draft`. Both renumber the id, which breaks dependencies and the frozen branch.
- Refined to Draft is refused. A story that needs rework stays Refined.
- Amend unchecks all criteria because the story changed: earlier check-offs were made against the old criteria and cannot be trusted. Work already on the branch stays, and the next worker checks criteria off again. The reviewer judges the diff, not the checkboxes, so nothing is lost. This keeps R09 a single rule with no exception for parked stories.
- Done is terminal. Rework is a new story.
- The engine never runs `backlog task complete` or `backlog cleanup` on an office. They move Done tasks where dependencies no longer resolve. (Flag for DIPO-7.)
- `run` does not trust the `Ready` status alone. A hand edit can break a Ready story, so the pickup re-check runs the gate again with R01b in place of R01a. A failure there moves the story back to Refined with the gate output.
- Dependencies are not part of Ready. A story can be Ready while its dependencies are still in progress. Run eligibility is Ready plus all dependencies Done.

### 3. The Ready gate

`ready <id>` evaluates the rules below and reports every failure, not only the first. It passes only with zero failures. Inputs are the story, the other tasks in the office backlog (via the CLI), and office config (tier set, roster, banned phrases). It reads no file contents and calls no model, so the same inputs always give the same result. The result is stored as a gate decision in the local database (DIPO-4), and on pass code sets status `Ready` via `backlog task edit`.

The gate runs in two modes. The `ready` command evaluates R01a and R02 to R25. The pickup re-check in `run` evaluates R01b and R02 to R25. Rules are written over logical fields; how a field is stored (label, field block) is DIPO-7's choice and does not change the rule.

Definitions used by the rules:

- **Active task:** any task returned by `backlog task list --plain`, in any status. Drafts in `backlog/drafts/` (option A), archived and completed tasks are not active.
- **Character:** a Unicode code point after NFC normalisation. Text is trimmed of leading and trailing whitespace before counting.
- **Word match:** a case-insensitive match whose start and end are each the text start, the text end, or a character that is not a Unicode letter or number (outside `\p{L}\p{N}`).

Each message is prefixed with `ready <ID> failed <rule>:`. `<…>` is filled by code.

| Rule | Check | Failure message |
|---|---|---|
| R01a | (`ready` mode) Story is an active task with status `Refined` | `status is <status>; only Refined stories can be made Ready` |
| R01b | (pickup mode) Story is an active task with status `Ready` | `status is <status>; only Ready stories can be picked up` |
| R02 | The structured field data stored in the parsed field block (under the current suggestion F10, F14, F15, F16) parses and has no unknown fields. Fields stored as labels are validated only by their own rules (R16, R17, R21) | `structured fields are invalid: <parser error>` |
| R03 | Story has no subtasks (`task list -p <ID>` is empty) | `story has subtasks <ids>; milestones group work, subtasks are not used` |
| R04 | Title, trimmed, is 1 to 100 characters | `title is empty or longer than 100 characters` |
| R05 | Outcome (F3) is at least 20 characters | `outcome is missing or shorter than 20 characters` |
| R06 | Type is set and is in the configured type list | `type is missing or not one of <types>` |
| R07 | Milestone is set and exists | `milestone is missing or does not exist` |
| R08 | At least one acceptance criterion | `no acceptance criteria; add at least one with --ac` |
| R09 | Every criterion is unchecked and at least 10 characters | `criterion #<n> is checked or shorter than 10 characters` |
| R10 | No criterion contains a banned phrase (word match, so `etc` does not match `fetch`; office config, default: `works well`, `looks good`, `properly`, `as expected`, `etc`, `and so on`, `if possible`, `should be fine`) | `criterion #<n> contains vague phrase "<phrase>"` |
| R11 | At least one scope path (reference) | `no declared scope; add at least one path with --ref` |
| R12 | Every scope path is repo-relative POSIX: no leading `/`, no `..` segment, no `://`, no whitespace, no glob characters `* ? [ ]`, not `.` or empty, not under `backlog/` | `scope path "<path>" is not a valid repo-relative path` |
| R13 | Every dependency is the id of an active task other than the story itself | `dependency <dep> is not an active task` |
| R14 | The dependency graph through this story has no cycle | `dependency cycle: <ID> -> … -> <ID>` |
| R15 | Unknowns list exists, has zero `open` entries, and every `resolved` entry has a non-empty answer | `<n> unknowns open or resolved without an answer: <first question>…` |
| R16 | Exactly one tier, from the configured tier set | `needs exactly one tier from <tiers>, found <values>` |
| R17 | At most one role, naming a roster role (until M4: `developer`) | `role <role> is not in the roster` |
| R18 | Branch is set, matches `^<ID>/[a-z0-9]+(-[a-z0-9]+)*$`, `<ID>` equals the story's id, slug at most 40 characters | `branch "<branch>" must be <ID>/<slug> with a lowercase hyphenated slug` |
| R19 | No other active task has the same branch | `branch "<branch>" is already used by <other-id>` |
| R20 | If a test script exists: at least one step, every step has a non-empty action and a non-empty expected result | `test script step <n> is missing its action or expected result` |
| R21 | If the test-before-merge flag is set: a test script exists (0002) | `flagged test-before-merge but has no manual test script` |
| R22 | Spike (type `spike`): at least one criterion contains a match of `docs/decisions/[0-9]{4}-[a-z0-9-]+\.md`, and scope covers that path. A scope path covers it when it equals the path or ends in `/` and is a prefix of it | `spike must name its ADR (docs/decisions/NNNN-name.md) in a criterion and cover it in scope` |
| R23 | Spike: the test-before-merge flag is not set | `spike cannot be flagged test-before-merge; it ships no behavior` |
| R24 | Design story (role kind non-code, M4): every scope path is under `docs/design/<ID>/` and that directory is in scope | `design story scope must be docs/design/<ID>/ only` |
| R25 | Every input (documentation) path under `docs/design/<X>/` has `<X>` in dependencies | `input docs/design/<X>/ needs <X> as a dependency` |

Rule numbers are stable once released, because messages and the local database refer to them. New rules get new numbers.

What the gate deliberately does not check: whether paths exist (new files do not exist yet), whether the outcome is a single outcome, whether criteria are good, whether the size is right. Those are judgments made at refine time by the AI and the maintainer. The gate guarantees structure and completeness, not quality.

### 4. Spike stories

- Type `spike`. Output is an ADR in `docs/decisions/`, not product code (concepts.md).
- Same fields as any story. Tier is required, because spikes cost model time too. Role is `developer` until research roles exist.
- Acceptance criteria name the ADR path (R22), and usually include "Maintainer approved the decision". That criterion is checked by the maintainer, never by a worker. The reviewer treats it as not applicable.
- No test script and no flag (R23).
- Unlike dipsaus-ai, a spike needs no written justification. This project uses spikes on purpose for architecture decisions.

### 5. Design stories (from M4)

- A design story is a story whose role is a non-code role in the roster (for example UX designer). The roster definition, not the story, says a role is non-code.
- It writes only under `docs/design/<ID>/` (R24), for example flows, specs, and SVG or HTML mockups, on its own branch, reviewed against its own criteria, merged like code.
- Stories that build on it list it in dependencies and list `docs/design/<ID>/` as an input (F9, R25). Code knows the order without a model.
- Design files go in inputs (F9, documentation), not in scope (F8). Scope is what a story writes and feeds the collision check; listing a read-only design folder there would make every consumer collide with every other. This deviates from vision.md section 4, which says consumers "reference those files in their scope". The vision should be updated to say "inputs" when this ADR is accepted.
- The test-before-merge flag is allowed. The test script then lists what the maintainer opens and what it should show.
- Before M4 no non-code role exists, so R17 rejects any design story.

## Consequences

- Readiness becomes a pure function of the story, the backlog and office config. Code can evaluate it, the TUI can show each failed rule, and retro can count failures per rule.
- Office init must change `backlog/config.yml` statuses. This repo's own backlog (`To Do`) needs a one-time migration when the orchestrator takes over (cutover).
- Every story that reaches Refined carries structured field data. If DIPO-7 picks a block in the description, hand-written stories (until M3) must include it, so the format must stay readable and simple to type.
- Under option B every idea gets a `DIPO-n` id at `plan` time and dropped ideas stay in the archive. Under option A, drafts cannot be depended on until promotion rewrites their ids.
- Stories never go back to Draft once they have an id that others may reference.
- Under option B the lifecycle state `Draft` from decision 0001 appears on the board as status `Drafted`, because Backlog.md reserves the name `Draft` for its draft feature.
- Done tasks stay in `backlog/tasks/` forever unless the office later handles `completed/` in dependency resolution. The board grows over time.
- Backlog.md tools (board, browser) show the new statuses and labels with no plugin. They show the field block as raw text.
- The banned-phrase list is a blunt tool. It catches the common vague phrases and nothing more. It is office config so it can be tuned.

## Deferred to DIPO-7

- Final storage of F10, F11, F12, F13, F14, F15 and F16 (suggestions above), and the field block format and parser.
- The slug algorithm for F15.
- Parsing `--plain` output, since the CLI has no JSON.
- Migration from `To Do` to `Refined` and writing the office status list (including `Drafted` under option B).
- Under option A: rewriting `DRAFT-n` dependencies on promotion.
- How `completed/` and archived tasks are treated, and confirming the engine never runs `task complete`.
- Scope collision check (prefix overlap) at pickup, used by `run` (M2).

## Open questions for the maintainer

1. Draft storage: option A (Backlog.md draft feature, ids assigned at `refine`, amends 0001) or option B (status `Drafted`, ids, dependencies and branches stable from `plan`)? Recommendation: B. See section 2.
2. Should the maintainer be able to park a Ready or Refined story by hand? That needs a new park reason such as `on-hold`. This ADR allows parking only from In Progress and In Review.
3. Is tier required for every story from M0, or only from M1 when tiers take effect? This ADR requires it from the start so stories do not need a second pass.
4. Should the outcome be an `Outcome:` line, as the current DIPO tasks use, or the whole description outside the field block? This ADR takes the latter.
5. Thresholds (title at most 100, outcome at least 20, criterion at least 10, slug at most 40) and the default banned phrases: accept as defaults, or change?
6. Should a manual test script be required for every non-spike story, not only flagged ones? 0002 says every story that may be tested carries one. This ADR requires it only when flagged and recommends it otherwise.
7. Should a new Backlog.md type `design` mark design stories, instead of the role's kind?
