---
id: DIPO-366
title: Give the lifecycle parity test its own temp DIPO_HOME
status: Refined
assignee: []
created_date: '2026-10-28 15:04'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies:
  - DIPO-351
references:
  - test/lifecycle-parity/
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
- [ ] #1 The lifecycle parity test builds its DIPO_HOME values under a fresh folder in DIPO_TMP instead of /tmp/x/state, and still compares the same platforms
- [ ] #2 A file at /tmp/x does not change the test's result
<!-- AC:END -->
