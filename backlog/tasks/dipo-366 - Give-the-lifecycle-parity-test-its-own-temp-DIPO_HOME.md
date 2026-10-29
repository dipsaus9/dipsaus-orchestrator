---
id: DIPO-366
title: Give the lifecycle parity test its own temp DIPO_HOME
status: Done
assignee: []
created_date: '2026-10-28 15:04'
updated_date: '2026-10-29 19:51'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - test/lifecycle-parity/
modified_files:
  - test/lifecycle-parity/lifecycle-parity.test.ts
priority: medium
type: chore
ordinal: 346000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: test/lifecycle-parity no longer uses the fixed path /tmp/x/state, so a stray file at /tmp/x cannot fail it.

Found on 2026-10-28: a stray empty /tmp/x failed this test for three builders (lifecycle-parity.test.ts:194-195). Tests write temp files only under DIPO_TMP (0017).

```dipo
branch: "DIPO-366/parity-test-temp-home"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the parity test passes with a file present at /tmp/x"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The lifecycle parity test builds its DIPO_HOME values under a fresh folder in DIPO_TMP instead of /tmp/x/state, and still compares the same platforms
- [x] #2 The test touches no path outside DIPO_TMP (0017)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-29 19:51 UTC
- Criteria met: 2 of 2 (as the worker reported them)
- Loops: 1; CI attempts: 0
- Review rounds: 1, failed 0
- Budget used: 85,578 of 600,000 tokens
- Runs: 2; resumes: 0
- Parks: 1
  - 2026-10-29 09:26 UTC ambiguous-spec: Are the 10 failing tests on a clean main expected to fail in this box? Should I fix them (the 127 exit code points at a missing tool for the CI light-path script, and the other five need their own in…
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
