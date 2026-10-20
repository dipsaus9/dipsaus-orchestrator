---
id: DIPO-251
title: Refuse a story whose test plan names a file outside its References
status: To Do
assignee: []
created_date: '2026-10-20 19:03'
updated_date: '2026-10-20 19:03'
labels:
  - 'tier:S'
  - cutover
  - needs-info
milestone: m-1
dependencies:
  - DIPO-238
references:
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/gate/types.ts
  - packages/engine/src/gate/text.ts
  - packages/engine/test/gate/gate.test.ts
priority: medium
type: enhancement
ordinal: 251000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Ready gate fails a story when a path named in one of its test plan entries is covered by none of its References, so a worker is never asked for a test it may not write.

Context: seen on 2026-10-20 in three M1 runs. DIPO-227's test plan asked for a daemon unit test while no packages/daemon test path was in its References, so the worker skipped it; DIPO-183's plan named the daemon setup call and the retention pass outside its References; DIPO-231's change broke tools/recordings/scenarios.ts, which was not in its References. The gate rules are in packages/engine/src/gate/rules.ts (R27 is the newest, R28 comes with DIPO-238) and listed in GATE_RULES in packages/engine/src/gate/types.ts. Path tokens are found in packages/engine/src/gate/text.ts (DIPO-218: a run of non-whitespace characters that contains a slash and starts with /, ~, ./ or ../, has a file extension on its last segment, or ends with /). The scope prefix rule (story standard, Scope): two paths collide when either is a prefix of the other on segment boundaries; R12 already checks that each Reference is a repo-relative path. A new rule is a dated 0012 section 3 note.

```dipo
branch: "DIPO-251/gate-test-plan-paths"
unknowns:
  - q: "May the Ready gate get a new rule R29, recorded as a dated 0012 section 3 note: every repo-relative path token in a test plan entry's check must be covered by one of the story's References under the prefix rule, else the story fails with 'test plan entry #<n> names <path>, which no Reference covers; add it to the References or drop it from the plan'? (a) add R29 as written (recommended: three stories on 2026-10-20 had a plan their References could not deliver); (b) a warning only, no failure."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) gate.test.ts: a story whose test plan names packages/daemon/test/unit/x.test.ts with References that do not cover it fails R29 naming the entry and the path; the same story with packages/daemon/test/ in its References passes"
    - kind: "automated"
      check: "(unit) gate.test.ts: a check that names a directory covered by a Reference, a test plan with no path token, and a spike with no test plan get no R29 failure"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/engine/src/gate/rules.ts has a rule R29, evaluated in both modes after R28 and listed in GATE_RULES in packages/engine/src/gate/types.ts, that finds the repo-relative path tokens in each test plan entry's check with the path token rule of packages/engine/src/gate/text.ts and fails the story once per token that no Reference covers under the prefix rule, with the reason `test plan entry #<n> names <path>, which no Reference covers; add it to the References or drop it from the plan`
- [ ] #2 A token covered by a Reference, a check with no path token, and a story with no test plan get no R29 failure, and the other rules' failures and their order are unchanged
- [ ] #3 packages/engine/test/gate/gate.test.ts covers an uncovered file path, the same path covered by a directory Reference, a covered directory, a check with no path token and a spike with no test plan
<!-- AC:END -->
