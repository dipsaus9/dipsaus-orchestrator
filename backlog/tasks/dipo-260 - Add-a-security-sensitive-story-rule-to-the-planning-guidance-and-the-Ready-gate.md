---
id: DIPO-260
title: >-
  Add a security-sensitive story rule to the planning guidance and the Ready
  gate
status: Refined
assignee: []
created_date: '2026-10-20 20:20'
updated_date: '2026-10-21 16:26'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-251
  - DIPO-256
  - DIPO-285
references:
  - CLAUDE.md
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/gate/types.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/test/gate/gate.test.ts
  - packages/engine/test/config/
  - packages/engine/src/config/load.ts
  - packages/engine/src/config/index.ts
  - packages/engine/schema/office.schema.json
  - packages/engine/test/office/load.test.ts
priority: medium
type: enhancement
ordinal: 137400
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a story that adds or replaces a guard, a deny rule, a sandbox setting or a permission check lists what the old barrier caught with a test for each, the bypass forms to test, and a fail-closed test against the real path; the planning guidance says so, and the Ready gate fails such a story that lacks them.

Context: the maintainer's decision D8 of 2026-10-20 (answer A); dated 0012 section 3 note of 2026-10-20 (rule R30, checked by phrase lists like R27). The key names story.securityPhrases and story.securityCriteriaPhrases, their defaults, matching the title or Outcome, and failing once per missing part are this story's design choices (design choice, not a maintainer decision; the maintainer may change it before a run). The new office keys arrive in the next config version, as DIPO-188 added story.maintainerStepPhrases (packages/engine/src/config/load.ts, packages/engine/src/config/index.ts, packages/engine/schema/office.schema.json). DIPO-164 and DIPO-195 each took two to four blocking review rounds for bypasses the story never asked to test: DIPO-195 dropped the Bash(gh) deny rule while its new check missed `timeout` and `stdbuf` wrappers and a quoted `'<'`, which the old rule had caught (docs/research/2026-10-20-dipo-run-gaps.md section 3.5). The Ready gate rules are in packages/engine/src/gate/rules.ts (R27 matches office phrase lists, story.maintainerStepPhrases in packages/engine/src/config/schema.ts, as R10 matches) and listed in GATE_RULES in packages/engine/src/gate/types.ts; R29 comes with DIPO-251. The planning guidance of this repository is the Backlog section of CLAUDE.md. The same rule is drafted for the planning skill's story standard outside this repository.

```dipo
branch: "DIPO-260/security-story-rule"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) gate.test.ts: a story whose title or Outcome names a deny rule, a guard, a sandbox setting or a permission check fails R30 when its criteria lack each of the three required parts, once per missing part; with all three it passes; a story that names none gets no R30 failure"
    - kind: "automated"
      check: "(unit) config tests: story.securityPhrases and story.securityCriteriaPhrases have their defaults"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Backlog section of CLAUDE.md says that a story which adds or replaces a guard, a deny rule, a sandbox setting or a permission check lists in its criteria what the old barrier caught with a test for each, the bypass forms to test (wrappers, quoting, indirection, chaining), and a fail-closed test against the real path rather than a fake
- [ ] #2 packages/engine/src/gate/rules.ts has a rule R30, evaluated in both modes after R29 and listed in GATE_RULES, that applies when the story's title or Outcome matches a phrase of story.securityPhrases, and fails it once for each of the three parts (old barrier, bypass forms, fail-closed against the real path) that no criterion matches through story.securityCriteriaPhrases, matched as R27 matches (design choice, not a maintainer decision; the maintainer may change it before a run)
- [ ] #3 In the next office config version, packages/engine/src/config/schema.ts has story.securityPhrases (defaults: deny rule, guard, sandbox setting, permission check) and story.securityCriteriaPhrases with defaults for each of the three parts, loaded by packages/engine/src/config/load.ts and written to packages/engine/schema/office.schema.json (design choice, not a maintainer decision; the maintainer may change it before a run)
- [ ] #4 packages/engine/test/gate/gate.test.ts packages/engine/test/office/load.test.ts and the config tests cover a story with all three parts, one missing each part, a story with no security phrase, and the defaults
<!-- AC:END -->
