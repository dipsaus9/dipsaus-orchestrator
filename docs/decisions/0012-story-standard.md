# 0012 Story standard and the Ready gate

Status: Accepted (maintainer, 2026-10-10). Proposed in spike DIPO-8, 2026-10-09.

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
| F1 | Id | Native id, `DIPO-n`, stable from Refined on. A draft has a temporary `DRAFT-n` id (section 2) | Yes | Native id |
| F2 | Title | Short name of the story | Yes | Native title |
| F3 | Outcome | The one result the story delivers, in plain sentences | Yes | Native description: one line starting with `Outcome:`. Everything else in the description outside the field block is free context and is not checked |
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
| F14 | Test plan | How the story is proven. Either a list of entries, each `automated` (a test the worker must write: what it proves) or `manual` (a step the maintainer follows: action and expected result), or an explicit "not applicable" with a reason. Decided at refine by the maintainer and AI | Required for every non-spike story: entries or not-applicable-with-reason. At least one manual entry when F13 is set. Absent for spikes | **DIPO-7.** Suggest key `test_plan: {entries: [{kind, check, expect?}]}` or `test_plan: {not_applicable: <reason>}` in the field block |
| F15 | Branch | `<ID>/<slug>`, frozen when the story gets its id so a later title change cannot move it | Yes | **DIPO-7.** Suggest key `branch` in the field block. DIPO-7 owns the slug algorithm |
| F16 | Park record | Why and from where a story is parked: reason (0001 list plus `on-hold`), state it left, note | Only while Parked | **DIPO-7.** Suggest key `park: {reason, from, note}` in the field block |
| F17 | Extra instructions | Text added on top of the role's instructions (0011) | Optional | Native implementation plan. DIPO-10 decides how it enters the prompt |
| F18 | Priority, ordinal | Order inside the Ready queue | Optional | Native priority and ordinal |

Not used by the engine: assignee (the claim is the branch ref, DIPO-7), parent and subtasks (milestones replace epics), definition of done (office defaults may exist, the gate ignores them), modified files and final summary (written by the engine on close, not inputs).

The non-native fields split in two groups. Enumerations and booleans (tier, role, flag) suit labels because the CLI filters on them. Structured or multi-line data (unknowns, test plan, branch, park record) needs one block that code parses. Keeping them in one block in the description means a single parser and a single write path through `task edit --description`.

### 2. Lifecycle

**Draft uses the Backlog.md draft feature (option A, chosen by the maintainer on 2026-10-10).** Two options were considered:

- **Option A, Backlog.md draft feature (chosen).** A draft has a temporary `DRAFT-n` id until `refine` promotes it. Promotion rewrites every `DRAFT-n` dependency on other drafts and tasks to the new `DIPO-n` id, and the branch name is assigned at `refine`, not at `plan`. This amends decision 0001 and the vision, where `plan` assigns ids, branches and dependencies. Dropped ideas never consume a real id, and the Backlog.md drafts view stays usable.
- **Option B, a regular status `Drafted`.** Ids, dependencies and branches stable from `plan` on; dropped ideas consume ids. Not chosen.

Consequences of A that code must handle (DIPO-7 owns the mechanics):

- **Promotion is one engine operation:** `backlog draft promote`, then rewrite every `DRAFT-n` reference to the new id in all drafts and active tasks, then write the branch (F15). It must be safe to retry if interrupted.
- **Dependencies between drafts are allowed** and are rewritten on promotion. A Refined story may not depend on a draft: R13 fails, because a draft is not an active task. Promote the dependency first.
- **The engine never renumbers a promoted story:** it never runs `backlog task demote` or sets status `Draft`.

States and their Backlog.md mapping. Office init sets `statuses: ["Refined", "Ready", "In Progress", "In Review", "Parked", "Done"]` and `default_status: "Refined"`. Existing `To Do` tasks migrate to `Refined` (DIPO-7 owns the migration).

| State | Backlog.md | Meaning |
|---|---|---|
| Draft | Draft feature: `backlog/drafts/`, id `DRAFT-n` | An idea being shaped. No real id or branch yet, fields may be missing |
| Refined | Status `Refined` | Title and outcome present, unknowns list exists. Other fields being completed. Unknowns may be open |
| Ready | Status `Ready` | Passed the gate. Eligible for `run` |
| In Progress | Status `In Progress` | Claimed by a worker (the machine claim is the branch ref, DIPO-7) |
| In Review | Status `In Review` | PR open. Reviewer, and the maintainer if flagged |
| Parked | Status `Parked` plus park record (F16) | Needs a human. Other work continues |
| Done | Status `Done` | Merged. Terminal |
| Removed | Archived (not an active task) | Engine-only terminal state for a dropped story, or a story whose identity was lost in reconcile. Not a Backlog.md status. Agreed jointly with DIPO-2 (contract) |

