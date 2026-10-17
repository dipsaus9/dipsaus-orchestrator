---
id: DIPO-174
title: >-
  Make the reviewer flag tests that take expected values from the code under
  test
status: Refined
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-17 17:00'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-145
references:
  - packages/engine/src/prompts/
  - packages/engine/test/prompts/
priority: medium
type: feature
ordinal: 163000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo's reviewer reports a test that takes its expected values from the code it tests as a blocking test finding, so a weakened rule cannot pass review on tests that agree with it by construction.

Context: finding 13 of the DIPO-115 cutover. The parked Haiku draft of DIPO-105 kept its source code sound, but its tests took the field list from the rule under test, so a weakened rule still passed (the story was finished by hand in PR #160). DIPO-145 builds the reviewer prompt: the review L1 (prompts/contract/review.md, whose statements 0019 section 4 fixes) and the reviewer role (L2), both golden-tested. A finding of kind test blocks when it names an automated test-plan entry (testEntry, 0019 section 5). This story adds the check to the reviewer role text, so 0019 does not change. The plugin agent the maintainer's hand reviews use today lives outside this repository and is not changed here.

```dipo
branch: "DIPO-174/reviewer-flags-self-referential-tests"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(golden) the reviewer role text holds the self-referential test check"
    - kind: "manual"
      check: "(live) on the scratch repo, review a story whose new test imports the field list from the rule under test"
      expect: "the review report has a blocking finding of kind test naming that test-plan entry"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The reviewer role (L2) tells the reviewer to check each test the diff adds or changes for expected values read from the code under test (a constant, list or function of the module it tests) instead of written out in the test, and to report such a test as a blocking finding of kind test with the number of the automated test-plan entry it does not really check
- [ ] #2 The reviewer role's golden file is updated and its golden test passes; docs/decisions/0019-review-loop.md is not changed
<!-- AC:END -->
