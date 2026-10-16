---
id: DIPO-113
title: Enforce no import cycles and the worker adapter seam with lint rules
status: Done
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-10-16 12:27'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - .oxlintrc.json
  - test/lint-boundaries
  - tools/lint
  - packages/engine/src/run/launch.ts
  - packages/engine/src/worktree/files.ts
  - packages/engine/src/workers/
  - packages/daemon/src/runs.ts
  - packages/engine/test/
  - packages/engine/src/run/resume.ts
  - packages/engine/src/worktree/setup.ts
priority: medium
type: chore
ordinal: 103000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the two engine seams M0 relies on, the adapter-neutral worker port and Bun only in platform/, are enforced by verify instead of by review, and runtime import cycles fail lint.

Context: Claude adapter code leaked outside workers/ twice in M0: packages/engine/src/run/launch.ts imports WORKER_REPORT_JSON_SCHEMA from workers/claude-cli/report-schema, and packages/engine/src/worktree/files.ts imports LOCAL_SETTINGS_FILE and stripLocalSettings from workers/claude-cli/settings-check. .oxlintrc.json bans claude-cli imports only in hooks/, and oxlint 1.87's import/no-cycle is off although it gives 0 diagnostics today. M1 adds the review run kind to exactly this code. Found by the 2026-10-16 milestone review (section 1b V1, V2, V10; suggestion 5).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 import/no-cycle (ignoreTypes true) is on in .oxlintrc.json and proven by a fixture in test/lint-boundaries/.
- [x] #2 A lint rule or import test allows workers/claude-cli/** imports only from engine/src/workers/** and the engine entry, and bun and bun:sqlite imports only from engine/src/platform/**, each proven by a fixture.
- [x] #3 The report schema and the local settings file name and strip function reach run/launch.ts and worktree/files.ts through the worker port, not adapter imports; behaviour is unchanged.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
import/no-cycle (ignoreTypes) on in .oxlintrc.json, proven by test/lint-boundaries/lint-cycles.test.ts (runtime cycle fails, type-only cycle passes; 0 diagnostics on the repo). New local oxlint rules dipo/no-claude-cli-import (on for engine/src, off for engine/src/workers/** and engine/src/index.ts) and dipo/no-bun-import (bun and bun:* except bun:test; off for engine/src/platform/**), proven by lint-engine-seams.test.ts; no existing bun imports outside platform/. WorkerPort gains reportSchema and localSettings ({ file, strip }); runWorkerSpec takes the port's schema and placeFiles takes the port's local settings copy through SetupDeps, so run/launch.ts and worktree/files.ts import no adapter module. Behaviour unchanged (existing files and launch tests pass unchanged with the Claude values). Also touched run/resume.ts and worktree/setup.ts (outside References) to pass the port values through. No live runs.
<!-- SECTION:NOTES:END -->
