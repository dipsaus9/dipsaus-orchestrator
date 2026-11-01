---
id: DIPO-413
title: Drop the JSON Schema dialect from the scan fallback's output schema
status: Refined
assignee: []
created_date: '2026-11-01 15:39'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/scan/answer.ts
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/test/scan/
  - packages/engine/test/workers/
priority: medium
type: bug
ordinal: 391000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo office infer` runs its AI fallback session to the end and gives a proposal, instead of failing on every run.

Found in the M1 hand-test wave of 2026-11-01 on the scratch office (binary 9c7d41238fbc). Two of two runs of `dipo office infer` failed with "The scan fallback's session failed … no result before exit 1". The session's events.ndjson says: `Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`. packages/engine/src/scan/answer.ts (`SCAN_ANSWER_JSON_SCHEMA`) passes zod's `$schema` key on, while workers/claude-cli/report-schema.ts strips it (about line 222). Fix: one function turns a zod schema into the JSON Schema a session gets, without `$schema`, and both use it; the strip in report-schema.ts moves there (0001). 0008.

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
- [ ] #1 The JSON Schema the scan fallback session gets has no `$schema` key, shown by a test
- [ ] #2 The scan fallback and the worker report schema get their JSON Schema from one function, and the separate strip in report-schema.ts is removed, shown by a test of that function
- [ ] #3 A failed scan fallback session shows the session's own error line in the `dipo office infer` refusal, not only "no result before exit 1", shown by a test
<!-- AC:END -->
