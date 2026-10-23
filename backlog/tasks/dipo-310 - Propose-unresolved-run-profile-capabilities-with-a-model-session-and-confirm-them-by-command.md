---
id: DIPO-310
title: >-
  Propose unresolved run profile capabilities with a model session and confirm
  them by command
status: Done
assignee: []
created_date: '2026-10-22 20:56'
updated_date: '2026-10-23 15:17'
labels:
  - 'tier:L'
  - 'slice:m1b'
milestone: m-1
dependencies:
  - DIPO-158
references:
  - packages/cli/src/index.ts
  - packages/cli/src/profile-commands.test.ts
  - packages/cli/src/profile-commands.ts
  - packages/contract/schema/commands.schema.json
  - packages/contract/schema/events.schema.json
  - packages/contract/schema/reads.schema.json
  - packages/contract/schema/work.schema.json
  - packages/contract/src/catalog.ts
  - packages/contract/src/errors.ts
  - packages/contract/src/fixtures.ts
  - packages/contract/src/index.test.ts
  - packages/contract/src/index.ts
  - packages/contract/src/office.ts
  - packages/contract/src/profile.ts
  - packages/contract/src/software.ts
  - packages/contract/src/version.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/src/runs.ts
  - packages/engine/schema/office.schema.json
  - packages/engine/src/config/index.ts
  - packages/engine/src/config/load.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/index.ts
  - packages/engine/src/prompts/contract/scan.md
  - packages/engine/src/prompts/roles/scanner.md
  - packages/engine/src/prompts/task/scan.md
  - packages/engine/src/prompts/templates.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/run/compose.ts
  - packages/engine/src/run/index.ts
  - packages/engine/src/run/session-run.ts
  - packages/engine/src/scan/answer.ts
  - packages/engine/src/scan/confirm-command.ts
  - packages/engine/src/scan/confirm.ts
  - packages/engine/src/scan/evidence-read.ts
  - packages/engine/src/scan/evidence.ts
  - packages/engine/src/scan/fallback.ts
  - packages/engine/src/scan/feature.ts
  - packages/engine/src/scan/index.ts
  - packages/engine/src/scan/marks.ts
  - packages/engine/src/scan/profile-view.ts
  - packages/engine/src/scan/request.ts
  - packages/engine/src/scan/store.ts
  - packages/engine/src/views/desk.ts
  - packages/engine/src/workers/claude-cli/adapter.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/src/workers/claude-cli/result.ts
  - packages/engine/src/workers/claude-cli/schema.ts
  - packages/engine/src/workers/port.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/test/config/load.test.ts
  - packages/engine/test/config/schema.test.ts
  - packages/engine/test/office/load.test.ts
  - packages/engine/test/prompts/task.test.ts
  - packages/engine/test/run/session-run.test.ts
  - packages/engine/test/scan/answer.test.ts
  - packages/engine/test/scan/confirm.test.ts
  - packages/engine/test/scan/evidence.test.ts
  - packages/engine/test/scan/fallback-office.test.ts
  - packages/engine/test/scan/fallback.test.ts
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/session-plan.test.ts
  - packages/engine/src/db/migrations/0054-scan-confirmations.ts
priority: medium
type: feature
ordinal: 295000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an office whose repository does not follow the script standard gets a proposed command for each capability code could not resolve, and the maintainer accepts, edits, rejects or sets each one by command, so `run` and the test command can work without the repository changing first.

Context: follows 0013 section 2 (levels; `run` refuses an unresolved verify, the test command an unresolved install or `dev`), section 3 (sources and confidence; conflicts never resolved silently), section 4 (the profile holds source, confidence and confirmation; confirmations are the only part a lost database cannot rebuild), section 5 (AI and maintainer capabilities are marked stale on a fingerprint change, never refreshed silently) and section 6 (the fallback: only for unresolved or conflicting capabilities, an evidence bundle built by code, one structured request, schema and existence checks, pending proposals are never executed, accept, edit, reject or set by hand, report which deviations a rename would remove), the 0013 and 0003 amendments of 2026-10-11 (the fallback and confirm command move to M1), the 0008 and 0007 amendments of 2026-10-12 (run kind `session`: no worktree or branch, usage under the office), and 0019 section 12 ("session runs get their own capacity rule with the M1b scan fallback"). Code drives: the fallback never runs for a capability code resolved. Today `packages/engine/src/scan/` detects by code only, `run_capabilities` has the `confirmed`, `pending` and `stale` columns unused, `detect` takes a `nothingToStart` option nothing sets, and no read lists the profile. The evidence bundle may hold instructions in README or `CLAUDE.md` text; the session has no tools, its answer is validated by schema, and nothing it proposes runs until confirmed.

The maintainer answered this story's questions on 2026-10-22 by accepting the recommended answers. They are in the unknowns below and in the 0013, 0019 and 0021 amendments of that day. The TUI desk shows the profile rows through its `cli` line for unbound actions; TUI keys for them come with a later TUI story.