Transitions. Anything not listed is refused by the engine.

| From | To | Trigger | Who |
|---|---|---|---|
| (none) | Draft | `plan` or a new-story command. Code creates a Backlog.md draft (`DRAFT-n`) | Maintainer, content drafted with AI |
| Draft | Refined | `refine <id>`: needs R04 and R05 to pass. Code promotes the draft, rewrites `DRAFT-n` references to the new `DIPO-n` id, writes the branch (F15), and writes an empty unknowns list if absent | Maintainer command |
| Draft | Removed | Drop: archive the draft. Refused while another draft depends on it | Maintainer |
| Refined | Ready | `ready <id>`: rules R01a and R02 to R25 pass | Maintainer command, decided by code only |
| Ready | Refined | Any edit to a gated field through the engine, a failed pickup re-check in `run`, or `unready <id>` | Engine automatically, or maintainer |
| Ready | In Progress | `run` selects it. Code runs the pickup re-check (R01b and R02 to R25), then checks every dependency is Done and no scope collision with in-flight work (M2) | Engine |
| In Progress | In Review | Worker reports done, verify is green, PR is opened | Engine |
| In Review | In Progress | Reviewer blocking finding under the round cap, or maintainer test fail with a note | Engine |
| In Review | Done | Reviewer pass and, if flagged, maintainer test pass; then merge (0002) | Engine, merge authority stays with the maintainer |
| In Progress, In Review | Parked | A park reason from 0001 (`ambiguous-spec`, `verify-failing`, `conflict`, `scope-violation`, `review-blocked`, `budget-exceeded`) | Engine |
| Refined, Ready | Parked | `hold <id> <note>`: the maintainer puts the story aside; park reason `on-hold`, the note is required. `run` skips it and it shows in the triage list | Maintainer |
| Parked | In Progress, In Review, Refined or Ready | `resume <id>` after the maintainer answers or ends the hold; returns to `park.from`. A story returning to Ready goes through the pickup re-check before it runs | Maintainer |
| Parked | Refined | `amend <id>`: the story itself must change. Code unchecks every criterion, then the story must pass the gate again | Maintainer |
| Refined, Ready, Parked | Removed | Drop: `backlog task archive`. Refused while another active story depends on it | Maintainer |

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

- **Active task:** any task returned by `backlog task list --plain`, in any status. Drafts in `backlog/drafts/`, archived and completed tasks are not active.
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
| R05 | The description has exactly one line starting with `Outcome:`, and its text after the prefix is at least 20 characters | `outcome line is missing, duplicated, or shorter than 20 characters` |
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
| R20 | Non-spike story: a test plan is present and is exactly one of: at least one entry, where every entry has kind `automated` or `manual`, a `check` of at least 10 characters, and (for `manual`) a non-empty expected result; or `not_applicable` with a reason of at least 10 characters | `test plan is missing, empty, or entry <n> is incomplete; add entries or not_applicable with a reason` |
| R21 | If the test-before-merge flag is set: the test plan has at least one `manual` entry (0002) | `flagged test-before-merge but the test plan has no manual entry` |
| R22 | Spike (type `spike`): at least one criterion contains a match of `docs/decisions/[0-9]{4}-[a-z0-9-]+\.md`, and scope covers that path. A scope path covers it when it equals the path or ends in `/` and is a prefix of it | `spike must name its ADR (docs/decisions/NNNN-name.md) in a criterion and cover it in scope` |
| R23 | Spike: the test-before-merge flag is not set and there is no test plan | `spike cannot have a test plan or be flagged test-before-merge; it ships no behavior` |
| R24 | Design story (role kind non-code, M4): every scope path is under `docs/design/<ID>/` and that directory is in scope | `design story scope must be docs/design/<ID>/ only` |
| R25 | Every input (documentation) path under `docs/design/<X>/` has `<X>` in dependencies | `input docs/design/<X>/ needs <X> as a dependency` |

Rule numbers are stable once released, because messages and the local database refer to them. New rules get new numbers.

