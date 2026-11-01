---
id: DIPO-413
title: Drop the JSON Schema dialect from the scan fallback's output schema
status: Done
assignee: []
created_date: '2026-11-01 15:39'
updated_date: '2026-11-01 16:09'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/scan/answer.ts
  - packages/engine/src/scan/fallback.ts
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/workers/claude-cli/result.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/test/scan/
  - packages/engine/test/workers/
modified_files:
  - packages/engine/src/scan/answer.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/workers/claude-cli/result.ts
  - packages/engine/src/workers/json-schema.ts
  - packages/engine/test/workers/interpret.test.ts
  - packages/engine/test/workers/json-schema.test.ts
priority: medium
type: bug
ordinal: 391000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo office infer` runs its AI fallback session to the end and gives a proposal, instead of failing on every run.

Found in the M1 hand-test wave of 2026-11-01 on the scratch office (binary 9c7d41238fbc). Two of two runs of `dipo office infer` failed with "The scan fallback's session failed … no result before exit 1". The session's events.ndjson says: `Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`. packages/engine/src/scan/answer.ts (`SCAN_ANSWER_JSON_SCHEMA`, about line 54) passes zod's `$schema` key on, while workers/claude-cli/report-schema.ts `buildJsonSchema` strips it (about line 222). Fix: one function turns a zod schema into the JSON Schema a session gets, without `$schema`, and both use it; the strip in report-schema.ts moves there (0001). The refusal text is built in workers/claude-cli/result.ts (about line 77) and scan/fallback.ts `#failed`; interpret.ts reads no stderr, so the session's own error line has to come from its events. 0008.

```dipo
branch: "DIPO-413/scan-schema-dialect"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) the scan fallback's --json-schema carries no $schema key and comes from the same function as the worker report schema"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The JSON Schema the scan fallback session gets has no `$schema` key, shown by a test
- [x] #2 The scan fallback and the worker report schema get their JSON Schema from one function, and the separate strip in report-schema.ts is removed, shown by a test of that function
- [x] #3 A failed scan fallback session shows the session's own error line in the `dipo office infer` refusal, not only "no result before exit 1", shown by a test
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-01 16:03 UTC: verify-failing
- Detail: the report gate refused the done report 3 times (the loop cap is 3). Your report says done, but these automated test-plan entries are not done:
- Run: run_01M6BXDVZ1Q05NXYVD2VA6QT6A
- Criteria met: 3 of 3 (as the worker reported them)
- Loops: 3 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 73,717 of 300,000 tokens; 27 of 90 turns; 3 of 45 minutes
- Last good commit: dc151494ab17476fe43a0c2443e02e10276dba78

Resumed 2026-11-01 16:06 UTC; grants: +1 loop; note: Your work and tests are fine. Only the report was malformed: your last three StructuredOutput calls had no testPlan key; the test-plan list ended up as text inside another field. Report done again wi…
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-01 16:09 UTC
- Criteria met: 3 of 3 (as the worker reported them)
- Loops: 3; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 92,599 of 300,000 tokens
- Runs: 1; resumes: 1
- Parks: 1
  - 2026-11-01 16:03 UTC verify-failing: the report gate refused the done report 3 times (the loop cap is 3). Your report says done, but these automated test-plan entries are not done:
- Grants: 1
  - 2026-11-01 16:06 UTC +1 loop
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
