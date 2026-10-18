---
id: DIPO-170
title: Keep the Ready gate's vague-phrase rule out of paths and code spans
status: Ready
assignee: []
created_date: '2026-10-17 16:59'
updated_date: '2026-10-18 10:03'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/gate/text.ts
  - packages/engine/src/gate/rules.ts
  - packages/engine/test/gate/
  - docs/decisions/0012-story-standard.md
priority: medium
type: bug
ordinal: 159000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a criterion that names a file path or a backticked code span passes R10 when a banned phrase appears only inside that path or span, and the same phrase in the criterion's prose still fails R10.

Context: finding 2 of the DIPO-115 cutover. `dipo gate DIPO-107` failed R10 with `criterion #1 contains vague phrase "etc"` on the path /etc/zprofile. wordMatch in packages/engine/src/gate/text.ts counts any character outside \p{L}\p{N} as a word boundary, as 0012 section 3 defines the word match, so "/" is a boundary and every criterion that names a path under /etc fails. PR #154 reworded the DIPO-107 criterion as a workaround.

Definitions for this story: a path token is a run of non-whitespace characters that contains a slash; a code span is the text between a pair of backticks on one line. Changing the match changes 0012 section 3 (the word match line and the R10 row), so it needs a dated 0012 note; the maintainer approved it on 2026-10-18 and it is in docs/decisions/0012-story-standard.md (Amendments, 2026-10-18, DIPO-170). This story does not edit docs/decisions/.

```dipo
branch: "DIPO-170/r10-skip-paths-and-code-spans"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) R10 passes a criterion that names /etc/zprofile plainly and in backticks, and fails one that also says etc in its prose"
    - kind: "automated"
      check: "(unit) the existing word-match cases (etc against fetch, properly against improperly) give the same results"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 R10 ignores a banned phrase whose match lies inside a code span or inside a path token, and still fails a criterion where the same phrase also appears outside them, with the message `criterion #<n> contains vague phrase "<phrase>"`
- [ ] #2 wordMatch gives the same results as today for text without a slash or a backtick: the existing word-match tests in packages/engine/test/gate/ pass unchanged
- [ ] #3 Unit tests in packages/engine/test/gate/ cover a phrase inside a path token, inside a code span, next to a path but outside it, and an unclosed backtick, with the expected results written out in the test
- [ ] #4 The behaviour matches the 0012 note of 2026-10-18 (DIPO-170): a banned phrase only inside a path token or a code span passes R10, the same phrase in prose fails it
<!-- AC:END -->
