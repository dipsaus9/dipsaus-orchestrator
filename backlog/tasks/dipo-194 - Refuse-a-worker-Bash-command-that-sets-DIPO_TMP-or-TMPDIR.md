---
id: DIPO-194
title: Refuse a worker Bash command that sets DIPO_TMP or TMPDIR
status: Done
assignee: []
created_date: '2026-10-17 23:16'
updated_date: '2026-10-19 22:22'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies:
  - DIPO-164
references:
  - packages/engine/src/hooks/
  - packages/engine/test/hooks/
  - packages/engine/src/workers/claude-cli/hooks.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/index.ts
  - packages/engine/test/workers/hooks.test.ts
  - packages/engine/test/workers/plan.test.ts
  - packages/daemon/src/hook.ts
  - packages/daemon/src/hook.test.ts
  - packages/daemon/src/hook.ci.test.ts
  - packages/engine/test/run/start.test.ts
priority: medium
type: bug
ordinal: 183000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker Bash command that sets or clears DIPO_TMP or TMPDIR is refused before it runs, with a reason that names the variable and the rule, so a worker no longer loses its verify to EPERM on temp paths it chose itself.

Context: the M1a run of DIPO-135 (run_01M5619VZDHNJH9AHJY3VCZAYK). The worker ran `export DIPO_TMP=$TMPDIR && bun run verify`, although L1 (packages/engine/src/prompts/contract/implement.md, section Temp files, since DIPO-184) says never to set DIPO_TMP or TMPDIR, and 71 daemon tests failed with EPERM on socket paths. The runs of DIPO-175 and DIPO-178 did the same before DIPO-184. A prompt rule lowers the rate but does not stop it, so this is code.

