---
id: DIPO-47
title: Assemble worker prompts from templates and story data
status: Done
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 08:27'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-40
  - DIPO-42
  - DIPO-46
references:
  - packages/engine/src/prompts/
  - packages/engine/src/db/migrations/
  - packages/engine/test/prompts/
documentation:
  - docs/decisions/0007-state-database.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: high
type: feature
ordinal: 47000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine renders the system file (L1 worker contract plus L2 built-in developer role) and the `implement` task message (L4 sections in the 0014 order) from logic-free templates and story data, enforces section and total budgets, and stores only hashes and sizes of each part.

Context: the review kind and L5 nudges come later (M1 and DIPO-60); verify feedback items are added here because DIPO-49 sends them. The contract-size backstop returns an error that DIPO-48 handles before the claim, like a failed pickup re-check (0014 section 4; M0 review, DIPO-15). The `worker_notes` table lives here because the handoff block is its first reader; teardown (DIPO-58) deletes its rows. References: 0014 sections 1 (layers, template rules), 2 (sections, precedence sentence, what is left out, report fields), 4 (budgets, never-truncated contract, R26 backstop, drop order), 5 (byte-stable L1+L2, deterministic render), 6 (handoff block), 7 (verify feedback evidence); 0007 section 4 (`prompt_parts`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-47/assemble-worker-prompts-from-templates"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) golden L1+L2 and L4; `DIPO_UPDATE_GOLDEN=1` regenerates them."
    - kind: "automated"
      check: "(unit) drop order and markers over a large fixture; a contract over the cap fails with `prompt.contractTooLarge`."
    - kind: "automated"
      check: "(engine) worker notes stored for a worktree appear in the next handoff block, cut at 1,500 characters."
    - kind: "automated"
      check: "(unit) feedback location parsing for tsc, oxlint and bun test samples."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Templates under `packages/engine/src/prompts/` hold named slots only; a test fails when a template contains a conditional or loop syntax.
- [x] #2 The rendered L1+L2 file is byte-identical for every story with the same role and engine version, and contains no id, date, path or count.
- [x] #3 The task message holds `context`, `inputs`, `dependencies`, `background`, `handoff`, `story`, `outcome`, `criteria`, `scope`, `test_plan`, `answers`, `instructions`, `feedback` in that order, each in its tag, each present only under its 0014 condition.
- [x] #4 Story contract sections are never truncated; `assembleContract(story)` measures them on their own, and over `prompt.contractMax` assembly fails with `prompt.contractTooLarge` naming the size and the limit; moving the story to Refined is DIPO-48.
- [x] #5 Over the total cap, sections drop in the order dependencies, background, context tail, inputs content, each with a marker.
- [x] #6 A verify feedback item holds the failing step and command, exit code, last 60 output lines and `file:line` locations parsed from tsc, oxlint and bun test output.
- [x] #7 A handoff block holds `git log --oneline <base>..HEAD`, `git diff --stat HEAD`, untracked files, criteria status, last verify result, open feedback and worker notes up to 1,500 characters.
- [x] #8 A migration adds `prompt_parts` and `worker_notes`; per run and agent the sha256, bytes and estimated tokens of each part are stored and no prompt text is; the `notes` of a worker report are stored per worktree in `worker_notes` and read back for the handoff block.
- [x] #9 Golden files cover the rendered L1+L2 and a sample L4 for a fixture story.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S31 (DIPO-15). Before cutover: built by hand-run agents.

Scope additions: packages/engine/src/db/schema.ts (registers migration 9 in MIGRATIONS; the migration list lives there, next to the referenced migrations directory).

Delivered: packages/engine/src/prompts/ (templates under contract/, roles/, task/, feedback/; renderSystemFile, assembleContract, assembleTaskMessage, verifyFeedback, gatherHandoff/renderHandoff, recordWorkerNotes/latestWorkerNotes/forgetWorkerNotes, promptParts/recordPromptParts), migration 0009 (prompt_parts, worker_notes), tests and golden files in packages/engine/test/prompts/.

Design choices: assembleContract(story, contractMax) measures the contract with the same count as R26 (contractCharacters) so gate and backstop agree, and throws ContractTooLargeError with code prompt.contractTooLarge (an engine error, not a contract error code; DIPO-48 consumes it). Templates are bundled with text imports, so the compiled binary carries them. prompt_parts stores parts system, task and task.<section>; tokens are estimated at 4 characters per token. worker_notes keeps one row per worktree and agent; the handoff reads the newest. The L1 contract holds no digits, so the notes cap is stated in words.
<!-- SECTION:NOTES:END -->
