---
id: DIPO-41
title: Capture scrubbed Claude recordings for adapter tests
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-12 13:00'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-18
  - DIPO-40
references:
  - tools/recordings/
  - packages/engine/test/recordings/claude-cli/
  - packages/engine/test/fixtures/repos/
  - package.json
  - tsconfig.json
documentation:
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: task
ordinal: 41000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `bun run recordings:capture <scenario>` runs Claude with the adapter's own launch plan on a synthetic fixture repository, scrubs the stream with an allowlist, scans for secrets, and writes `stream.jsonl` and `meta.json`; the M0 scenarios are committed, captured live by the maintainer or derived in code.

Context: 0008 lists unverified CLI behaviour to record before the adapter parser (DIPO-42) and the self-test (DIPO-43) rely on it. Hook-based scenarios (`permission-wait`, `needs-permission`) are captured with DIPO-59. References: 0017 section 2 (format, replay rules, scenario table, capture steps, scrubbing allowlist, decision fields, report exemption, secret scan, storage and refresh, `recordings:status`); 0008 "Consequences" (live checks before the first adapter story).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-41/capture-scrubbed-claude-recordings"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) scrubber over a synthetic stream with a planted secret aborts; allowlisted fields survive; unknown type redacted whole."
    - kind: "automated"
      check: "(unit) secret scan and decision-field checks over all committed recordings."
    - kind: "manual"
      check: "maintainer runs `bun run recordings:capture success-single`"
      expect: "a new `stream.jsonl` with no redaction marker on `apiKeySource` and no home path in the diff."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Capture builds a fixture repository under a temp directory from `packages/engine/test/fixtures/repos/<name>`, never a real project.
- [x] #2 Capture runs the DIPO-40 launch plan plus `--include-partial-messages` and `--include-hook-events`, and holds the raw stream only in memory.
- [x] #3 The scrubber keeps exactly the fields listed under "kept as is" and redacts every other string as `[redacted sha256:<12 hex> len:<n>]`; an unknown message type is redacted whole and reported.
- [x] #4 Ids and paths are normalised to stable placeholders within a recording.
- [x] #5 A secret hit (`sk-ant-`, `ghp_`, `github_pat_`, AWS keys, `Bearer `, private key headers, the real home path) aborts the capture without writing.
- [x] #6 `derive.ts` produces `terminated`, `crash-truncated`, `crash-zeroed`, `init-rejected`, `start-failed`, `report-invalid`, `prompt-too-long`, `stall` and `budget-engine-cap` from live recordings.
- [x] #7 Live scenarios `success-single`, `success-tools-subagent`, `max-turns`, `permission-denied`, `interrupt`, `resume` and `worker-park-ambiguous` are committed, and `meta.json` carries version, flags, date, prompt size and hash.
- [x] #8 Unit tests over every committed recording assert no secret shape, no redacted decision field, and usage numbers equal to the checksum taken at capture.
- [x] #9 Implementation notes record the 0008 live checks: `--json-schema` per turn in streaming input, `priority: "now"` behaviour, `apiKeySource` on a claude.ai login, SIGINT behaviour in streaming input, `--max-turns` behaviour in streaming input, and, as a go/no-go check, whether the sandbox `denyWrite` on `<main>/.git` beats the shared-`.git` allowance of a linked worktree; if it does not, the notes say so and no story run is enabled until the maintainer revisits 0008 option (a).
- [x] #10 `bun run recordings:status` lists recordings whose `claude_code_version` differs from the local `claude --version`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S25 (DIPO-15). Before cutover: built by hand-run agents.

Live captures (2026-10-12), Claude Code 2.1.296 on the maintainer's claude.ai login, model haiku (claude-haiku-5-5), effort low, fixture `greeter` copied into a temp directory under DIPO_TMP as a main checkout plus a linked worktree. 11 live sessions (12 claude processes; `resume` is a pair). Retries: `success-single` once (tool-use ids used as object keys in `wire_tool_inputs` were not normalised; scrubber fixed, recaptured) and `safety-main-git` once (first run inconclusive, see below; kept as `safety-bash-prompts-none`). Every recording was grepped for the home path, user name, email, `sk-ant-`, `ghp_`, `github_pat_`, `Bearer `, AWS key shapes and private key headers before commit: no hits.

