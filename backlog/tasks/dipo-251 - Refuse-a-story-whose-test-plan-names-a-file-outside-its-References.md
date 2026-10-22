---
id: DIPO-251
title: >-
  Add two Ready gate rules: test plan files inside the References, and
  security-sensitive stories
status: Refined
assignee: []
created_date: '2026-10-20 19:03'
updated_date: '2026-10-22 18:16'
labels:
  - 'tier:S'
  - cutover
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-238
  - DIPO-256
  - DIPO-285
  - DIPO-303
references:
  - CLAUDE.md
  - packages/engine/schema/office.schema.json
  - packages/engine/src/config/index.ts
  - packages/engine/src/config/load.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/src/gate/evaluate.ts
  - packages/engine/src/gate/input.ts
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/gate/store/
  - packages/engine/src/gate/text.ts
  - packages/engine/src/gate/types.ts
  - packages/engine/test/config/
  - packages/engine/test/gate/gate.test.ts
  - packages/engine/test/gate/store.test.ts
  - packages/engine/test/office/load.test.ts
priority: medium
type: enhancement
ordinal: 137300
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Ready gate fails a story when a path named in one of its test plan entries is covered by none of its References, and fails a story that adds or replaces a guard, a deny rule, a sandbox setting or a permission check without criteria for what the old barrier caught, the bypass forms and a fail-closed test against the real path; the planning guidance says the same.

Context: seen on 2026-10-20 in three M1 runs. DIPO-227's test plan asked for a daemon unit test while no packages/daemon test path was in its References, so the worker skipped it; DIPO-183's plan named the daemon setup call and the retention pass outside its References; DIPO-231's change broke tools/recordings/scenarios.ts, which was not in its References. The gate rules are in packages/engine/src/gate/rules.ts (R27 is the newest, R28 comes with DIPO-238) and listed in GATE_RULES in packages/engine/src/gate/types.ts. Path tokens are found in packages/engine/src/gate/text.ts (DIPO-218: a run of non-whitespace characters that contains a slash and starts with /, ~, ./ or ../, has a file extension on its last segment, or ends with /). The scope prefix rule (story standard, Scope): two paths collide when either is a prefix of the other on segment boundaries; R12 already checks that each Reference is a repo-relative path. A new rule is a dated 0012 section 3 note.

From DIPO-260: the maintainer's decision D8 of 2026-10-20 (answer A); dated 0012 section 3 note of 2026-10-20 (rule R30, checked by phrase lists like R27). The key names story.securityPhrases and story.securityCriteriaPhrases, their defaults, matching the title or Outcome, and failing once per missing part are this story's design choices (design choice, not a maintainer decision; the maintainer may change it before a run). The new office keys arrive in the next config version, as DIPO-188 added story.maintainerStepPhrases (packages/engine/src/config/load.ts, packages/engine/src/config/index.ts, packages/engine/schema/office.schema.json). DIPO-164 and DIPO-195 each took two to four blocking review rounds for bypasses the story never asked to test: DIPO-195 dropped the Bash(gh) deny rule while its new check missed `timeout` and `stdbuf` wrappers and a quoted `'<'`, which the old rule had caught (docs/research/2026-10-20-dipo-run-gaps.md section 3.5). The Ready gate rules are in packages/engine/src/gate/rules.ts (R27 matches office phrase lists, story.maintainerStepPhrases in packages/engine/src/config/schema.ts, as R10 matches) and listed in GATE_RULES in packages/engine/src/gate/types.ts; R29 comes with DIPO-251. The planning guidance of this repository is the Backlog section of CLAUDE.md. The same rule is drafted for the planning skill's story standard outside this repository.

```dipo
branch: "DIPO-251/gate-rules"
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
    - kind: "automated"
      check: "(unit) gate.test.ts: a story whose title or Outcome names a deny rule, a guard, a sandbox setting or a permission check fails R30 when its criteria lack each of the three required parts, once per missing part; with all three it passes; a story that names none gets no R30 failure"
    - kind: "automated"
      check: "(unit) config tests: story.securityPhrases and story.securityCriteriaPhrases have their defaults"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/engine/src/gate/rules.ts has a rule R29, evaluated in both modes after R28 and listed in GATE_RULES in packages/engine/src/gate/types.ts, that reads each automated test plan entry's check and fails the story once for each repo-relative path token (the path token rule of packages/engine/src/gate/text.ts) that no Reference covers under the prefix rule, with the reason `test plan entry #<n> names <path>, which no Reference covers; add it to the References or drop it from the plan`
- [ ] #2 The gate store (packages/engine/src/gate/store/) lists the base tree's file paths and passes them in GateInput (packages/engine/src/gate/input.ts), as part of the gate's cache key; a bare file name ending in `.test.ts` in an automated entry's check is covered when a Reference is a file of that name or a Reference directory holds a file of that name in that list, and an uncovered bare name fails R29 with the same reason
- [ ] #3 Manual test plan entries are exempt, and a covered token, a check with no path token or test file name, and a story with no test plan get no R29 failure; the other rules' failures and their order are unchanged
- [ ] #4 packages/engine/test/gate/gate.test.ts and packages/engine/test/gate/store.test.ts (the base tree list and the cache key) cover an uncovered path, the same path covered by a directory Reference, a bare test file name covered by a file Reference, covered by a directory and uncovered, a manual entry and a spike with no test plan
- [ ] #5 (from DIPO-260) The Backlog section of CLAUDE.md says that a story which adds or replaces a guard, a deny rule, a sandbox setting or a permission check lists in its criteria what the old barrier caught with a test for each, the bypass forms to test (wrappers, quoting, indirection, chaining), and a fail-closed test against the real path rather than a fake
- [ ] #6 (from DIPO-260) packages/engine/src/gate/rules.ts has a rule R30, evaluated in both modes after R29 and listed in GATE_RULES, that applies when the story's title or Outcome matches a phrase of story.securityPhrases, and fails it once for each of the three parts (old barrier, bypass forms, fail-closed against the real path) that no criterion matches through story.securityCriteriaPhrases, matched as R27 matches (design choice, not a maintainer decision; the maintainer may change it before a run)
- [ ] #7 (from DIPO-260) In the next office config version, packages/engine/src/config/schema.ts has story.securityPhrases (defaults: deny rule, guard, sandbox setting, permission check) and story.securityCriteriaPhrases with defaults for each of the three parts, loaded by packages/engine/src/config/load.ts and written to packages/engine/schema/office.schema.json (design choice, not a maintainer decision; the maintainer may change it before a run)
- [ ] #8 (from DIPO-260) packages/engine/test/gate/gate.test.ts packages/engine/test/office/load.test.ts and the config tests cover a story with all three parts, one missing each part, a story with no security phrase, and the defaults
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: References are a forecast; R29 becomes a forecast-quality check rather than a gate (0021 section 13).

2026-10-22: combined from DIPO-260 (maintainer, M1 speed-up)
<!-- SECTION:NOTES:END -->
