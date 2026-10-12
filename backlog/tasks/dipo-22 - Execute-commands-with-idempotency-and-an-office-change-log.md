---
id: DIPO-22
title: Execute commands with idempotency and an office change log
status: Done
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 12:22'
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
  - packages/engine/src/db/schema.ts
  - packages/engine/test/db/migrations.test.ts
  - packages/engine/src/platform/ids.ts
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
- [x] #1 A migration adds `change_log`, `requests`, `stories` and `story_aliases` with the columns of 0007 section 4.
- [x] #2 `executeCommand` returns `args.invalid` with zod issues for bad args, `office.unknown` for an unknown office, and never falls back to a default office.
- [x] #3 A handler's facts, its change-log rows and the `requests` row commit in one transaction; a thrown handler leaves no rows and consumes no seq.
- [x] #4 Seq is gap-free per office and `offices.next_seq` advances in the same transaction; each office has a random `epoch`.
- [x] #5 A repeated `requestId` with the same args hash returns the stored reply without running the handler; with a different hash it fails with `request.reused`; the hash is taken after story references resolve to `StoryKey`.
- [x] #6 A command with `origin: "conversation"` and `confirmed: false` fails with `confirmation.required`.
- [x] #7 Story references resolve as key, then current id, then alias; a conflict fails with `story.ambiguous`; an alias is retired when its id becomes another story's current id.
- [x] #8 `replay(office, after)` returns entries with a higher seq in order, or `stream.resetRequired` with `oldest` when `after` has another epoch or is below `replay_floor_seq`.
- [x] #9 A `Renderer` turns stored entries into contract events at read time, using the view stored on each entry, and every rendered event parses with the DIPO-20 schemas.
- [x] #10 Commands and reads are registered through a registry: each feature module exports `register(registry)` that adds its handlers, arg and result schemas, `since` or `provisional`, and `confirm` and `irreversible` for commands; `packages/engine/src/features.ts` lists the modules, so a later story adds a command or read without editing `commands/` or `reads/`.
- [x] #11 Registering a command or read name twice fails at startup naming both modules.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S07 (DIPO-15). Before cutover: built by hand-run agents.

Scope additions: packages/engine/src/db/schema.ts lists the compiled-in migrations, so the new step under db/migrations/ is appended there. packages/engine/test/db/migrations.test.ts assumed the head was migration 1; its base list now pins the first migration so the runner tests stay valid as later stories add migrations.

Implementation (DIPO-22):
- Migration 2 (packages/engine/src/db/migrations/0002-change-log-requests-stories.ts): stories (key, story_id, provisional, frozen_branch, backlog_created raw string, first_seen_at, removed_at; one live current id per office), story_aliases (key, former id, valid_from, retired_at), change_log (seq, at, type, tier S/R, key, run_id, caused_by, delta JSON, view JSON), requests (request_id, command, args_hash, reply JSON, at). All keyed office_id first, with foreign keys to offices.
- Log position: next_seq is the seq the next entry gets; a new office starts at next_seq 1 and replay_floor_seq 0, so a cursor at seq 0 means before anything. newLogState()/newEpoch() give DIPO-27 the random epoch (16 random bytes, hex) for the offices row.
- executeCommand(deps, request): capability.missing for a name nothing registered (no generic unknown-command code exists in 0005), confirmation.required, args.invalid with details.issues, office.unknown for an unknown or forgotten office. Story references are found from the args schema (fields typed StoryRefValue or arrays of it), resolved inside the immediate transaction, and the args hash is sha256 over the command name and canonical JSON of the resolved args. Failed replies are not stored, so a failed request id may run again.
- Office handlers are synchronous; software-level handlers may be async and keep their idempotency records in an in-memory table (MemoryRequestTable, 24 h) as 0005 section 9 says. office.purge's own record (DIPO-76) can use the same table.
- replay(office, after) also asks for a reset when the cursor names another office's stream or a seq past the head.
- Renderer: the default rendering is the delta, with the stored view filling a data field named view (story.state); per-type overrides; every rendered event is parsed with its contract schema and a RenderError is thrown otherwise.
- Registry: FeatureModule { name, register(registry) } with addOfficeCommand, addSoftwareCommand and addRead; checkVersioning and the command level are checked at registration; features.ts lists the modules (today reads/describe, which serves commands.describe from the registry, provisional ones left out).

After merging DIPO-26: the request args hash uses the one canonicalJson in packages/engine/src/config/merge.ts (same behaviour: sorted keys, undefined dropped), so commands/requests.ts no longer has its own; config/ is only imported, not edited. With zod now a direct engine dependency, the registry uses z.output/z.input and story reference fields are found with zod classes instead of structural types. Migration numbering unchanged (2); DIPO-26 added none.

Review advisories: the executor reads the requests record before resolving story references, so a retry of a command that succeeded gets its stored reply even if a story it named was since removed (a different command name still fails request.reused; when resolution fails with a record present the stored reply wins). Software-level requests still running are kept in flight in MemoryRequestTable, so a concurrent duplicate shares the first reply instead of running twice. packages/engine/src/platform/ids.ts now exports cryptoFill, which changelog/log.ts uses for the epoch instead of its own copy (scope addition for that export).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Command execution: migration 2 (stories, story_aliases, change_log, requests; office_id first); story keys with alias resolution and story.ambiguous; gap-free change log with per-office random epoch, replay with stream.resetRequired, view-checked renderer; executeCommand with one write transaction per command, idempotency by requestId (looked up before reference resolution) with request.reused, confirmation.required for conversation origin, in-memory software-level request table with in-flight dedupe; registry and features list, commands.describe without provisional entries and with reads; unknown names return capability.missing. Reviewer pass.
<!-- SECTION:FINAL_SUMMARY:END -->
