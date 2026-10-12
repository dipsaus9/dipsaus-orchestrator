---
id: DIPO-75
title: Answer a needs-permission park with allow once or deny
status: To Do
assignee: []
created_date: '2026-10-12 09:22'
updated_date: '2026-10-12 11:54'
labels:
  - 'tier:M'
  - after-cutover
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-59
references:
  - packages/engine/src/hooks/
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
ordinal: 59500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story parked `needs-permission` carries a permission question that the maintainer answers with `dipo answer` (`work.answer` with a `decision`); allow once resumes the same session and allows only the exact recorded action, and deny resumes it with "do it without <action>".

Context: split from DIPO-59 in the M0 review (DIPO-15); DIPO-59 keeps the hook relay, the presence check, the `questions` table, `work.answer` for a waiting permission question, and `dipo answer`; this story extends `work.answer` to parked stories. M0 breakdown decision D10 (maintainer, 2026-10-12, DIPO-15): the allow-once flow through `work.answer` and `dipo answer` stays in M0 as an explicit exception to decision D2. It resumes only a story parked `needs-permission`; every other resume of a parked story stays M1. The park itself is written by DIPO-50; resume follows 0008 section 8 as built in DIPO-51. The `needs-permission` recording is captured live by the maintainer with the DIPO-41 tool. References: 0008 section 5 (blocked on a permission, allow once exactly matching, sandbox-bound actions), section 8 (resume); 0005 amendment (`QuestionView.kind`, `work.answer.decision`); 0017 scenario `needs-permission`.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-75/answer-needs-permission-park-allow-once"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) `needs-permission` replay parks with a permission question, and allow once matches only the exact command."
    - kind: "automated"
      check: "(engine) `work.answer` with `decision` on a story parked for any reason other than `needs-permission` fails with an error naming the park reason, and the story stays Parked."
    - kind: "automated"
      check: "(engine) allow once for a sandbox-bound action does not lift the sandbox block, and the park question points to office config."
    - kind: "manual"
      check: "maintainer runs `bun run recordings:capture needs-permission`, then in a scratch office runs a story that needs `docker ps`"
      expect: "the recording is written with no secret; the story parks `needs-permission`; `dipo answer <q> allow` resumes it."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A `needs-permission` park (DIPO-50) stores a permission question with the recorded tool and action, answerable with `work.answer { question, decision }`.
- [ ] #2 `work.answer { decision: "allow" }` resumes the same session and allows only the first request whose tool and exact command or exact path match, never a prefix or glob; `deny` resumes with "do it without <action>"; no allow is saved as a rule or for later runs.
- [ ] #3 Allow once never lifts a sandbox block; for a sandbox-bound action the question says so and points to office config.
- [ ] #4 For a parked story, `work.answer` with a `decision` resumes only a story parked `needs-permission`; for any other park reason it fails and the story stays Parked.
- [ ] #5 `dipo answer <question> allow|deny` (DIPO-59) on a park's permission question resumes the story as above and prints the resumed run.
- [ ] #6 The `needs-permission` recording is captured live by the maintainer with the DIPO-41 tool, committed, and replayed in the tests.
- [ ] #7 `work.answer` on a permission question without `decision` fails with `args.invalid`; for a permission question `text` is the optional reason given to the worker and may be empty.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Split from DIPO-59 in the M0 review (DIPO-15); flagged test-before-merge because the live capture is a maintainer step. After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
