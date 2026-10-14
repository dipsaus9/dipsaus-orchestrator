---
id: DIPO-59
title: Relay Claude hooks and ask the maintainer for permissions
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-14 21:09'
labels:
  - 'tier:M'
  - after-cutover
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-45
  - DIPO-50
  - DIPO-51
  - DIPO-52
references:
  - packages/engine/src/hooks/
  - packages/engine/src/workers/claude-cli/
  - packages/engine/src/host/
  - packages/engine/src/db/migrations/
  - packages/engine/src/views/
  - packages/engine/src/features.ts
  - packages/daemon/src/
  - packages/cli/src/
  - packages/engine/test/hooks/
  - packages/engine/test/recordings/claude-cli/
  - packages/engine/src/index.ts
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/port.ts
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/run/
  - packages/engine/src/retention/
  - packages/engine/src/db/schema.ts
  - packages/contract/src/
  - tools/recordings/
  - .oxlintrc.json
  - test/lint-boundaries/
  - packages/engine/test/workers/
  - packages/engine/test/host/
  - packages/engine/test/run/
  - packages/engine/test/views/
  - packages/daemon/test/
  - packages/contract/schema/
  - packages/engine/src/runs/worker-hosts.ts
documentation:
  - docs/decisions/0004-language-and-runtime.md
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0006-daemon-and-ipc.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: medium
type: feature
ordinal: 59000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo hook <event>` relays Claude Code hook payloads to the worker host over a versioned handshake, the adapter maps them to adapter-neutral hook events, and a `PermissionRequest` asks the maintainer through `question.asked` when present, waits for `dipo answer`, and denies otherwise.

Context: answering a story parked `needs-permission` (allow once or deny, then resume) was split into DIPO-75 in the M0 review (DIPO-15). `dipo hook` is a hidden `runDaemon` form whose handshake is versioned, so a new binary can relay to a host an older binary started (maintainer decision D11, DIPO-15; 0004 and 0006 amendments of 2026-10-12). Hook payload formats and the reply format are Claude-specific and stay in the adapter; `engine/src/hooks` stays adapter-neutral (0008 amendment of 2026-10-12). The hook command is the binary's own `process.execPath`, so it works under launchd and systemd without `PATH`. The `permission-wait` recording is captured live by the maintainer, which is why this story is flagged test-before-merge. Commands, reads and the `questions` table are added through the registration seams of DIPO-22 and DIPO-27. References: 0008 section 5 (hook list, relay, presence rule, wait), section 3 (`requires_action` next to the hook); 0005 amendment (`QuestionView.kind`, `work.answer.decision`); 0007 section 4 (`questions`); 0017 scenario `permission-wait`.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-59/relay-claude-hooks-ask-maintainer"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) `permission-wait` replay with the maintainer present emits `question.asked` kind permission; an allow answer passes the call, and no answer denies it after the timeout."
    - kind: "automated"
      check: "(unit) the host accepts a hook relay with an older supported handshake version and refuses an unknown one silently."
    - kind: "automated"
      check: "(unit) the adapter maps a fixture payload of each registered hook event to its neutral event, and a lint test fails on a `workers/claude-cli` import in `engine/src/hooks`."
    - kind: "manual"
      check: "maintainer runs `bun run recordings:capture permission-wait` on the branch"
      expect: "a new recording is written with a `ch: \"hook\"` `PermissionRequest` line and no secret, and the replay tests pass on it."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `dipo hook <event>` is a hidden `runDaemon` form; the run settings file registers the 0008 hooks with the binary's `process.execPath` as the command, and the form forwards stdin to `DIPO_HOST_SOCKET` with a versioned handshake, prints nothing, exits 0 within 2 s and fails silently.
- [x] #2 The host accepts every hook handshake version it supports, so a newer binary can relay to a host an older binary started, and appends payloads as `ch: "hook"` lines, replayed like stdout.
- [x] #3 The Claude CLI adapter maps hook payloads to adapter-neutral hook events and maps the engine's neutral replies to the Claude reply format; `engine/src/hooks` holds no Claude-specific field, and a lint test fails when it imports `workers/claude-cli`.
- [x] #4 With `permissions.ask: when-present`, a connected client and a client command or read within `permissions.presentMinutes` (stream heartbeats do not count), a `PermissionRequest` emits `question.asked` (kind permission, tool and input summary) and `work.observed input-wait`, and waits up to `timeouts.permissionWaitSeconds` for `work.answer`, then denies.
- [x] #5 Without presence, with `permissions.ask: never`, or with the daemon down, the hook returns no decision at once, so the call is denied.
- [x] #6 A migration adds `questions`; a permission question is stored, emitted with `question.asked`, and included in `office.snapshot` and `story.detail`.
- [x] #7 `work.answer { question, decision }` answers a waiting permission question, and `dipo answer <question> <text|allow|deny>` sends `work.answer`.
- [x] #8 The `permission-wait` recording is captured live by the maintainer with the DIPO-41 tool, committed, and replayed in the tests.
- [x] #9 `work.answer` on a permission question without `decision` fails with `args.invalid`; `text` stays required by the schema and may be empty, and for a permission question it is the reason given to the worker. A test covers both.
- [x] #10 The `PostModelSwitch` and `PostCompact` hook payloads map to `modelSwitched` and `compacted`, deduplicated against the `system/init`, `modelUsage` and `compact_boundary` paths (DIPO-42 review); a recording or fixture covers each.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S43 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.

