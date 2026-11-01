---
id: DIPO-409
title: Refuse at pickup a story whose References name a protected path
status: Done
assignee: []
created_date: '2026-10-31 10:18'
updated_date: '2026-11-01 12:21'
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
modified_files:
  - docs/decisions/0012-story-standard.md
  - packages/engine/src/box/collisions.ts
  - packages/engine/src/box/index.ts
  - packages/engine/src/box/parts.ts
  - packages/engine/src/gate-decisions/decisions.ts
  - packages/engine/src/gate/evaluate.ts
  - packages/engine/src/gate/index.ts
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/gate/types.ts
  - packages/engine/src/story-store/protected.ts
  - packages/engine/test/box/parts.test.ts
  - packages/engine/test/box/tracker-folder.test.ts
  - packages/engine/test/gate/gate.test.ts
  - packages/engine/test/gate/pickup-protected.test.ts
  - packages/engine/test/run/work-run.test.ts
  - packages/engine/test/story-store/seam-literals.test.ts
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
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) the pickup gate refuses a story whose References name a path the box protects, before any claim, box or worker"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A pickup-mode gate rule (the next free R number) fails a story whose References name a path that `protectedKind` protects, for every kind but `link`; the failure names the path and its kind and says a builder or the maintainer takes such a story. `dipo run` then refuses the story as for any pickup gate failure: no claim, no box, no worker, and the story moves to Refined as on every other pickup gate failure (`#toRefined` in work-run.ts)
- [x] #2 The rule calls the same `protectedKind` as the scope-violation park, not a copy, shown by tests on the real function: `.dipo/office.yaml`, `.dipo/`, `.github/workflows/ci.yml`, `.github/`, `.GitHub/x`, an NFKD look-alike of `.github`, `./.dipo/x`, `.dipo/x/` with a trailing slash, `.gitmodules`, `bunfig.toml` and a story-folder file are refused; `packages/engine/src/x.ts`, `packages/` and `.claude/` (only its settings file is protected) are not
- [x] #3 Fail closed: when the story folders cannot be read at pickup, the rule fails the story instead of passing it, shown by a test against the real gate input path
- [x] #4 The Ready-mode gate gives the same result as before for every story (a Ready-mode test with a `.github/` reference still passes), and the scope-violation park after a run is unchanged
- [x] #5 ADR 0012 lists the new rule with its mode in the same PR
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-01 12:21 UTC
- Criteria met: 5 of 5 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 225,438 of 300,000 tokens
- Runs: 1; resumes: 2
- Parks: 2
  - 2026-11-01 09:08 UTC ambiguous-spec: Criterion 1 says a pickup refused by the new rule keeps the story Ready, but every pickup gate failure today moves it to Refined (`#toRefined` in work-run.ts, the path the existing DIPO-48 tests asse…
  - 2026-11-01 09:12 UTC ambiguous-spec: Approve the R31 wording for ADR 0012 section "3. The Ready gate" (DIPO-399): a pickup-only rule R31 that refuses a Ready story whose References name a path `protectedKind` protects, except a link, mo…
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
