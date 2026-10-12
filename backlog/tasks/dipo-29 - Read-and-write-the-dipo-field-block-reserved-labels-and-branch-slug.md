---
id: DIPO-29
title: 'Read and write the dipo field block, reserved labels and branch slug'
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:52'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-20
  - DIPO-28
references:
  - packages/engine/src/backlog/fields/
  - packages/engine/src/backlog/slug.ts
  - packages/engine/test/backlog/
documentation:
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0012-story-standard.md
priority: high
type: feature
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine parses a story's `dipo` field block and reserved labels into typed fields, writes changes back through one canonical write path that leaves every other byte of the description unchanged, and computes the frozen branch slug.

Context: draft promotion (0010 section 5) is deferred to M3, where `refine` first calls it (M0 breakdown decision D7, DIPO-15). References: 0010 section 3 (labels, block format, parser, single write path), section 4 (slug algorithm); 0012 F10 to F16.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-29/read-write-dipo-field-block-reserved"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) parser cases (none, one, two, unclosed, trailing text, `answer: 5173`)."
    - kind: "automated"
      check: "(unit) splice keeps all bytes outside the block identical."
    - kind: "automated"
      check: "(unit) slug table including accents, stop words only, a 50-letter word and an empty title."
    - kind: "automated"
      check: "(integration) write a park record through the pinned CLI and read it back."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The block parser accepts zero or one block opened by a line exactly ```` ```dipo ```` and closed by the next line exactly ```` ``` ````; a second block, an unclosed block or text after it is an R02 error.
- [ ] #2 Block content is parsed through `platform/yaml.ts` and validated with the contract `FieldBlock` schema.
- [ ] #3 Labels `tier:<T>`, `role:<name>` and `test-before-merge` are read from the label list; labels outside the grammar `[a-z0-9-]+(:[A-Za-z0-9-]+)?` are reported.
- [ ] #4 The emitter writes fixed key order, double-quoted strings and two-space indent, and parse after emit returns the same value.
- [ ] #5 The write path views, parses, changes the value, splices, writes with `task edit --description`, reads back and compares; a description changed since the read is parsed again and the change reapplied.
- [ ] #6 Labels change only with `--add-label` and `--remove-label`.
- [ ] #7 `slug(title)` follows the five steps of 0010 section 4 and returns `story` for an empty result; `branchFor(id, title)` matches R18.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S14 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
