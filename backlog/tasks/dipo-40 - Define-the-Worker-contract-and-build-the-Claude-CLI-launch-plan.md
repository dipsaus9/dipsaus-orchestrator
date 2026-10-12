---
id: DIPO-40
title: Define the Worker contract and build the Claude CLI launch plan
status: Done
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 12:35'
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
  - packages/engine/src/index.ts
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

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

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
- [x] #1 `WorkerAdapter`, `WorkerSpec`, `Caps`, `SteerOp`, `HostOp`, `WorkerEvent`, `WorkerReport` and `WorkerResult` match 0008 section 1, with `WorkerSpec.kind` an open string whose known values are `implement`, `review` and `session` (0008 amendment of 2026-10-12).
- [x] #2 `plan(spec)` is pure and returns the 0008 section 2 argv, starting with the absolute `claude` path given in its input (never a bare name looked up on `PATH`), with `--session-id` or `--resume`, tier model and effort, `--max-turns`, `--permission-mode default --permission-prompts none`, `--setting-sources project,local`, `--strict-mcp-config` and `--json-schema`, and never `--max-budget-usd`, `--bare` or `--add-dir`.
- [x] #3 The task message is the first stdin line and never appears in argv.
- [x] #4 The environment holds only the allowlisted variables plus `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, `DIPO_RUN`, `DIPO_HOST_SOCKET`.
- [x] #5 The run settings file holds the allow and deny rules of 0008 including the absolute `<main>` denies, `blockReadsOutsideWorkingDirectories: true`, the sandbox block with `failIfUnavailable`, `allowUnsandboxedCommands: false`, `strictAllowlist`, `credentials` entries and absolute paths only.
- [x] #6 `plan` refuses a worktree root inside the main checkout.
- [x] #7 `encode(op)` maps steer to a `priority: "next"` user message, pause and stop to `priority: "now"` messages, and stop to close stdin, SIGTERM after 10 s and SIGKILL after 30 s.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S24 (DIPO-15). Before cutover: built by hand-run agents.

Scope: added packages/engine/src/index.ts to References. The worker contract and the Claude CLI plan are exported from the engine entry because deep imports of package src are lint-banned (0004) and the capture tool (DIPO-41) and the worker host (DIPO-44) import them from outside the workers directory.

Implementation (DIPO-40):
- workers/types.ts: WorkerAdapter, WorkerSpec, Caps, SteerOp, HostOp, WorkerEvent, WorkerReport, WorkerResult and their helper types as in 0008 section 1. WorkerSpec.kind is the open string WorkerKind with known values implement, review, session (0008 amendment 2026-10-12, D12). PlanError for refusals.
- HostOp signal gains an optional afterMs (milliseconds after the first op of the encode call, sent only while the worker runs) so encode can express the stop timing of 0008 section 6 (SIGTERM at 10 s, SIGKILL at 30 s) as data.
- claude-cli/plan.ts: plan(spec, ctx) is pure. ClaudeLaunchContext carries what the spec does not: the absolute claude path the daemon resolved (DIPO-70), home, daemon env, office tool variables, main checkout, run dir, host socket, sandbox temp dir, optional office mcp.json, and the office sandbox keys. The adapter-level plan(spec) of WorkerAdapter binds this context per run (DIPO-74).
- plan refuses: a kind other than implement (error names the kind), hookRelay true (hooks off until DIPO-59), a non-UUID session id, a model or effort that reads as a flag, a relative path, a worktree inside the main checkout or containing it, and tool variables matching ANTHROPIC_*, CLAUDE_*, AWS_*, DIPO_*, GH_TOKEN, GITHUB_TOKEN, NPM_TOKEN.
- Git write verbs denied: the 0014 list (commit, push, checkout, switch, merge, rebase, reset, stash, worktree) plus add, am, cherry-pick, clean, mv, pull, restore, revert, rm, tag, update-ref; each command is denied bare and with arguments.
- The report schema is passed inline on --json-schema (the installed help documents a JSON string) and also written to report-schema.json in the run dir (0008 section 10). Settings file: claude-settings.json.
- encode: steer priority next, answer plain user message, pause priority now, stop priority now + closeStdin + SIGTERM 10 s + SIGKILL 30 s, kill SIGKILL at once.
- Golden files in packages/engine/test/workers/golden/ are rewritten with DIPO_UPDATE_GOLDEN=1; run bun run format:fix afterwards.

Claude Code CLI check (installed 2.1.296, read-only, no session started): -p, --input-format/--output-format stream-json, --verbose, --session-id, --resume, --model, --effort, --permission-prompts none, --tools, --settings, --setting-sources, --strict-mcp-config, --mcp-config, --exclude-dynamic-system-prompt-sections and --json-schema are in --help. --max-turns and --append-system-prompt-file are hidden options present in the binary. --help lists permission modes with manual in place of default; the binary's parser accepts default as well (manual is an alias of default), so --permission-mode default matches 0008. Settings keys used (includeGitInstructions, attribution.commit/pr, permissions.blockReadsOutsideWorkingDirectories, sandbox.failIfUnavailable, allowUnsandboxedCommands, network.strictAllowlist, credentials.files/envVars with mode deny) exist in the binary's settings schema. User message priority now/next/later is a top-level field.

Left to later stories: the neutral nudge op on SteerOp (DIPO-60 AC 5), hook registration and dipo hook (DIPO-59), probe (DIPO-43), interpret and result (DIPO-42), canResume (DIPO-51).

Review hardening (PR #30, fail closed, each with a unit test):
- Tool variables also refuse LD_*, DYLD_*, GIT_*, NODE_OPTIONS, BASH_ENV and ENV (they change how processes start or where git resolves).
- Bash denies also cover git branch, fetch, config, apply, submodule, symbolic-ref, notes and commit-tree, bare and with arguments. A code comment states that Bash rules match command text only and the sandbox denyWrite on <main>/.git and <worktree>/.git is the real boundary.
- plan refuses a workdir or tmpDir that is / or equals or contains home, and a runDir, systemFile or mcpConfig inside the workdir.
- plan refuses a mainCheckout or workdir holding * ? [ ] { } ( ) \ ! or control characters, because Claude Code documents no escaping for permission rules. Golden files updated.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Worker contract in workers/types.ts (0008 section 1, open WorkerKind incl. session, HostOp afterMs) and the Claude CLI launch plan: pure plan(spec, ctx) building argv, allowlisted env, claude-settings.json with the 0008 allow/deny rules, absolute main denies, sandbox block, credentials deny, no hooks; report schema; steer/answer/pause/stop/kill encoding. Fail-closed refusals for unsupported kinds, hook relay, worktree inside main, relative or rule-special paths, workdir at home or /, run files inside the worktree, flag-like values and dangerous tool variables. Flags checked read-only against Claude Code 2.1.296. Reviewer pass.
<!-- SECTION:FINAL_SUMMARY:END -->
