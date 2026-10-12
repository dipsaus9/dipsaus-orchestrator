---
id: DIPO-40
title: Define the Worker contract and build the Claude CLI launch plan
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 09:32'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-20
  - DIPO-26
references:
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/workers/claude-cli/encode.ts
  - packages/engine/src/workers/claude-cli/report-schema.ts
  - packages/engine/test/workers/
documentation:
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: high
type: feature
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `engine/src/workers/types.ts` defines the adapter-neutral Worker contract, and the Claude CLI adapter's pure `plan()` produces the argv, allowlisted environment, run settings file (rules, sandbox, hooks off until DIPO-59), first stdin line and report schema of 0008.

Context: the capture tool (DIPO-41) runs Claude with this plan, so it comes first. `WorkerSpec.kind` is an open string so a later `session` run kind (a model session with no worktree or branch, for the M1 scan fallback, M3 interviews and M5 conversation) needs no contract change; M0 plans only `implement` (maintainer decision D12, DIPO-15). The `claude` path is the absolute one the daemon resolved at start (DIPO-70), so a launchd or systemd environment runs the same binary as the maintainer's shell. References: 0008 section 1 (interfaces), section 2 (launch flags, environment allowlist, tools and rules, sandbox block, absolute paths, `includeGitInstructions: false`, empty `attribution`), section 9 (tiers to caps); 0014 sections 1 and 5 (L1+L2 in `--append-system-prompt-file`, fixed tools, `--exclude-dynamic-system-prompt-sections`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-40/define-worker-contract-build-claude-cli"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) golden argv, environment and settings file for a sample spec per tier."
    - kind: "automated"
      check: "(unit) an `ANTHROPIC_API_KEY` in the daemon environment is absent from the plan's environment."
    - kind: "automated"
      check: "(unit) `encode` output for each op."
    - kind: "automated"
      check: "(unit) a spec with an unknown `kind` string type-checks and `plan` refuses it with an error naming the kind."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `WorkerAdapter`, `WorkerSpec`, `Caps`, `SteerOp`, `HostOp`, `WorkerEvent`, `WorkerReport` and `WorkerResult` match 0008 section 1, with `WorkerSpec.kind` an open string whose known values are `implement`, `review` and `session` (0008 amendment of 2026-10-12).
- [ ] #2 `plan(spec)` is pure and returns the 0008 section 2 argv, starting with the absolute `claude` path given in its input (never a bare name looked up on `PATH`), with `--session-id` or `--resume`, tier model and effort, `--max-turns`, `--permission-mode default --permission-prompts none`, `--setting-sources project,local`, `--strict-mcp-config` and `--json-schema`, and never `--max-budget-usd`, `--bare` or `--add-dir`.
- [ ] #3 The task message is the first stdin line and never appears in argv.
- [ ] #4 The environment holds only the allowlisted variables plus `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, `DIPO_RUN`, `DIPO_HOST_SOCKET`.
- [ ] #5 The run settings file holds the allow and deny rules of 0008 including the absolute `<main>` denies, `blockReadsOutsideWorkingDirectories: true`, the sandbox block with `failIfUnavailable`, `allowUnsandboxedCommands: false`, `strictAllowlist`, `credentials` entries and absolute paths only.
- [ ] #6 `plan` refuses a worktree root inside the main checkout.
- [ ] #7 `encode(op)` maps steer to a `priority: "next"` user message, pause and stop to `priority: "now"` messages, and stop to close stdin, SIGTERM after 10 s and SIGKILL after 30 s.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S24 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