What the gate deliberately does not check: whether paths exist (new files do not exist yet), whether the outcome is a single outcome, whether criteria are good, whether the size is right. Those are judgments made at refine time by the AI and the maintainer. The gate guarantees structure and completeness, not quality.

### 4. Spike stories

- Type `spike`. Output is an ADR in `docs/decisions/`, not product code (concepts.md).
- Same fields as any story. Tier is required, because spikes cost model time too. Role is `developer` until research roles exist.
- Acceptance criteria name the ADR path (R22), and usually include "Maintainer approved the decision". That criterion is checked by the maintainer, never by a worker. The reviewer treats it as not applicable.
- No test plan and no flag (R23).
- Unlike dipsaus-ai, a spike needs no written justification. This project uses spikes on purpose for architecture decisions.

### 5. Design stories (from M4)

- A design story is a story whose role is a non-code role in the roster (for example UX designer). The roster definition, not the story, says a role is non-code.
- It writes only under `docs/design/<ID>/` (R24), for example flows, specs, and SVG or HTML mockups, on its own branch, reviewed against its own criteria, merged like code.
- Stories that build on it list it in dependencies and list `docs/design/<ID>/` as an input (F9, R25). Code knows the order without a model.
- Design files go in inputs (F9, documentation), not in scope (F8). Scope is what a story writes and feeds the collision check; listing a read-only design folder there would make every consumer collide with every other. vision.md was updated accordingly on acceptance.
- The test-before-merge flag is allowed. The test plan's manual entries then list what the maintainer opens and what it should show.
- Before M4 no non-code role exists, so R17 rejects any design story.

## Consequences

- Readiness becomes a pure function of the story, the backlog and office config. Code can evaluate it, the TUI can show each failed rule, and retro can count failures per rule.
- Office init must change `backlog/config.yml` statuses. This repo's own backlog (`To Do`) needs a one-time migration when the orchestrator takes over (cutover).
- Every story that reaches Refined carries structured field data. If DIPO-7 picks a block in the description, hand-written stories (until M3) must include it, so the format must stay readable and simple to type.
- Ideas get a real `DIPO-n` id only at `refine`; dropped drafts never consume one. Refined stories cannot depend on drafts until those are promoted, and promotion must rewrite `DRAFT-n` references (decision 0001 is amended accordingly).
- Stories never go back to Draft once they have an id that others may reference.
- Done tasks stay in `backlog/tasks/` forever unless the office later handles `completed/` in dependency resolution. The board grows over time.
- Backlog.md tools (board, browser) show the new statuses and labels with no plugin. They show the field block as raw text.
- The banned-phrase list is a blunt tool. It catches the common vague phrases and nothing more. It is office config so it can be tuned.

## Deferred to DIPO-7

- Final storage of F10, F11, F12, F13, F14, F15 and F16 (suggestions above), and the field block format and parser.
- The slug algorithm for F15.
- Parsing `--plain` output, since the CLI has no JSON.
- Migration from `To Do` to `Refined` and writing the office status list.
- Promotion as one retry-safe operation: `draft promote`, rewriting `DRAFT-n` references, writing the branch.
- How `completed/` and archived tasks are treated, and confirming the engine never runs `task complete`.
- Scope collision check (prefix overlap) at pickup, used by `run` (M2).

## Open questions for the maintainer

1. **Draft storage — answered 2026-10-10: option A**, the Backlog.md draft feature (section 2). Amends decision 0001.
2. **Hold by hand — answered 2026-10-10: yes.** `hold <id> <note>` parks a Refined or Ready story with the new park reason `on-hold`; `resume` returns it to where it was. Adds `on-hold` to the park reasons of decision 0001.
3. **Tier from M0 — answered 2026-10-10: yes**, required on every story from the start (R16), so stories need no second pass when tiers take effect in M1.
4. **Outcome — answered 2026-10-10: an `Outcome:` line** in the description (F3, R05), as current stories use. The rest of the description is free context; the prompt (DIPO-10) can use the outcome on its own.
5. **Thresholds — answered 2026-10-10: accepted as defaults** (title at most 100, outcome at least 20, criterion at least 10, slug at most 40, and the default banned phrases). All are office configuration and can be tuned.
6. **Test plan — answered 2026-10-10:** the manual test script became a test plan (F14) with automated and manual entries, required on every non-spike story where applicable; where it does not apply, the story says so explicitly with a reason (R20). A flagged story needs at least one manual entry (R21).
7. **Design stories — answered 2026-10-10: recognised by the role** (the roster says a role is non-code), not by a separate `design` type.
