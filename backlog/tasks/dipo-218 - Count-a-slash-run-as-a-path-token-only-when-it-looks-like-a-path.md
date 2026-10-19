---
id: DIPO-218
title: Count a slash run as a path token only when it looks like a path
status: Done
assignee: []
created_date: '2026-10-19 15:12'
updated_date: '2026-10-19 21:54'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/gate/text.ts
  - packages/engine/test/gate/
priority: medium
type: bug
ordinal: 218000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the Ready gate treats a run of characters with a slash as a path token only when it looks like a path, so prose such as TBD/later or and/or,etc is checked by R10 and R27 again.

Context: DIPO-170 masked every path token before R10 matched a banned phrase, and R27 matches the same way (wordMatch in packages/engine/src/gate/text.ts). A path token is any run of non-whitespace characters that contains a slash (PATH_TOKEN, used by outsideCodeAndPaths), so prose with a slash hides a banned phrase. Implements the 0012 amendment of 2026-10-19 (DIPO-218), which amends the DIPO-170 line. A read-only sweep on 2026-10-19 ran the Ready gate with the tightened rule over all 47 Refined and Ready stories in backlog/tasks: no R10 or R27 failure was added. The one R27 failure found (DIPO-169, criterion 1, by the maintainer) fails under the current rule too.

```dipo
branch: "DIPO-218/path-token-looks-like-a-path"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) R10 fails TBD/later etc and and/or,etc, and passes /etc/zprofile, ~/etc/x, ./etc/x, ../etc/x, packages/etc/, src/etc.ts and (src/etc.ts),"
    - kind: "automated"
      check: "(unit) R27 matches a maintainer-step phrase inside a slash run that does not look like a path"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 In packages/engine/src/gate/text.ts a path token is a run of non-whitespace characters that contains a slash and either starts with /, ~, ./ or ../, or ends with /, or has a file extension (a dot followed by letters or digits) at the end of its last segment; brackets and quotes around the token and sentence punctuation at its end (. , ; : ! ? and a closing bracket) are not part of it for this check
- [x] #2 outsideCodeAndPaths masks only such path tokens and code spans, so a banned phrase in a slash run that does not look like a path is matched by R10 and R27
- [x] #3 Tests in packages/engine/test/gate/ show R10 failing for `Writes TBD/later etc`, `Writes and/or,etc` and `Writes etc/zprofile`, and passing for `/etc/zprofile`, `/etc/zprofile,` (with a comma), `~/etc/x`, `./etc/x`, `../etc/x`, `packages/etc/`, `src/etc.ts` and `(src/etc.ts)`; the DIPO-170 tests for `Writes the file at etc/zprofile` and for a code span written right after a word now expect an R10 failure
- [x] #4 A test shows R27 matching `task notes` in `Write the task notes/later` and not in `Write the task notes/x.md`, where `notes/x.md` is a path token
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5B1KVQT60P9Z801P8SDX2JC (Haiku, 15 turns, about $0.01, 3 min) reported done, In Review, with no denied call and no write outside the References. looksLikePath in gate/text.ts masks a slash run only when it starts with /, ~, ./ or ../, ends in /, or its last segment has an extension, after removing surrounding brackets, quotes and trailing punctuation (0012 amendment of 2026-10-19); `~x` counts as starting with ~ and a backtick counts as a quote, both within the ADR wording. Prose like etc/zprofile, TBD/later and and/or is matched again; the DIPO-170 tests hold. Fixed on top after review (blocking): a test for the criterion's own input `Writes etc/zprofile`, and a corrected test comment. Known limit, filed as a gap candidate: a code span glued to a word joins its run, so `etc` followed by a code span holding a file name is still masked. Verify outside the sandbox: 3704 tests, 0 fail; DIPO_TEST_CI=1 gate tests pass.
<!-- SECTION:NOTES:END -->
