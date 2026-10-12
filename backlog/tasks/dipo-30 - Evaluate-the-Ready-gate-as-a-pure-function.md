---
id: DIPO-30
title: Evaluate the Ready gate as a pure function
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:29'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-26
  - DIPO-29
references:
  - packages/engine/src/gate/
  - packages/engine/test/gate/
documentation:
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: high
type: feature
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine evaluates rules R01a or R01b and R02 to R26 over a story, the office's active tasks and office configuration in one pure function, and reports every failure with its exact message.

Context: the `ready` command is M3. In M0 the gate runs as the pickup re-check inside `work.run` (DIPO-48) and through a read-only check command (M0 breakdown decision D3, DIPO-15). Storing decisions, the `story.gate` read and `dipo gate` were split into DIPO-71 in the M0 review (DIPO-15). The thresholds, tier set, type list and banned phrases come from the `story.*` keys of office configuration (DIPO-26); R16 checks the tier against the office tier set, since `Tier` is an open enum in the contract (0005 amendment of 2026-10-12). References: 0012 section 3 (definitions, rule table, messages, two modes), R26 amendment from 0014 section 4.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-30/evaluate-ready-gate-as-pure-function"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) one passing fixture story and, per rule, one fixture that fails only that rule with the exact message."
    - kind: "automated"
      check: "(unit) multiple failures reported together; R10 word boundary cases; R14 cycle path."
    - kind: "automated"
      check: "(unit) thresholds and banned phrases taken from a non-default office configuration change the result."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `evaluateGate(input, mode)` is pure: no file, process, clock, database or model access, and the same input gives the same result.
- [ ] #2 Each rule R01a, R01b, R02 to R26 has its own function and returns the 0012 message prefixed with `ready <ID> failed <rule>:`.
- [ ] #3 All failures are returned, not only the first; the gate passes only with zero failures.
- [ ] #4 Character counts use NFC code points after trimming; word matches for R10 use the `\p{L}\p{N}` boundary, so a banned phrase never matches inside a longer word such as `fetch`.
- [ ] #5 R12 rejects a leading `/`, a `..` segment, `://`, whitespace, `* ? [ ]`, `.`, empty and any path under `backlog/`.
- [ ] #6 R14 reports the cycle path `<ID> -> … -> <ID>`.
- [ ] #7 R16 accepts exactly one tier from the office's `story.tiers`; R24 rejects every story with a non-code role, since no such role exists before M4.
- [ ] #8 R26 counts title, outcome, criteria, scope paths, test plan, resolved unknowns and extra instructions against `prompt.contractMax`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S15 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
