---
id: DIPO-59
title: Relay Claude hooks and ask the maintainer for permissions
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 08:00'
labels:
  - 'tier:M'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-45
  - DIPO-50
  - DIPO-51
references:
  - packages/engine/src/hooks/
  - packages/engine/src/workers/claude-cli/
  - packages/engine/src/host/
  - packages/engine/src/run/
  - packages/cli/src/
  - packages/engine/test/hooks/
  - packages/engine/test/run/
  - packages/engine/test/recordings/claude-cli/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: medium
type: feature
ordinal: 59000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo hook <event>` relays Claude Code hook payloads to the worker host, a `PermissionRequest` asks the maintainer through `question.asked` when present and denies otherwise, and a worker blocked on a denied action parks `needs-permission` and can be resumed with allow-once or deny through `dipo answer`.

References: 0008 section 5 (hook list, relay, presence rule, wait, `needs-permission`, allow once exactly matching), section 8 (resume); 0005 amendment (`QuestionView.kind`, `work.answer.decision`); 0017 scenarios `permission-wait`, `needs-permission`.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

M0 breakdown decision D10 (maintainer, 2026-10-12, DIPO-15): the allow-once flow through `work.answer` and `dipo answer` stays in M0 as an explicit exception to decision D2. It resumes only a story parked `needs-permission`; every other resume of a parked story stays M1. The park itself is written by DIPO-50; resume follows 0008 section 8 as built in DIPO-51.

Built after cutover: dipo delivers this story itself (M0 breakdown decision D6, DIPO-15).

```dipo
branch: "DIPO-59/relay-claude-hooks-ask-maintainer"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) `permission-wait` replay with the maintainer present emits `question.asked` kind permission and denies after the timeout."
    - kind: "automated"
      check: "(engine) `needs-permission` replay parks, and allow-once matches only the exact command."
    - kind: "automated"
      check: "(engine) `work.answer` with `decision` on a story parked for any reason other than `needs-permission` fails with an error naming the park reason, and the story stays Parked."
    - kind: "automated"
      check: "(engine) allow once for a sandbox-bound action does not lift the sandbox block, and the park question points to office config."
    - kind: "manual"
      check: "in a scratch office give a story that needs `docker ps`"
      expect: "the story parks `needs-permission`; `dipo answer <q> allow` resumes it."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The run settings file registers the 0008 hooks as `dipo hook <event>`; the command forwards stdin to `DIPO_HOST_SOCKET`, prints nothing and exits 0 within 2 s, failing silently.
- [ ] #2 The host appends hook payloads as `ch: "hook"` lines, replayed like stdout.
- [ ] #3 With `permissions.ask: when-present`, a connected client and a client command or read within `permissions.presentMinutes` (stream heartbeats do not count), a `PermissionRequest` emits `question.asked` (kind permission, tool and input summary) and `work.observed input-wait`, and waits up to `timeouts.permissionWaitSeconds` for `work.answer`, then denies.
- [ ] #4 Without presence, with `permissions.ask: never`, or with the daemon down, the hook returns no decision at once, so the call is denied.
- [ ] #5 A `needs-permission` park (DIPO-50) carries a permission question with the recorded tool and action, answerable with `work.answer { question, decision }`.
- [ ] #6 `work.answer { decision: "allow" }` resumes the same session and allows only the first request whose tool and exact command or exact path match, never a prefix or glob; `deny` resumes with "do it without <action>"; no allow is saved as a rule or for later runs.
- [ ] #7 Allow once never lifts a sandbox block; for a sandbox-bound action the question says so and points to office config.
- [ ] #8 `work.answer` with a `decision` resumes only a story parked `needs-permission`; for any other park reason it fails and the story stays Parked.
- [ ] #9 `dipo answer <question> <text|allow|deny>` sends `work.answer`.
- [ ] #10 Recordings `permission-wait` and `needs-permission` are captured with the DIPO-41 tool and replayed.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S43 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
