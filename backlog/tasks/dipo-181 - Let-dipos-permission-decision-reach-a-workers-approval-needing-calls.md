---
id: DIPO-181
title: Let dipo's permission decision reach a worker's approval-needing calls
status: Ready
assignee: []
created_date: '2026-10-17 17:06'
updated_date: '2026-10-20 08:21'
labels:
  - 'tier:M'
  - cutover
  - security
milestone: m-1
dependencies: []
references:
  - packages/engine/src/host/main.ts
  - packages/engine/src/host/relay.ts
  - packages/engine/src/host/client.ts
  - packages/engine/test/host/hook-relay.test.ts
  - packages/engine/test/host/host.test.ts
  - packages/daemon/src/hook.ts
  - packages/daemon/src/hook.test.ts
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/test/hooks/permissions.test.ts
  - packages/engine/src/run/hosts.ts
  - packages/engine/src/run/reattach.ts
  - packages/engine/test/run/reattach.test.ts
  - packages/engine/src/ingest/ingestor.ts
  - packages/engine/src/workers/claude-cli/self-test.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/test/workers/self-test.test.ts
  - packages/engine/test/workers/launch-checks.test.ts
  - packages/engine/test/run/adapter.test.ts
priority: high
type: bug
ordinal: 170000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker's call that needs approval gets dipo's permission decision (allow, deny, or the maintainer's answer): the worker host holds the waiting PermissionRequest hook call until the engine answers, and the launch self-test refuses a launch when the Claude CLI denies such a call before dipo's decision arrives.

Context: the open unknown is settled (see unknowns): the CLI waits for the PermissionRequest hook and obeys it, and denies on its own only when the hook gives no decision. So the deny seen since the cutover comes from dipo's side. The temp daemon log has the warn "a permission decision did not reach the worker host ... hookReply: hook.unknown: No hook call waits as <n>" for runs from 2026-10-18 to 2026-10-20, for example run_01M5C3JM33QF8BCSEB3CMPX27S hooks 106017 and 267174 at 2026-10-20T07:32:55Z and 07:34:15Z, and run_01M5C4CR44YSH3G9V8A9AW9W68 hook 7549 at 07:46:32Z (the first case was run_01M55CQA2468N35QN7V2D5S9MY of DIPO-123, hook 45362). In run_01M5C3JM33QF8BCSEB3CMPX27S the hook line is in events.ndjson and the CLI's permission_denied ("no approval surface in this session; permission request denied automatically") follows 4 ms later, while the run settings register the hook as `dipo hook PermissionRequest --wait 310` (hook timeout 330 s). The daemon ran and answered through those runs, so a daemon that is down is not the cause.

In packages/engine/src/host/main.ts, #hook answers with no output at once when relayHook returns null, waitMs is missing or 0, the host is not running, or no engine watches (#watched: a client that sent watch and presented the engine token); only the wait timer logs ("a hook call waited without a reply"), and no host.log under .git/dipo/runs holds that line, so every such call was answered on one of the at-once paths. Places to check: the engine's watch connection (packages/engine/src/run/hosts.ts start and attach, packages/engine/src/run/reattach.ts, packages/engine/src/ingest/ingestor.ts watch), and whether waitMs reaches the host's hook frame (relayCall in packages/daemon/src/hook.ts, packages/engine/src/host/relay.ts, the protocol version the relay and the host agree on). The engine sends its reply from PermissionAsks (packages/engine/src/hooks/permissions.ts) through run steering. 0008 section 5 already says the host holds a waiting call until the engine answers, so no ADR changes.

The launch self-test (packages/engine/src/workers/claude-cli/self-test.ts, called from claudeLaunchChecks in launch-checks.ts) runs a Haiku session under the run's own settings file with hookRelay false and one planned Bash call (an inline perl program) built so the permission layer does not stop it, so today it never meets a PermissionRequest and cannot see this failure.

```dipo
branch: "DIPO-181/permission-decision-reaches-worker"
unknowns:
  - q: "Which flag or setting of the pinned Claude CLI lets dipo's PermissionRequest hook decide a call in a -p session (2.1.300 waited for it; the DIPO-123 run denied a compound Bash command 4 ms after the hook fired), or must dipo decide in PreToolUse, or through --permission-prompts host with --permission-prompt-tool, instead?"
    status: "resolved"
    answer: "Probe of 2026-10-20 (10 Haiku sessions, Claude CLI 2.1.303, files in scratchpad probe-181/): in a -p session with --permission-prompts none the CLI waits for the PermissionRequest hook (3 s holds were honoured) and obeys its allow or its deny with dipo's reason, and a later call reaches the hook again; it auto-denies with the 'no approval surface ... denied the same way for the rest of this session' text only when the hook gives no decision, within 1 ms of the hook's answer. No CLI flag is needed. PreToolUse allow does not skip the CLI's ask and PreToolUse deny loses the permission_denied event, so dipo keeps the PermissionRequest hook."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the in-process WorkerHost with a fake worker and a fake engine that watches with the engine token reproduces the early answer of the cited runs: a hook call with waitMs 310000, then the engine's hookReply for its id; the test fails without the fix"
    - kind: "automated"
      check: "(unit) a PermissionRequest call with --wait is held until the engine's hookReply and dipo hook prints the engine's output; a second call in the same session is held and answered the same way; the wait passing and the worker's exit still answer with no output"
    - kind: "automated"
      check: "(unit) each early answer of a waiting call writes an info line to host.log with the reason, the hook id and waitMs"
    - kind: "automated"
      check: "(unit) the self-test plans the probe call and one approval call, its hook answer denies the approval call with the self-test reason, and the judge passes a session with exactly these two calls"
    - kind: "automated"
      check: "(unit) the self-test refuses a session whose approval call got the CLI's no approval surface deny, whose tool result lacks dipo's reason, or whose approval call never reached dipo"
    - kind: "manual"
      check: "(live) on the scratch repo with the maintainer present, run a story whose worker needs a compound Bash command"
      expect: "the TUI shows the permission question, and the worker gets the maintainer's allow or deny"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The condition that made the host answer the waiting PermissionRequest calls of the cited runs early is named in a code comment in packages/engine/src/host/main.ts next to the fix, and a regression test with the in-process WorkerHost, a fake worker process and a fake engine client that watches with the engine token reproduces that sequence (a hook call with waitMs 310000, then the engine's hookReply for its id) and fails without the fix
- [ ] #2 A PermissionRequest call with --wait is held by the host until the engine's hookReply, the wait passing or the worker's exit; the engine's output reaches relayHookPayload and `dipo hook PermissionRequest --wait` prints it, and a later waiting call in the same session is held and answered the same way, shown by a test from the hook op to the printed output in which no hookReply fails with hook.unknown
- [ ] #3 When the host answers a call that carries waitMs with no output before the wait passes (no engine watches, the host is not running, the engine's connection closed, the worker exited), it writes an info line to host.log with the reason, the hook id and waitMs, and tests in packages/engine/test/host/hook-relay.test.ts check the line for each reason
- [ ] #4 The self-test session makes, after its planned probe command, one more planned Bash call that needs approval under the run settings and writes no file; dipo answers that call's PermissionRequest through the run settings' `dipo hook PermissionRequest --wait` command and the host protocol with a deny carrying a fixed self-test reason, and the judge accepts a session with exactly these two planned calls
- [ ] #5 The self-test refuses the launch as could not run, with its own probe key, when the approval call's tool result does not hold dipo's self-test reason, when the session's stdout holds a permission_denied event with the CLI's no approval surface text, or when no PermissionRequest for that call reached dipo; unit tests in packages/engine/test/workers/self-test.test.ts cover each case and the pass
<!-- AC:END -->
