---
id: DIPO-221
title: End a path token run at a code span written right next to a word
status: Ready
assignee: []
created_date: '2026-10-19 23:02'
updated_date: '2026-10-20 07:59'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/gate/text.ts
  - packages/engine/test/gate/gate.test.ts
priority: medium
type: bug
ordinal: 221000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Ready gate's word match no longer hides a banned phrase written right before or after a code span, so a word glued to a code span that holds a file path is checked by R10 and R27.

Context: known limit from the delivery of DIPO-218. outsideCodeAndPaths in packages/engine/src/gate/text.ts masks code spans, then takes runs (RUN, /\S+/g) on the original text. In "Writes etc`a/b.ts` to the rows" the run is etc`a/b.ts`; without its closing backtick its last segment ends in .ts, so looksLikePath masks the whole run and etc passes R10. The test "masks code spans and path tokens in the original text" in packages/engine/test/gate/gate.test.ts uses etc`a/b`, which fails R10 only because a/b has no extension. The 0012 amendment of 2026-10-19 (DIPO-218) defines a path token as a run of non-whitespace characters that contains a slash and looks like a path, and a code span as the text between a pair of backticks on one line; this story reads a code span as its own token, never part of the run next to it.

```dipo
branch: "DIPO-221/code-span-ends-path-run"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) R10 fails Writes etc`a/b.ts` to the rows and Writes `a/b.ts`etc to the rows, and passes Writes `a/b.ts` to the rows and Writes src/etc.ts"
    - kind: "automated"
      check: "(unit) the DIPO-170 tests for an unclosed backtick and for works`x`well keep their results"
    - kind: "automated"
      check: "(unit) R27 matches task notes written right before a code span that holds notes/x.md"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 In packages/engine/src/gate/text.ts a code span ends a run: the runs checked for a path token are split at whitespace and at each code span, so a word written right before or after a code span is never part of a path token, and the comment of outsideCodeAndPaths says so
- [ ] #2 A backtick without a closing one on its line does not end a run, and the DIPO-170 tests for an unclosed backtick and for a code span between two words keep their results
- [ ] #3 Tests in packages/engine/test/gate/gate.test.ts show R10 failing for a banned phrase glued before and after a code span that holds a file path with an extension, and R27 matching a maintainer-step phrase glued before one; the existing test for a code span written right after a word keeps its R10 failure with its comment naming the new rule
<!-- AC:END -->