AC #9, 0008 live checks:
- `--json-schema` per turn in streaming input: holds. The CLI adds a `StructuredOutput` tool (listed in `system/init` tools); every completed turn's result carries `structured_output` (max-turns turn 2, pause-now turns 2 and 3, resume both processes). When the model answers in plain text, a synthetic user message follows and the model then calls `StructuredOutput`. Interrupted turns (`terminal_reason: aborted_streaming`) and `error_max_turns` results carry no `structured_output`. `system/init` is emitted again at the start of every turn.
- `priority: "now"` (recording `pause-now`): interrupts the running turn. That turn ends with a result `subtype: success`, `terminal_reason: aborted_streaming`, no report; the now-message runs as the next turn (`result_index` 1) in the same process. Because of `--json-schema` the pause turn ends with a report (the model returned `blocked` with a question), not with a bare `paused`. DIPO-42 should treat a report on a pause turn as expected.
- `apiKeySource` on a claude.ai login: `none` in every `system/init`.
- SIGINT in streaming input (recording `interrupt`): the turn ends with a result `subtype: error_during_execution`, `terminal_reason: aborted_streaming`, then the process exits by itself about 0.7 s later with exit code 0 and no signal, without reading more stdin. It does not stay alive for another message; a further turn needs `--resume`.
- `--max-turns` in streaming input (recording `max-turns`, `--max-turns 1`): the first message ends `error_max_turns` (`terminal_reason: max_turns`, `num_turns` 2); the process stays alive and the next queued message gets its own limit and completes `success`.
- GO/NO-GO, sandbox `denyWrite` on `<main>/.git` vs the shared-`.git` allowance of a linked worktree: HOLDS (go). Recording `safety-main-git`, checked on disk after the session: with the commands reaching the sandbox, writes to `<main>/.git/<file>`, `<main>/.git/worktrees/story/<file>`, `<main>/.git/refs/heads/<file>`, `git hash-object -w` (objects in the shared `.git`) and an append to the `<worktree>/.git` pointer all failed with "Operation not permitted"; a write outside the worktree also failed; the control write inside the worktree succeeded; the pointer was unchanged. Caveat: this shows the writes are blocked under the 0008 policy; it does not separately show which rule blocks them (denyWrite vs no allowance), and it is one run on macOS only.
- Finding that needs a maintainer decision (affects 0008 / DIPO-40, not this story's tooling): under the launch plan as it is, every Bash call was denied by the permission layer before the sandbox ran it (`system/permission_denied` with `decision_reason_type: asyncAgent`, `tool_result_meta` `non_execution_kind: permission-rule`), including `ls`-class commands and a write inside the worktree (recording `safety-bash-prompts-none`). 0008's "Bash needs no allow rule because sandboxed commands run without a prompt" does not hold on 2.1.296 with `--permission-prompts none`. The go/no-go run therefore added `permissions.allow += ["Bash"]` to the run settings file (recorded in its `meta.settings_patch`); deny rules and the sandbox still applied. The plan probably needs a Bash allow rule.
- Other observations for DIPO-42/43: `system/init` lists 3 plugins, 5 agents, 19 skills and user slash commands under `--setting-sources project,local`, so user-scope plugins appear to load (0008 expected them not to); `mcp_servers` is empty under `--strict-mcp-config`. `rate_limit_event` carries `rate_limit_info` with `status`, `resetsAt` (epoch seconds), `rateLimitType` (`five_hour`), `overageStatus` and `unifiedWindows.{five_hour,seven_day}.utilization` as a 0..1 fraction. `permission_denied` uses `decision_reason_type: asyncAgent`. Subagent runs emit `system/task_started`, `task_progress`, `task_notification`, plus `background_tasks_changed`, `thinking_tokens` and `task_updated`; the last three were redacted whole in `success-tools-subagent` (reported at capture) and are allowlisted for the next refresh.

Implementation: `tools/recordings/` holds the capture (`capture.ts`, `scenarios.ts`), the scrubber and normaliser (`scrub.ts`), the secret guard (`secrets.ts`), the usage checksum (`usage.ts`), `derive.ts`, `status.ts`, `refresh.ts` and their unit tests; `recordings.test.ts` runs the secret scan, the decision-field check, the usage checksum, the id check and the derive-is-current check over every committed recording. Root `tsconfig.json` includes `tools/recordings`. Scripts: `recordings:capture`, `recordings:derive`, `recordings:refresh`, `recordings:status`.

Deviations: extra live recordings `pause-now`, `safety-main-git`, `safety-bash-prompts-none`; extra derived variants `init-rejected-model`, `start-failed-auth`, `start-failed-billing`, `report-invalid-missing` (one directory per variant). `start-failed`'s `startup_failure_reason` value and the assistant `error` variants are illustrative and cited in `meta.cites`. `pause-now`'s kept `question` is model-written text, not fixture-controlled (report exemption); it holds no secret and passes the scan. `permission-wait` and `needs-permission` stay with DIPO-59 as the description says.
<!-- SECTION:NOTES:END -->