M0 review (DIPO-15): split; the needs-permission answer and resume moved to DIPO-75. Flagged test-before-merge because the live capture of `permission-wait` is a maintainer step.

Implementation (DIPO-59):
- Host protocol 2 adds the ops `hook` and `hookReply` (an op is accepted only on a connection whose picked version has it). `HOOK_PROTOCOL_VERSIONS` lists the versions a relay offers; a newer binary keeps the older ones. The host appends a payload as a `ch: hook` line; a call with `waitMs` is held under the line's end offset until the engine's `hookReply`, the wait, the worker's exit, or the last watching engine leaving. With no engine watching (daemon down) it answers at once with no output.
- `dipo hook <event> [--wait <s>]` is a hidden runDaemon form routed first by the CLI. It reads stdin (1 MiB, 1 s), relays to `DIPO_HOST_SOCKET`/`DIPO_RUN`, prints only the host's answer, and always exits 0. Without --wait it ends within 2 s (CI test spawns the real process).
- Claude specifics live in `workers/claude-cli/hooks.ts`: the registered hooks (`<selfCommand> hook <Event>`, quoted for sh; PermissionRequest `--wait permissionWaitSeconds`, timeout +30 s; others 5 s), the payload to `HookEvent` mapping and the `PermissionRequest` output. `engine/src/hooks` is neutral; an oxlint override plus `test/lint-boundaries/lint-hooks.test.ts` fail on a `workers/claude-cli` import there. The plan refuses a hook command inside the worktree (hooks run outside the sandbox).
- New WorkerEvent `{ t: "hook", hook: HookEvent }`, `SteerOp { kind: "hookReply" }`, `HostOp { hookReply, output }` and `HostLine.end` (ingestion sets it; it is the hook call id). PostCompact/PostModelSwitch are deduplicated against compact_boundary and init/modelUsage, in either order (alias vs full id counts as one switch).
- `PermissionAsks` (engine/src/hooks/permissions.ts): presence = a connected client plus a client command or read within presentMinutes (ContractServer.noteRequest on reads and commands after the handshake only). Present: question row (migration 22 `questions`), `question.asked` + `work.observed input-wait`, timer permissionWaitSeconds then deny. Otherwise, or while the run is being ended: no decision at once. Worker exit closes open questions (`ended`); an office load expires ones a previous daemon left (`expired`).
- `work.answer` (async office command): `question.closed` for an unknown or closed question, `args.invalid` without decision on a permission question; a deny's text is the message to the worker. `dipo answer <q> allow|deny [reason]|<text>`; `dipo watch` prints questions with the answer command.
- Contract (minor 1, unreleased): office error code `question.closed`; optional `questions` on `story.detail`. Snapshot questions and `waitingOnMaintainer` count open questions.
- AC #8 is the maintainer's: `bun run recordings:capture permission-wait` (new scenario, fixture host that never answers, 10 s wait). Until then the engine test derives the scenario from `permission-denied` with a PermissionRequest hook line; it switches to the live recording once committed.

Review fixes (DIPO-59):
- Hook commands are `cd <runDir> && <dipo> hook <Event>`. Run from source (`[bun, entry]`) Bun also gets `--no-env-file` and `--config=<runDir>/hook-bunfig.toml` (an empty plan file), so no `bunfig.toml` preload or `.env` planted in the worktree loads in a hook, which runs outside the sandbox (test: `hook-command.test.ts` runs the planned command with both planted). The compiled binary keeps its `--no-compile-autoload-*` safety and also runs from the run directory.
- Engine token: `launchWorkerHost` writes a random 32-byte secret into `launch.json` (removed by the host before the worker starts) and `worker_hosts.engine_token` (migration 22). Only a connection whose hello presents it may send `hookReply` (`not.permitted` otherwise) or count as the engine watching. The ingest watch and host steering present it.
- The host holds a PermissionRequest call `permissionWaitSeconds + 10` s (`--wait`); the engine's timeout deny with its reason arrives first. A timeout reply that meets `hook.unknown` is taken as already answered, without a notice. Hook timeout stays 30 s above the wait.
- `dipo hook` keeps one deadline (1.8 s) over stdin, handshake and answer for a call that does not wait.
- A call that does not wait relays only its short scalar fields (`tool_input`, `tool_response` and texts over 1 KiB are dropped); a PermissionRequest is relayed whole. Cost: every tool call starts one `dipo hook PostToolUse` process (about 0.1 to 0.3 s, outside the turn's critical path only as far as Claude runs hooks in parallel).
- Known limit: when `PostCompact` arrives before `compact_boundary`, `compacted` carries `preTokens: 0` and the boundary's `pre_tokens` is not re-emitted (no engine consumer reads it yet).

AC #8: the maintainer captured `permission-wait` live (Claude Code 2.1.300, 10 s wait); the engine tests now replay that recording instead of the derived scenario, and it joins the recording expectation tables (outcome blocked, park ambiguous-spec: the worker reported the fixture question after the denied wait).
<!-- SECTION:NOTES:END -->
