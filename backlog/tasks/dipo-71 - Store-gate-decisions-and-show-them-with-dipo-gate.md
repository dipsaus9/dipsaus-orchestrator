---
id: DIPO-71
title: Store gate decisions and show them with dipo gate
status: In Progress
assignee: []
created_date: '2026-10-12 09:21'
updated_date: '2026-10-13 11:31'
labels:
  - 'tier:S'
milestone: m-0
dependencies:
  - DIPO-22
  - DIPO-27
  - DIPO-30
references:
  - packages/engine/src/gate/store/
  - packages/engine/src/db/migrations/
  - packages/engine/src/features.ts
  - packages/cli/src/
  - packages/engine/test/gate/
  - packages/contract/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0012-story-standard.md
priority: high
type: feature
ordinal: 30500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine stores every pickup-mode gate evaluation with its rule results and the story content hash, serves the read `story.gate` with the ready-mode result without storing it, and `dipo gate <id>` prints that result.

Context: split from DIPO-30 in the M0 review (DIPO-15); DIPO-30 keeps the pure `evaluateGate`. The `ready` command is M3. In M0 the gate runs as the pickup re-check inside `work.run` (DIPO-48) and through this read-only check (M0 breakdown decision D3, DIPO-15). The structural check of the backlog PR (DIPO-35) matches a new `Ready` against a stored passing decision. The read is added through the registration seam of DIPO-22 (`register(registry)` listed in `packages/engine/src/features.ts`). References: 0007 section 4 (`gates`, `gate_decisions` with rule results and content hash); 0012 section 3 (decision stored in the local database); 0005 section 7 (reads) and section 11 (`since`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-71/store-gate-decisions-show-them-dipo-gate"
unknowns:
  - q: "Whether M0 ships the read-only `story.gate` read and `dipo gate`?"
    status: "resolved"
    answer: "maintainer decision D3 of the M0 breakdown (2026-10-11, recorded in DIPO-15): yes; the maintainer sets Ready with the Backlog CLI, `dipo gate <id>` is read-only, and `run` refuses a story that fails the gate."
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a pickup-mode evaluation stores one decision with every rule result and the content hash."
    - kind: "automated"
      check: "(engine) `story.gate` on a failing fixture story returns every failure message and stores nothing."
    - kind: "automated"
      check: "(unit) the content hash changes when a criterion changes and stays equal when only free context in the description changes."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A migration adds `gates` and `gate_decisions` with the columns of 0007 section 4; a decision stores mode, every rule result and the story content hash.
- [x] #2 `recordGateDecision(office, story, mode)` evaluates with `evaluateGate` (DIPO-30) and stores the decision in one transaction; every pickup-mode evaluation is stored.
- [x] #3 The story content hash is sha256 over the canonical JSON of the story fields the gate reads, so free context in the description does not change it.
- [x] #4 `findPassingDecision(office, key, contentHash)` returns the latest passing decision for that hash, or none.
- [x] #5 Read `story.gate { office, story }` (contract minor, registered through the DIPO-22 registry) returns the ready-mode result and stores nothing.
- [x] #6 `dipo gate <id>` prints `ready <ID> passed` or each failure message on its own line, and exits 1 when any rule fails.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-30 in the M0 review (DIPO-15). Before cutover: built by hand-run agents.

Scope additions (outside the story's References):
- packages/engine/src/commands/registry.ts and packages/engine/src/reads/execute.ts: a new addAsyncRead seam. Read handlers were synchronous inside one deferred transaction, and story.gate must wait on the Backlog CLI. A waiting read resolves its story references in the deferred transaction and runs its handler after it; synchronous reads are unchanged.
- packages/engine/src/backlog/runner.ts: allows milestone list and the flag --show-completed, so the gate reads which milestones exist (R07).
- packages/engine/src/stories/read.ts: exports mapLimited for the active-task views.
- packages/daemon/src/foreground.ts: constructs GateStore and registers its feature (it needs the office git, like StoryIndex), so it is listed there rather than in features.ts.
- packages/cli/src/daemon-commands.ts: DaemonSession includes read; the session fakes in daemon-commands.test.ts, office-commands.test.ts and test/office-resolution/office-resolution.test.ts get a read stub.
- packages/cli/src/office-commands.ts: exports withOffice, parseOptions and Act for dipo gate.

Design notes:
- The gate reads the story on the office's _base worktree (as the index and pickup do), without fetching first.
- The content hash leaves out status, so a ready-mode decision taken at Refined matches the story after it is set to Ready.
- A rule decision is one gates row (kind = mode) plus one gate_decisions row (approved/rejected, decided_by rule, rule_results JSON of every rule with passed and messages). No change-log entry is written.
- Migration 8 (gates). DIPO-72 runs in parallel and may also take 8; whichever merges second renumbers.

Scope additions (review round 1):
- packages/engine/src/db/schema.ts: lists migration 8 (gates) in MIGRATIONS, the one place migrations are registered.
- packages/engine/src/gate/index.ts: re-exports the new gate/store module next to evaluateGate.
- packages/engine/src/index.ts: exports GateStore and the decision helpers so the daemon (and DIPO-48) can reach them through the package entry.
- packages/engine/test/commands/registry.test.ts: tests the addAsyncRead seam (duplicate names, story references resolved before the handler).

Error codes: story.gate answers story.unknown when the story is not on the office's base branch, and office.refused with details.step config (no valid office configuration) or backlog (the Backlog CLI could not read the inputs), each with a plain message. GateStore.checkReady is ready-mode only; pickup evaluations happen only through recordGateDecision.

Review round 3 (maintainer decision B):
- Contract: new list OFFICE_ERROR_CODES in packages/contract/src/errors.ts with config.invalid and backlog.unreadable (minor 1, unreleased). story.gate answers config.invalid (no valid office configuration) and backlog.unreadable (Backlog CLI, refusal or parse failure on the base); story.unknown and office.refused step git.version are unchanged.
- Merged origin/main; the gates migration is now 13 (0013-gates.ts).
- Scope additions: packages/engine/src/retention/policy.ts lists gates and gate_decisions as tier S; packages/engine/src/retention/run.ts deletes gate decisions decided before the state cutoff and decided gates left without a decision (a waiting gate is kept), tested in packages/engine/test/retention/retention.test.ts.

- docs/decisions/0005-command-and-event-model.md: one dated amendment line for config.invalid and backlog.unreadable (maintainer approved option B on 2026-10-13).
<!-- SECTION:NOTES:END -->
