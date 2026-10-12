---
id: DIPO-22
title: Execute commands with idempotency and an office change log
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-20
  - DIPO-21
references:
  - packages/engine/src/commands/
  - packages/engine/src/changelog/
  - packages/engine/src/stories/keys.ts
  - packages/engine/src/db/migrations/
  - packages/engine/test/commands/
  - packages/engine/test/changelog/
  - packages/engine/src/reads/
  - packages/engine/src/features.ts
  - packages/engine/src/index.ts
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
priority: high
type: feature
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine has one command executor that validates args, resolves story references, runs the handler and writes facts, change-log entries and the idempotency record in one transaction, and it can replay an office's change log from a cursor.

Context: every later command uses this path. The registry is the seam later stories plug into (M0 review, DIPO-15): DIPO-27 adds office load steps to it, and feature stories register their commands, reads and load steps in their own directories plus one line in `features.ts`. Views are not derived here: an entry carries the view its writer computed, tests use fixture views, the minimal `deriveStoryView` and `OfficeSummary` come from DIPO-32, and DIPO-52 extends them. References: 0005 sections 1 (rule: facts and log in one transaction, then reply), 2 (StoryKey, alias resolution, `story.ambiguous`), 6 (change log as outbox, gap-free seq, debounce before the log), 8 (replay, `stream.resetRequired`), 9 (idempotency, `request.reused`, `confirmation.required`); 0007 sections 3 (`epoch`, `next_seq`, `replay_floor_seq`), 4 (`change_log`, `requests`, `stories`, `story_aliases`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-22/execute-commands-idempotency-office"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a test command writes a fact; the reply cursor equals the last seq; replay from 0 returns the entry."
    - kind: "automated"
      check: "(engine) retry with same id and hash returns the stored reply; different hash fails `request.reused`."
    - kind: "automated"
      check: "(unit) alias resolution cases, including a reused `DRAFT-n`."
    - kind: "automated"
      check: "(engine) replay below the floor or with another epoch returns `stream.resetRequired`."
    - kind: "automated"
      check: "(engine) a feature module registered in a test registry is reached by `executeCommand`; a duplicate name fails registration."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A migration adds `change_log`, `requests`, `stories` and `story_aliases` with the columns of 0007 section 4.
- [ ] #2 `executeCommand` returns `args.invalid` with zod issues for bad args, `office.unknown` for an unknown office, and never falls back to a default office.
- [ ] #3 A handler's facts, its change-log rows and the `requests` row commit in one transaction; a thrown handler leaves no rows and consumes no seq.
- [ ] #4 Seq is gap-free per office and `offices.next_seq` advances in the same transaction; each office has a random `epoch`.
- [ ] #5 A repeated `requestId` with the same args hash returns the stored reply without running the handler; with a different hash it fails with `request.reused`; the hash is taken after story references resolve to `StoryKey`.
- [ ] #6 A command with `origin: "conversation"` and `confirmed: false` fails with `confirmation.required`.
- [ ] #7 Story references resolve as key, then current id, then alias; a conflict fails with `story.ambiguous`; an alias is retired when its id becomes another story's current id.
- [ ] #8 `replay(office, after)` returns entries with a higher seq in order, or `stream.resetRequired` with `oldest` when `after` has another epoch or is below `replay_floor_seq`.
- [ ] #9 A `Renderer` turns stored entries into contract events at read time, using the view stored on each entry, and every rendered event parses with the DIPO-20 schemas.
- [ ] #10 Commands and reads are registered through a registry: each feature module exports `register(registry)` that adds its handlers, arg and result schemas, `since` or `provisional`, and `confirm` and `irreversible` for commands; `packages/engine/src/features.ts` lists the modules, so a later story adds a command or read without editing `commands/` or `reads/`.
- [ ] #11 Registering a command or read name twice fails at startup naming both modules.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S07 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
