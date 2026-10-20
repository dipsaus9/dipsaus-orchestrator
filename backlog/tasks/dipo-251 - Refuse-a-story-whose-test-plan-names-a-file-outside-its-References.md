---
id: DIPO-251
title: Refuse a story whose test plan names a file outside its References
status: Refined
assignee: []
created_date: '2026-10-20 19:03'
updated_date: '2026-10-20 20:22'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-238
references:
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/gate/types.ts
  - packages/engine/src/gate/text.ts
  - packages/engine/test/gate/gate.test.ts
  - packages/engine/src/gate/input.ts
  - packages/engine/src/gate/evaluate.ts
priority: medium
type: enhancement
ordinal: 137300
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Ready gate fails a story when a path named in one of its test plan entries is covered by none of its References, so a worker is never asked for a test it may not write.

Context: seen on 2026-10-20 in three M1 runs. DIPO-227's test plan asked for a daemon unit test while no packages/daemon test path was in its References, so the worker skipped it; DIPO-183's plan named the daemon setup call and the retention pass outside its References; DIPO-231's change broke tools/recordings/scenarios.ts, which was not in its References. The gate rules are in packages/engine/src/gate/rules.ts (R27 is the newest, R28 comes with DIPO-238) and listed in GATE_RULES in packages/engine/src/gate/types.ts. Path tokens are found in packages/engine/src/gate/text.ts (DIPO-218: a run of non-whitespace characters that contains a slash and starts with /, ~, ./ or ../, has a file extension on its last segment, or ends with /). The scope prefix rule (story standard, Scope): two paths collide when either is a prefix of the other on segment boundaries; R12 already checks that each Reference is a repo-relative path. A new rule is a dated 0012 section 3 note.

```dipo
branch: "DIPO-251/gate-test-plan-paths"
unknowns:
  - q: "May the Ready gate get a new rule R29, recorded as a dated 0012 section 3 note: every repo-relative path token in a test plan entry's check must be covered by one of the story's References under the prefix rule, else the story fails with 'test plan entry #<n> names <path>, which no Reference covers; add it to the References or drop it from the plan'? (a) add R29 as written (recommended: three stories on 2026-10-20 had a plan their References could not deliver); (b) a warning only, no failure."
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): approved; the 0012 section 3 note of 2026-10-20 (DIPO-251) adds R29: a story fails when an automated test-plan entry's check names a path, or a bare *.test.ts file, that no Reference covers; a bare name is matched by file name under the References; manual entries are exempt."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) gate.test.ts: an automated entry naming packages/daemon/test/unit/x.test.ts with References that do not cover it fails R29 naming the entry and the path; with packages/daemon/test/ in the References it passes"
    - kind: "automated"
      check: "(unit) gate.test.ts: an automated entry naming the bare plan.test.ts passes when a Reference is packages/engine/test/workers/plan.test.ts or a Reference directory holds a file of that name, and fails otherwise"
    - kind: "automated"
      check: "(unit) gate.test.ts: a manual entry naming a path outside the References, a check with no path token or test file name, and a spike with no test plan get no R29 failure"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/engine/src/gate/rules.ts has a rule R29, evaluated in both modes after R28 and listed in GATE_RULES in packages/engine/src/gate/types.ts, that reads each automated test plan entry's check and fails the story once for each repo-relative path token (the path token rule of packages/engine/src/gate/text.ts) that no Reference covers under the prefix rule, with the reason `test plan entry #<n> names <path>, which no Reference covers; add it to the References or drop it from the plan`
- [ ] #2 A bare file name ending in `.test.ts` in an automated entry's check is covered when a Reference is a file of that name or a Reference directory holds a file of that name in the base tree the gate reads; an uncovered bare name fails R29 with the same reason
- [ ] #3 Manual test plan entries are exempt, and a covered token, a check with no path token or test file name, and a story with no test plan get no R29 failure; the other rules' failures and their order are unchanged
- [ ] #4 packages/engine/test/gate/gate.test.ts covers an uncovered path, the same path covered by a directory Reference, a bare test file name covered by a file Reference, covered by a directory and uncovered, a manual entry and a spike with no test plan
<!-- AC:END -->
