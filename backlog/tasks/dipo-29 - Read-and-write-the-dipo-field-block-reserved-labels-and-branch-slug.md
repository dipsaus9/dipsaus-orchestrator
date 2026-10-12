---
id: DIPO-29
title: 'Read and write the dipo field block, reserved labels and branch slug'
status: Done
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 21:54'
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
  - packages/engine/src/backlog/runner.ts
  - packages/engine/src/backlog/index.ts
  - packages/engine/src/backlog/plain.ts
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
- [x] #1 The block parser accepts zero or one block opened by a line exactly ```` ```dipo ```` and closed by the next line exactly ```` ``` ````; a second block, an unclosed block or text after it is an R02 error.
- [x] #2 Block content is parsed through `platform/yaml.ts` and validated with the contract `FieldBlock` schema.
- [x] #3 Labels `tier:<T>`, `role:<name>` and `test-before-merge` are read from the label list; labels outside the grammar `[a-z0-9-]+(:[A-Za-z0-9-]+)?` are reported.
- [x] #4 The emitter writes fixed key order, double-quoted strings and two-space indent, and parse after emit returns the same value.
- [x] #5 The write path views, parses, changes the value, splices, writes with `task edit --description`, reads back and compares; a description changed since the read is parsed again and the change reapplied.
- [x] #6 Labels change only with `--add-label` and `--remove-label`.
- [x] #7 `slug(title)` follows the five steps of 0010 section 4 and returns `story` for an empty result; `branchFor(id, title)` matches R18.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S14 (DIPO-15). Before cutover: built by hand-run agents.

Added refs: packages/engine/src/backlog/runner.ts (AC6: the runner now refuses -l, --label, --labels and --clear-labels on task edit and draft edit, so labels change only with --add-label and --remove-label; tested in runner.test.ts) and packages/engine/src/backlog/index.ts (exports the new fields and slug modules).

Implementation: fields/block.ts holds the parser (locateBlock, parseFieldBlock; errors are FieldBlockError with rule R02 and a 1-based description line), the canonical emitter and the splice. fields/labels.ts reads tier, role and test-before-merge, returns every tier and role so the gate judges R16 and R17, and reports labels outside the grammar. fields/write.ts is the single write path (writeFields for task or draft, editLabels); it re-reads before writing, retries up to 3 times when the description changed, and compares the read back after trimming, since the CLI stores the description trimmed. Values compare by canonical emit, so an absent key equals a key set to undefined. slug.ts holds slug and branchFor. The per-worktree write queue is left to the callers (git queue, DIPO-31).

Review fixes: added ref packages/engine/src/backlog/plain.ts. parseView takes normalize: false, so the write path splices the description as the CLI printed it. NFC normalisation is only for parsing and comparing, so NFD text outside the block is written back byte for byte. A CRLF ending on the opening and closing lines counts as the line ending, and the splice keeps CRLF. A line that is ```dipo only after trimming other trailing whitespace fails R02, so a stale block is never shadowed by an appended one. The pinned CLI stores descriptions with LF endings, so the read back compares after turning CRLF into LF.

Every writeFields and editLabels call must go through the per-worktree serial git queue (DIPO-31); the caller (DIPO-34) owns that.

Review follow-up (optional): raise R02 for a near-miss block opener with leading whitespace or other case (`  ```dipo`, ````DIPO`). DIPO-34 review must check that the backlog lane wraps writeFields and editLabels in the per-worktree git queue.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
dipo field block, reserved labels and branch slug in packages/engine/src/backlog: block parser (one block, R02 with line for second, unclosed, trailing text or near-miss opener; CRLF handled), YAML through platform/yaml.ts and the contract FieldBlock schema; canonical emitter; byte-exact splice on the raw description with NFC only for parsing and comparing; one write path for tasks and drafts with re-read, reapply, up to 3 retries and read-back verification; labels only via --add-label/--remove-label with the runner refusing other label flags on edit; reserved label reader for tier, role and test-before-merge; slug and branchFor per 0010 section 4. Reviewer pass.
<!-- SECTION:FINAL_SUMMARY:END -->
