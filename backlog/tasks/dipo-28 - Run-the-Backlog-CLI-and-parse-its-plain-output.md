---
id: DIPO-28
title: Run the Backlog CLI and parse its plain output
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 21:31'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-18
  - DIPO-27
references:
  - packages/engine/src/backlog/
  - packages/engine/test/backlog/
  - packages/engine/test/fixtures/backlog-plain/
  - packages/engine/src/features.ts
documentation:
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0016-ci-release-and-versioning.md
priority: high
type: feature
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine runs only an allowlisted set of `backlog` subcommands, checks the CLI version is 1.53.x, and parses `task view`, `draft view`, `task list` and `draft list` `--plain` output into typed records, tested against recorded fixtures.

Context: the engine never reads task files directly, except `backlog/config.yml` for the status list. The version check is an office load step, so this story depends on DIPO-27's load-step seam (M0 review, DIPO-15). The pin stays 1.53.x (M0 review, D11; 0016 amendment of 2026-10-12). References: 0010 section 1 (version, never-run list, parser rules, errors), section 6 (`completed/` and archived not active), facts 1 to 7; 0012 "Facts about Backlog.md CLI".

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-28/run-backlog-cli-parse-its-plain-output"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) parser over each recorded fixture, including the fake section case."
    - kind: "automated"
      check: "(integration) create, edit and view a task through the pinned CLI in a copy of the Backlog fixture and compare the parsed record."
    - kind: "automated"
      check: "(unit) refused subcommands never spawn."
    - kind: "automated"
      check: "(unit) version `1.52.0` and `1.54.0` are refused with a notice that contains `bun add -g backlog.md@1.53.0`; `1.53.4` is accepted."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `backlog --version` is checked by an office load step registered through the DIPO-27 seam; a version outside 1.53.x refuses the office with a notice naming the version and the install command `bun add -g backlog.md@1.53.0`.
- [x] #2 The runner refuses `task complete`, `cleanup`, `task demote`, `doctor --fix`, `config set statuses` and any status `Draft` before spawning.
- [x] #3 A non-zero exit or a `not found` line is an error carrying the command and output.
- [x] #4 The parser requires `File:` on line 1 and `Task <ID> - <title>` on line 2, reads known header keys only, splits lists on `, `, takes dependencies from the first level of the dependency graph, and recognises sections only by known names followed by exactly 50 `-`.
- [x] #5 A repeated or out-of-order known section is a parse error reported as R02; unknown keys and sections are kept raw and logged.
- [x] #6 Text containing a line of 50 `-` is refused by the write path before calling the CLI.
- [x] #7 Fixtures recorded from Backlog.md 1.53.0 cover a task with every field, a draft, a list with `(ac: n/m)` counts, a fake section inside a description, and an unknown id.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S13 (DIPO-15). Before cutover: built by hand-run agents.

Implemented in packages/engine/src/backlog/: plain.ts (parser), runner.ts (allowlist, never-run list, write-path text guard, errors), version.ts (backlog.version load step), index.ts (backlogFeature), listed in features.ts with systemSpawn and `backlog` from PATH.
- 1.53 prints a blank line between `File:` and `Task <ID> - <title>`; the parser accepts exactly that one blank line.
- `not found` goes to stderr in 1.53; `draft view DRAFT-99` exits 0 with it, so the runner checks stderr lines, and bare stdout messages outside a view.
- An unknown `Name:` plus rule never starts a section (only known names do); it stays in the surrounding text and is reported raw through onUnknown and `unknown`.
- `Modified files:` is a trailer line after the notes, read off the end of the last of Definition of Done, Plan or Notes.
- Fixtures recorded by packages/engine/test/backlog/record-plain.ts against a temp copy of the fixture project; the pinned CLI runs as `bun node_modules/backlog.md/cli.js`, so tests need no node.
- The daemon's resolved tool path is not threaded into the feature (foreground.ts is outside References); the step uses `backlog` on the daemon PATH.

Follow-up for a later story: the daemon should pass its resolved backlog path (tools.paths.backlog) into backlogFeature instead of relying on `backlog` from PATH.
<!-- SECTION:NOTES:END -->