Route (maintainer answer A, 2026-10-19; 0008 amendment of that date, section 5): the run settings allow Bash (permissions() in packages/engine/src/workers/claude-cli/plan.ts), so such a command never reaches the PermissionRequest hook, while PreToolUse fires for every tool call before the permission rules. DIPO-164 registers PreToolUse only for the web tools and only in a session that has them: hookSettings in packages/engine/src/workers/claude-cli/hooks.ts writes one entry with WEB_HOOK_MATCHER (WebFetch|WebSearch, from WEB_TOOLS in packages/engine/src/workers/types.ts, which run/launch.ts adds to the developer's tools) running `dipo hook PreToolUse --gate`, which relays to the engine and fails closed (runGate in packages/daemon/src/hook.ts prints a deny on any failure and exits 2 when it cannot print, and GATE_CRASH_EXIT makes a crashed gate command exit 2). This story adds a second PreToolUse entry with matcher Bash in every session with the hook relay, running `dipo hook PreToolUse --bash`, which decides the call in its own process with a pure check and never contacts the worker host, so every Bash call stays fast whatever the daemon does. It fails open: a check that fails prints nothing and exits 0, and its command line has no exit-2 fallback, so a broken check never blocks every Bash call. No deny rules are added to the run settings. DIPO-195 reuses the same check for gh. The ADR note is written; this story does not edit docs/decisions/.

```dipo
branch: "DIPO-194/refuse-temp-variable-overrides"
unknowns:
  - q: "The DIPO-132 amendment of 0008 registers a PreToolUse hook for WebFetch and WebSearch only, decided by the engine. Do you approve a 0008 section 5 amendment that also registers it for Bash and lets dipo hook PreToolUse decide a Bash call in its own process with a pure check, no engine wait (deny when the command sets or clears DIPO_TMP or TMPDIR, else no decision)? Or should the run settings carry deny rules for those forms instead, which changes the 0008 section 2 deny list and gives Claude Code's generic deny text?"
    status: "resolved"
    answer: "A (maintainer, 2026-10-19; 0008 amendment of that date, section 5): PreToolUse is also registered for Bash, and dipo hook PreToolUse decides a Bash call in its own process with a pure check and no engine wait. It denies a command that sets or clears DIPO_TMP or TMPDIR, with a reason that names the variable and the rule; any other command gets no decision (empty stdout), so Claude's permission rules apply. A failed check prints nothing and exits 0. No deny rules are added to the run settings."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the check refuses each assignment form of DIPO_TMP and TMPDIR, also inside a compound command, and passes a command that only reads them or names a longer variable"
    - kind: "automated"
      check: "(unit) against the real worker host, the relay prints a PreToolUse deny for export DIPO_TMP=$TMPDIR && bun run verify and nothing for bun run verify, and no hook call reaches the host; a check that throws prints nothing and exits 0"
    - kind: "automated"
      check: "(unit) the run settings register a Bash PreToolUse entry in every session with the hook relay, next to the web entry, and its command line run through sh with a failing binary never exits 2"
    - kind: "automated"
      check: "(process, CI) the real dipo hook PreToolUse --bash process with no worker host prints the deny for a DIPO_TMP payload and nothing for another command, exit 0 within 2 s"
    - kind: "manual"
      check: "(live) on the scratch repo, run a story whose task tells the worker to run its tests with DIPO_TMP set to its TMPDIR"
      expect: "the call is denied with dipo's reason naming DIPO_TMP, and the worker's next call runs the tests without setting it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A pure function in packages/engine/src/hooks/, exported through packages/engine/src/hooks/index.ts, takes a Bash command text and returns the variable it refuses or null. It splits the text into simple commands at &&, ||, ;, | and newlines, and refuses when a simple command sets DIPO_TMP or TMPDIR as a prefix assignment (DIPO_TMP=x bun test), as a bare assignment, through export (export DIPO_TMP=x), through env (env DIPO_TMP=x cmd, also after env options, and env -u TMPDIR), or clears it with unset (unset TMPDIR). It returns null for a command that only reads the variable ($DIPO_TMP or ${TMPDIR}), names it as a later argument (echo DIPO_TMP=1), or names a longer variable (DIPO_TMP_ROOT=x)
- [x] #2 Unit tests in packages/engine/test/hooks/ cover each form of the first criterion alone and inside a compound command, at least cd x && export DIPO_TMP=$TMPDIR, DIPO_TMP=/tmp/x bun test, env DIPO_TMP=/tmp/x bun run verify, unset TMPDIR and export DIPO_TMP=$TMPDIR && bun run verify from run_01M5619VZDHNJH9AHJY3VCZAYK, and each null case
- [x] #3 hookSettings in packages/engine/src/workers/claude-cli/hooks.ts registers, in every session with the hook relay, with or without web tools, a PreToolUse entry with matcher Bash whose command is <dipo> hook PreToolUse --bash without the GATE_CRASH_EXIT fallback, next to the unchanged WebFetch|WebSearch --gate entry; tests in packages/engine/test/workers/hooks.test.ts and packages/engine/test/workers/plan.test.ts assert both entries with web tools and the Bash entry alone without them, and the worker.web false test in packages/engine/test/run/start.test.ts expects the Bash PreToolUse entry and no WebFetch|WebSearch entry
- [x] #4 A test in packages/engine/test/workers/hooks.test.ts runs the registered Bash command line through sh with /usr/bin/false and with a missing binary as dipo, as the DIPO-164 gate test does, and shows it never exits 2 and prints nothing on stdout
- [x] #5 dipo hook PreToolUse --bash (parseHookArgs and runHookForm in packages/daemon/src/hook.ts) reads tool_input.command from the payload and decides it with the function of the first criterion in its own process, without connecting to DIPO_HOST_SOCKET. A refusal prints Claude's PreToolUse deny with the reason: dipo refused this command because it sets or clears <VAR>; dipo sets DIPO_TMP and the sandbox sets TMPDIR for the run, so never set or clear them (contract rule Temp files); run the command without it. Any other command, a payload that does not parse and a check that throws print nothing and exit 0
- [x] #6 Tests in packages/daemon/src/hook.test.ts run --bash against the real worker host (withWorkerHost, as the DIPO-164 gate tests do) and show the deny for export DIPO_TMP=$TMPDIR && bun run verify, empty output for bun run verify, and no pending hook call on the host for either; a test with a check that throws shows empty output and exit 0
- [x] #7 A test in packages/daemon/src/hook.ci.test.ts starts the real dipo hook PreToolUse --bash process from the CLI entry with no worker host and shows the deny on stdout for a DIPO_TMP payload and empty stdout for another command, each with exit 0 within 2 s
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5B2BNZCH1YP7BMBPTXNNSAX (Sonnet, 33 turns, about $0.63, 10 min) reported done, In Review. Plain bun test passed in the sandbox; its DIPO_TEST_CI=1 run showed 28 failures from the sandbox (mkdtemp under /tmp refused), and outside the sandbox the full DIPO_TEST_CI=1 suite passes (3920 pass, 0 fail). refusedTempVariable (engine hooks/temp-guard.ts) splits a Bash command into simple commands and refuses prefix and bare assignments, export-like builtins, env (with options, -u, --unset, -S) and unset of DIPO_TMP or TMPDIR, following sh -c and env -S; reads and longer names pass. Every session with the hook relay gets a Bash PreToolUse entry `dipo hook PreToolUse --bash`, fail-open with no GATE_CRASH_EXIT, next to the unchanged fail-closed web --gate entry (0008 section 5 amendment); the daemon side decides in its own process without the host socket. Fixed on top after review (blocking): tests for each form inside a compound command; also shell keywords (if, then, else, elif, do, while, until) are skipped before the command word, so `then export TMPDIR=x` is refused, with tests and a false-positive probe by the reviewer. Known limits, gap candidates: here-doc bodies are checked as commands (fails safe), and eval, local, printf -v, read, sudo, xargs env and $(...) inside double quotes are not followed. Verify outside the sandbox: 3779 tests, 0 fail. Review and re-review passed.
<!-- SECTION:NOTES:END -->
