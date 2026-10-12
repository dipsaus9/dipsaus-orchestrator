---
id: DIPO-50
title: 'Enforce caps, park stories and stop workers'
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 21:48'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-74
references:
  - packages/engine/src/run/caps.ts
  - packages/engine/src/run/park.ts
  - packages/engine/src/run/
  - packages/engine/src/db/migrations/
  - packages/cli/src/
  - packages/engine/test/run/
  - packages/engine/src/features.ts
documentation:
  - docs/decisions/0001-foundational-decisions.md
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0012-story-standard.md
priority: high
type: feature
ordinal: 50000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine stops a worker at 100% of its tier's token budget, turn cap or time cap and parks the story `budget-exceeded`, parks a worker that reports `blocked` with a question as `ambiguous-spec`, ends a worker on `work.stop` with park reason `stopped`, and writes every park as a story fact on the story branch.

Context: the triage view, `work.resume` and answer-before-park waits are M1 (M0 breakdown decision D2, DIPO-15). The one M0 exception is answering a `needs-permission` park with `work.answer` (allow once or deny), which DIPO-75 builds (M0 breakdown decision D10, DIPO-15). The 80% nudge is DIPO-60. `maxMinutes` counts wall-clock time, sleep included, and is rechecked on a tick (M0 review, DIPO-15); keep-awake (DIPO-63) holds idle sleep off while work runs. Until DIPO-59 adds the `PermissionRequest` hook, the launch plan (`--permission-prompts none`, DIPO-40) denies every call that would prompt; a worker that cannot finish without the denied action reports `blocked` with `needsPermission`, and the story parks `needs-permission` (0008 sections 5 and 7). References: 0008 section 6 (stop sequence, caps checked after every usage and turn event, turns summed by the engine), section 7 (intent first, `capped`, blocked rows); 0012 F16, transition In Progress or In Review to Parked; 0010 section 2 (lane a park commit and push), section 3 (`park` key); 0005 section 4 (`work.stop`), section 5 (`story.parked` with actions); 0007 section 4 (`parks`); 0001 (budgets never raised silently).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-50/enforce-caps-park-stories-stop-workers"
unknowns:
  - q: "Caps and park writing in M0 although 0003 lists caps and park reasons under M1?"
    status: "resolved"
    answer: "maintainer decision D2 of the M0 breakdown (2026-10-11, recorded in DIPO-15): caps (token budget, turns, time) and parks with a reason are in M0; the triage view and resume of parked stories stay M1; recorded as an amendment in 0003."
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) `budget-engine-cap` replay parks `budget-exceeded` with the token cap named and a park commit pushed."
    - kind: "automated"
      check: "(engine) `max-turns` replay parks `budget-exceeded`; `worker-park-ambiguous` parks `ambiguous-spec` with the question."
    - kind: "automated"
      check: "(engine) with no events after start, advancing the manual clock past `maxMinutes` fires the time cap on the next tick."
    - kind: "automated"
      check: "(engine) a scripted report `blocked` with `needsPermission` parks `needs-permission` with the tool and action as detail, and worktree, branch and session id are kept."
    - kind: "automated"
      check: "(engine) `work.stop` on a replaying run records the intent, the fake process sees the stop sequence, and the story parks `stopped`."
    - kind: "manual"
      check: "during a scratch run, `dipo stop <ID>` and confirm"
      expect: "the worker ends within 30 s and `backlog task view <ID> --plain` on the story branch shows `Parked` with reason `stopped`."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A migration adds `parks`; every park stores reason, from-state, detail, last good commit and time.
- [ ] #2 `parkStory` writes the F16 `park` block and status `Parked` in one commit `<ID>: status Parked` on the story branch, pushes it, and emits `story.state` and `story.parked` with `actions` limited to commands the engine implements.
- [ ] #3 Budget tokens, summed turns and elapsed minutes are checked after every `usage` and `turn` event and on a 1-minute tick of the injected clock, so the time cap fires without new events; elapsed minutes are wall-clock time since the worker started, including any time the machine slept; at 100% of `budgetTokens`, `maxTurns` or `maxMinutes` the engine records a `cap` intent, stops the worker and parks `budget-exceeded` naming the cap that fired.
- [ ] #4 `error_max_turns` from the CLI backstop parks `budget-exceeded` naming the turn cap; the budget is never raised.
- [ ] #5 A report `blocked` with a question parks `ambiguous-spec` with the question as detail.
- [ ] #6 Every op is stored as a pending intent on the run before it is sent, and the outcome is read from the intent first.
- [ ] #7 `work.stop { story, note? }` sends the stop sequence through the host (now-priority message, close stdin, SIGTERM after 10 s, SIGKILL after 30 s) and parks `stopped` with `park.from` In Progress; branch and worktree are kept; a story not running fails `story.notRunning`.
- [ ] #8 `dipo stop <ID>` asks for confirmation, as `commands.describe` marks `work.stop` with `confirm: true`.
- [ ] #9 Before DIPO-59 lands, a report `blocked` with `needsPermission` (a call denied by `--permission-prompts none`) parks `needs-permission` with the tool and action as detail, keeping worktree, branch and session.
- [ ] #10 The engine stops the worker at the first turn that ends `error_max_turns` (DIPO-42 keeps the outcome `capped` even if a later queued message finishes), so a later done report never overrides the cap; a test covers it.
- [ ] #11 A `git.worktreeTampered` refusal (DIPO-38) parks the story `scope-violation` and no more git runs in that worktree (0008 section 2); a test covers it.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S34 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