```dipo
branch: "DIPO-310/scan-fallback-confirm"
unknowns:
  - q: "Q12. When the fallback runs: on the maintainer's command only, or automatically after a scan that leaves a required capability unresolved."
    status: "resolved"
    answer: "Only when the maintainer asks: a command plus dipo office infer. The run and test-command refusals and the desk name that command. Never automatic. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q13. The fallback session's model, effort and caps, and where they are configured."
    status: "resolved"
    answer: "A new office key block scan in .dipo/office.yaml (next config version): model sonnet, effort low, budgetTokens 100000, maxMinutes 5, one turn plus one schema retry. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q14. The capacity rule for session runs that 0019 section 12 leaves to this story."
    status: "resolved"
    answer: "One session run per office at a time, outside both places. Plan-limit holds apply to it (it waits, never parks). Its tokens count in the office's usage and in spend alerts. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q15. Where the fallback session runs: on the Mac with no tools, or in a box."
    status: "resolved"
    answer: "On the Mac with no box, with every tool off (no read, shell or web), as the reviewer runs without a box (0021 section 10), and the evidence built by code from dipo's base copy. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q16. What a stale confirmation means for run and the test command."
    status: "resolved"
    answer: "A stale confirmed capability keeps working (run and the test command use it) and stays on the desk until it is confirmed again. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q17. Whether the TUI gets accept and reject keys for profile rows in this story."
    status: "resolved"
    answer: "In this story the contract command and the CLI; the TUI desk shows each profile row with its cli line. TUI keys come with a later TUI story. (maintainer, 2026-10-22: accepted the recommended answers)"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the Claude launch plan for a session run has no worktree, no box, every tool off, the fallback schema and the model, effort and caps of the office scan block, with the defaults sonnet, low, 100000 budget tokens and 5 minutes"
    - kind: "automated"
      check: "(unit) the evidence bundle from a fixture base copy holds the 0013 section 6 items within the size budget, names env files without contents, and asks only for unresolved or conflicting capabilities"
    - kind: "automated"
      check: "(unit) a fake session answer with a missing script, a missing file or a schema error is dropped with a notice; a valid answer is stored pending, inferred, low; run and setup refuse to execute a pending command"
    - kind: "automated"
      check: "(unit) the fallback starts only on the infer command and never after a scan; a second fallback in the same office waits while one runs; a plan-limit hold makes it wait and never park"
    - kind: "automated"
      check: "(unit) accept, edit, reject, set, pick a conflict candidate and nothing-to-start each give the source and confirmed flag 0013 section 6 names, recompute the run refusal and emit scan.finished with a diff"
    - kind: "automated"
      check: "(unit) a rescan with an unchanged fingerprint keeps confirmations; a changed fingerprint marks them stale, and a stale confirmed capability is still used by run and stays on the desk; a capability code now resolves replaces its confirmation with a diff line"
    - kind: "automated"
      check: "(unit, cli) dipo office profile prints each capability with source, confidence, confirmed, pending and stale, and the deviations with their fix"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Claude adapter plans a `session` run on the Mac with no box: no worktree, branch or story key, every tool off (no read, shell or web), the structured-output schema of the fallback, and the model, effort and caps of a new office key block `scan` in `.dipo/office.yaml` at the next office configuration version (defaults: model `sonnet`, effort `low`, `budgetTokens` 100000, `maxMinutes` 5, one turn plus one schema retry); its usage is stored under the office
- [x] #2 At most one session run per office runs at a time, outside the worker and reviewer places; plan-limit holds apply to it, so it waits and never parks; its tokens count in the office's usage
- [x] #3 Pure code builds the evidence bundle from dipo's base read copy as 0013 section 6 lists it (file tree to depth 2 without dependency, build and worktree folders, manifests, Makefile or justfile, the install and run sections of README and `CLAUDE.md`, CI `run:` steps, `.claude/backlog-workflow.json`, env file names), within a size budget, never with env file contents; the request names only the unresolved or conflicting capabilities
- [x] #4 The answer is checked against the schema and against the base copy (a referenced script or file must exist); an answer that fails is dropped with an `engine.notice` that names the check; each valid proposal is stored pending with source `inferred`, confidence `low` and its evidence, and `run`, setup and the test command never execute a pending command
- [x] #5 The fallback starts only when the maintainer asks, through a contract command and `dipo office infer`, never automatically; the `run` and test-command refusals and the desk name that command
- [x] #6 A read lists the office's current profile: per capability its status, command and working directory, source, confidence, confirmed, pending proposal with its evidence, stale, and conflict candidates, plus the deviations with the standard script that would remove each; `dipo office profile` prints it
- [x] #7 A command accepts, edits or rejects a proposal, sets a capability by hand, picks one candidate of a conflict, and marks the product as having nothing to start; accept gives source `inferred`, edit and set give `maintainer`, both confirmed; it writes only the database, recomputes the `run` refusal, and emits `scan.finished` with the diff; the CLI form is `dipo office confirm` with the subcommands this story names (design choice)
- [x] #8 A rescan carries confirmed capabilities into the new profile; on a fingerprint change they are marked stale, and a stale confirmed capability keeps working for `run` and the test command until it is confirmed again; a capability code now resolves replaces its confirmation, with a diff line
- [x] #9 The desk lists each pending proposal and each stale confirmation as a hand-action row with its `dipo office confirm` line; this story adds no TUI keys for those rows
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (all 9 criteria met; its advisories are fixed: a running session is stopped at daemon stop, an unread Makefile drops its proposal, a stale proposal cannot be accepted)
<!-- SECTION:NOTES:END -->
