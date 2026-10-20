---
id: DIPO-245
title: >-
  Keep the launch self-test verdict and its approval evidence in the run
  directory
status: Refined
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 20:25'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-231
  - DIPO-250
  - DIPO-257
references:
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/src/workers/claude-cli/self-test.ts
  - packages/engine/test/workers/launch-checks.test.ts
  - packages/engine/test/workers/launch-fixtures.ts
priority: medium
type: enhancement
ordinal: 245000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after a launch, the run directory holds the self-test's verdict and evidence (probes, the two planned Bash calls and the approval call's evidence), so a passed or refused self-test can be read afterwards without debug logging.

Context: the live check of DIPO-231 on 2026-10-20: `dipo run DIPO-183` started, so the self-test with the approval call passed under the worker settings, but the run directory's self-test/ folder holds only claude-settings.json, report-schema.json and sandbox-closed-writes.json; the verdict and its evidence are not kept, so the pass could be read only from the fact that the run started. claudeLaunchChecks in packages/engine/src/workers/claude-cli/launch-checks.ts calls runSelfTest (packages/engine/src/workers/claude-cli/self-test.ts) and gets a report with verdict and evidence; a refusal goes into the adapter hold detail, a pass goes nowhere. The evidence may hold model-written commands (DIPO-230), so it goes into the run directory, which stays local and under retention, not into an event.

```dipo
branch: "DIPO-245/keep-self-test-report"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) launch-checks.test.ts: a passing self-test writes self-test/report.json with verdict ok and the approval evidence; a refused one writes the refusal verdict and its evidence"
    - kind: "automated"
      check: "(unit) launch-checks.test.ts: a report write that fails is logged as a warn and does not change the launch outcome"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After runSelfTest returns, claudeLaunchChecks writes `self-test/report.json` in the run directory with the verdict and the evidence the report holds, including the bash calls and the approval evidence, for a pass and for a refusal
- [ ] #2 A failure to write that file is logged as a warn naming the run and the path, and does not change whether the launch passes or is refused
- [ ] #3 Tests in packages/engine/test/workers/launch-checks.test.ts cover a passing self-test, a refused one and a failed write
<!-- AC:END -->
