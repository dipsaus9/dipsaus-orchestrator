---
id: DIPO-217
title: Slim the context pack with directory summaries
status: Ready
assignee: []
created_date: '2026-10-19 15:12'
updated_date: '2026-10-19 20:58'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/context/
  - packages/engine/src/prompts/assemble.ts
  - packages/engine/test/context/
  - packages/engine/test/prompts/
priority: medium
type: enhancement
ordinal: 217000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the context pack of a worker's first message shows each scope directory as a short summary instead of every entry, and lists docs/decisions/ and the recording data under packages/engine/test/recordings/ only when the story names a file in them, so the pack is a fraction of its size today.

Context: on the DIPO-164 run the first message was 30,431 characters, of which 24,158 were the context pack. Its 17 scope directory items listed every entry, breadth first, up to DIRECTORY_ENTRIES_MAX = 200 each (packages/engine/src/context/default-provider.ts, size.ts), and took about 19,000 of those characters, among them docs/decisions/ (19 entries), packages/engine/test/recordings/claude-cli/ (60 of 111 entries, cut) and tools/recordings/. A scope file is already shown in full up to CONTEXT_ITEM_MAX (4,000 characters) and otherwise as its head with the 0014 cut marker (truncateHead); that rule stays and gets a pinning test. The about text of each item is rendered in packages/engine/src/prompts/assemble.ts (aboutItem). The base commit is in the ContextRequest (baseSha). The hidden directories are only docs/decisions/ and packages/engine/test/recordings/ (recording data); tools/recordings/ is code and keeps its summary like any other directory (maintainer, 2026-10-19). Implements the 0014 amendment of 2026-10-19 (DIPO-217, sections 2 and 4).

```dipo
branch: "DIPO-217/slim-context-pack"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a scope directory with 120 files shows the count and the 15 files changed most recently on the base, newest first"
    - kind: "automated"
      check: "(unit) docs/decisions/ and a directory under packages/engine/test/recordings/ in scope get no item unless the outcome or a criterion names a file in them, while tools/recordings/ gets its summary"
    - kind: "automated"
      check: "(unit) a fixture pack has a pinned character count"
    - kind: "automated"
      check: "(integration, real git) the git workspace orders a directory's files by their last commit on the base sha"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A scope directory item, and the parent listing of a new scope path, holds the number of files under the directory and at most 15 of them (a DIRECTORY_RECENT_MAX constant in packages/engine/src/context/size.ts), the ones whose last change on the request's baseSha is newest, newest first, ties and files with no commit on the base in name order; it no longer lists every entry
- [ ] #2 The Workspace in packages/engine/src/context/types.ts gains an optional method that orders files by their last commit on a given sha; gitWorkspace implements it with one git log call over the directory, and a workspace without it gives the files in name order
- [ ] #3 A scope directory that is docs/decisions or packages/engine/test/recordings, or lies under one of them, gets no context item unless the outcome or a criterion names a path inside it; then it gets the summary of the first criterion, and in both cases the scope section still names it. Every other directory, tools/recordings/ among them, gets the summary of the first criterion
- [ ] #4 A scope file stays in full up to CONTEXT_ITEM_MAX (4,000 characters) and is otherwise its head with the 0014 cut marker, and a test with a 10,000-character scope file shows the head and the marker
- [ ] #5 aboutItem in packages/engine/src/prompts/assemble.ts renders a directory item as scope directory, <n> files, <k> changed most recently on the base; DEFAULT_PROVIDER_VERSION becomes 2 and the golden task message in packages/engine/test/prompts/golden/ is updated
- [ ] #6 A test in packages/engine/test/context/ builds a fixture checkout with a 120-file scope directory, an unnamed docs/decisions/ with 20 files, an unnamed packages/engine/test/recordings/claude-cli/ with 60 files, a tools/recordings/ with 14 files and a 10,000-character scope file, shows tools/recordings/ as a summary item and the two unnamed directories with no item, and asserts the pack's usedChars equals one pinned number, so any growth of the pack fails it
<!-- AC:END -->
