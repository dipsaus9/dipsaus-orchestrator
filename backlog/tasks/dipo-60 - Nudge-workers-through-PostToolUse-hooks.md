---
id: DIPO-60
title: Nudge workers through PostToolUse hooks
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:S'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-47
  - DIPO-59
references:
  - packages/engine/src/hooks/nudges.ts
  - packages/engine/src/prompts/feedback/
  - packages/engine/test/hooks/
documentation:
  - docs/decisions/0014-worker-prompt-assembly.md
priority: medium
type: feature
ordinal: 60000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine answers `PostToolUse` and `SessionStart` hook calls with a short `additionalContext` nudge only when a fact makes it relevant: a write outside scope, a stale context-pack file, budget past 80%, or an input changed on the base.

References: 0014 section 8 (triggers, texts, 300 characters, once per fact signature, 2 s limit, counted per run).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

Built after cutover: dipo delivers this story itself (M0 breakdown decision D6, DIPO-15).

```dipo
branch: "DIPO-60/nudge-workers-through-posttooluse-hooks"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) each trigger with a fact gives its text; the same signature twice gives one nudge."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each of the four triggers in the 0014 section 8 table produces its nudge text and nothing else produces one.
- [ ] #2 A nudge is at most 300 characters and sent once per fact signature per session.
- [ ] #3 The hook answers within 2 s and prints nothing on any failure.
- [ ] #4 Nudges are counted per run in `prompt_parts`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S44 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.
<!-- SECTION:NOTES:END -->
