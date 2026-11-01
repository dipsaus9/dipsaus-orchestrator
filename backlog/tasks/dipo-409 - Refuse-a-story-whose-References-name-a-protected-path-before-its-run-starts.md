---
id: DIPO-409
title: Refuse at pickup a story whose References name a protected path
status: In Progress
assignee: []
created_date: '2026-10-31 10:18'
updated_date: '2026-11-01 09:09'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/gate/input.ts
  - packages/engine/src/box/parts.ts
  - packages/engine/test/gate/
  - docs/decisions/0012-story-standard.md
priority: medium
type: bug
ordinal: 387000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo run` refuses a story that names files the box protects at its pickup gate, at once and with the reason, instead of parking it after a whole worker session.

Gap G20, 2026-10-31: DIPO-405 listed `.dipo/office.yaml` in its References and asked in criterion 3 for an edit to it. dipo ran the story for about 20 minutes in a box, then parked it as a scope violation ("changes protected files: dipo's configuration (.dipo/)"), as it should; but the story's References showed before the run that the change could never be delivered.

Design: a new gate rule next to R12, evaluated in pickup mode only (as R01b is), so `work.run`'s pickup gate (recordGateDecision, before the claim) refuses the story and it is not claimed. It does not run in Ready mode: a story for a builder or the maintainer may name `.github/` or `.dipo/` and still be Ready. The rule uses the box's own path check, `protectedKind` with `PROTECTED_TEXT` in packages/engine/src/box/parts.ts, never a second list (0001). If the engine's layer bands (0004) do not let gate/ import box/, move that check, unchanged, to a module both may import. The new rule changes ADR 0012's rule list; the implementing PR waits for the maintainer's approval of that wording (DIPO-399). References that name a folder are not expanded: a folder is refused only when the check protects the folder path itself (`.github/`, `.dipo/`, a story folder). 0012, 0008, 0004.

```dipo
branch: "DIPO-409/refuse-protected-references"
unknowns:
  - q: "Criterion 1 says a pickup refused by the new rule keeps the story Ready, but every pickup gate failure today moves it to Refined (`#toRefined` in work-run.ts, the path the existing DIPO-48 tests assert). Should the R31 refusal keep the story Ready, or follow the same Refined move as the other pickup failures? The code follows the other failures; a Ready-keeping refusal would need a change to that shared path."
    status: "resolved"
    answer: "Follow the same Refined move as every other pickup gate failure (#toRefined); no second path (0001). Criterion 1's 'its status stays Ready' was wrong: in the PR, change criterion 1 through the Backlog CLI to say the story moves to Refined as for any pickup gate failure, and test that path."
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) the pickup gate refuses a story whose References name a path the box protects, before any claim, box or worker"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A pickup-mode gate rule (the next free R number) fails a story whose References name a path that `protectedKind` protects, for every kind but `link`; the failure names the path and its kind and says a builder or the maintainer takes such a story. `dipo run` then refuses the story as for any pickup gate failure: no claim, no box, no worker, and its status stays Ready
- [ ] #2 The rule calls the same `protectedKind` as the scope-violation park, not a copy, shown by tests on the real function: `.dipo/office.yaml`, `.dipo/`, `.github/workflows/ci.yml`, `.github/`, `.GitHub/x`, an NFKD look-alike of `.github`, `./.dipo/x`, `.dipo/x/` with a trailing slash, `.gitmodules`, `bunfig.toml` and a story-folder file are refused; `packages/engine/src/x.ts`, `packages/` and `.claude/` (only its settings file is protected) are not
- [ ] #3 Fail closed: when the story folders cannot be read at pickup, the rule fails the story instead of passing it, shown by a test against the real gate input path
- [ ] #4 The Ready-mode gate gives the same result as before for every story (a Ready-mode test with a `.github/` reference still passes), and the scope-violation park after a run is unchanged
- [ ] #5 ADR 0012 lists the new rule with its mode in the same PR
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-01 09:08 UTC: ambiguous-spec
- Detail: Criterion 1 says a pickup refused by the new rule keeps the story Ready, but every pickup gate failure today moves it to Refined (`#toRefined` in work-run.ts, the path the existing DIPO-48 tests asse…
- Run: run_01M6B5E9BH0A04V8RYCMQH6YNR
- Criteria met: 2 of 5 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 155,729 of 300,000 tokens; 60 of 90 turns; 8 of 45 minutes
- Last good commit: 5d960fade23aa7604ef7765eef5e9f874fd6b054

Resumed 2026-11-01 09:09 UTC; grants: none; note: Follow the same Refined move as every other pickup gate failure (#toRefined); no second path (0001). Criterion 1's 'its status stays Ready' was wrong: in the PR, change criterion 1 through the Backlo…
<!-- SECTION:NOTES:END -->
