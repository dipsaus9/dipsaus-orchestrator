---
id: DIPO-43
title: Probe Claude Code and refuse unsafe runs with a sandbox self-test
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 07:09'
labels:
  - 'tier:M'
  - test-before-merge
milestone: m-0
dependencies:
  - DIPO-37
  - DIPO-40
  - DIPO-41
references:
  - packages/engine/src/workers/claude-cli/probe.ts
  - packages/engine/src/workers/claude-cli/settings-check.ts
  - packages/engine/src/workers/claude-cli/self-test.ts
  - packages/engine/test/workers/
  - packages/engine/test/recordings/claude-cli/
  - packages/engine/src/workers/hold.ts
  - packages/engine/src/workers/claude-cli/launch-checks.ts
  - packages/engine/src/index.ts
  - tools/recordings/scenarios.ts
  - packages/engine/test/workers/recordings.test.ts
  - test/lint-boundaries/
  - packages/engine/src/sandbox/step.ts
  - packages/engine/src/platform/sandbox.ts
  - packages/engine/src/workers/credential-check.ts
  - packages/engine/test/sandbox/
  - tools/recordings/capture.ts
  - packages/engine/src/sandbox/policy.ts
  - packages/engine/src/workers/claude-cli/plan.ts
documentation:
  - docs/decisions/0008-worker-adapter.md
priority: high
type: feature
ordinal: 43000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: before every launch and resume the engine checks the Claude Code version and login, refuses project settings keys outside the allowlist, and runs a sandbox self-test under the run's policy; any failure refuses the run with `startFailed` and an `engine.notice`.

Context: these checks are fail-closed; a failure is a hold, not a park. The run itself is wired in DIPO-74, so this story exposes the checks and the hold for that story to call (M0 review, DIPO-15). The third self-test probe is `gh auth token`, which must fail inside the sandbox; `gh auth status` also fails when only the network is closed, so it proves nothing about the token (0008 amendment of 2026-10-12). The live safety captures are a maintainer step, so this story is flagged test-before-merge (M0 review, DIPO-15). References: 0008 section 2 (minimum version 2.1.285, `claude auth status` with `authMethod: "claude.ai"`, project settings allowlist and refused keys, `sandbox` key never allowlisted, stripped keys reappearing, self-test of three probes), section 7 (`startFailed` row), section 11 (capabilities).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-43/probe-claude-code-refuse-unsafe-runs"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) settings check over fixture files with `hooks`, `env`, `enabledPlugins`, `sandbox` and an allowlisted key."
    - kind: "automated"
      check: "(unit) probe refuses version 2.1.284 and `authMethod: \"api-key\"`."
    - kind: "automated"
      check: "(engine) a failed self-test sets the adapter hold with the reason and emits the notice; a later passing check lifts it."
    - kind: "automated"
      check: "(engine) a fixture worktree whose `.claude/settings.json` holds `{\"hooks\":{}}` fails the launch checks with a notice naming `hooks` and the file."
    - kind: "manual"
      check: "maintainer runs `bun run recordings:capture safety-gitdir-write`, `safety-pointer-write` and `safety-gh-token` on the branch"
      expect: "each recording is written with no secret, shows the write or `gh auth token` refused inside the sandbox, and the replay tests pass on it."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `probe()` runs `claude --version` and `claude auth status` and refuses a version below 2.1.285 or any `authMethod` other than `claude.ai`, naming the value.
- [x] #2 The settings check reads the worktree's `.claude/settings.json` and `.claude/settings.local.json` and refuses any top-level or `permissions.*` key not in the engine safe list or `worker.allowProjectSettings`; a `sandbox` key always refuses.
- [x] #3 A key stripped at setup that reappears refuses the run.
- [x] #4 The self-test runs three sandboxed commands under the run's settings: a write under `<main>/.git`, a write to the `<worktree>/.git` pointer, and `gh auth token`; any success, or a self-test that cannot run, refuses the run.
- [x] #5 A refusal returns `startFailed`, sets an adapter hold with the failed check and the file or key, and emits an `engine.notice` naming them; `adapterHeld(adapter)` reports the hold for every office, and an explicit `work.run` repeats the checks and lifts the hold when they pass.
- [x] #6 This story owns the adapter hold: DIPO-51 sets the same hold for `startFailed` outcomes from the CLI, and DIPO-48 and DIPO-74 refuse new runs and keep the story Ready while it holds.
- [x] #7 The checks run before every launch and every resume.
- [ ] #8 Recordings `safety-gitdir-write`, `safety-pointer-write` and `safety-gh-token` are captured live by the maintainer with DIPO-41's tool, committed, and replayed in tests.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S27 (DIPO-15). Before cutover: built by hand-run agents.

Scope additions: packages/engine/src/workers/hold.ts holds the adapter-neutral adapter hold and launch gate (AC #5, #6: DIPO-48, DIPO-51 and DIPO-74 use it without importing Claude code); packages/engine/src/workers/claude-cli/launch-checks.ts composes probe, settings check and self-test before every launch and resume (AC #7); packages/engine/src/index.ts exports them; tools/recordings/scenarios.ts and tools/recordings/recordings.test.ts gain the three safety scenarios the maintainer captures (AC #8).

Implementation (DIPO-43):
- workers/hold.ts (adapter-neutral): AdapterHolds with hold(adapter, failures), lift(adapter) and adapterHeld(adapter) (one instance per daemon, so every office sees it), each raising an engine.notice (adapter.held, error; adapter.released, info) through an injected notify; gateLaunch(adapter, holds, checks) returns startFailed and holds on a failure or a throw, and lifts the hold on a pass. DIPO-51 calls holds.hold for CLI startFailed outcomes; DIPO-48 and DIPO-74 consult adapterHeld. The hold is in memory: after a daemon restart the checks run again before the next launch anyway.
- claude-cli/probe.ts: claude --version and claude auth status through the injected Spawn, on the worker's allowlisted environment; refuses below 2.1.285, any authMethod other than claude.ai, loggedIn false, or output it cannot read, naming the value.
- claude-cli/settings-check.ts: reads .claude/settings.json and .claude/settings.local.json of the worktree; every top-level and permissions.* key must be on the safe list or in worker.allowProjectSettings; sandbox (and sandbox.*) always refuses; a stripped key in the local copy refuses even when the office allows it; bad JSON or a non-object refuses; the notice names key, file and the allowProjectSettings override. stripLocalSettings is exported for DIPO-39's copy.
- claude-cli/self-test.ts: one short Claude Code session (haiku, effort low, tools Bash, new session id, max 6 turns, 180 s) under the run's own claude-settings.json, byte for byte, makes one Bash call: a fixed perl script (so Bash(gh *) and the redirection rules do not stop it before the sandbox) that tries writes to <main>/.git, the worktree admin dir, refs/heads, objects, opens the <worktree>/.git pointer for append, runs gh auth token with output discarded, and writes a control file in the worktree. Results go to a file in the sandbox temp dir. The engine judges from disk outside the sandbox (results file, forbidden files present, pointer changed, control file present) plus the session outcome and permission denials; any write through, gh exit 0, or a self-test that could not run (no results, startFailed, initRejected, crash, timeout, missing probe line, failed control write, pointer naming a gitdir outside <main>/.git/worktrees) refuses. All probe files carry a nonce and are removed afterwards.
- claude-cli/launch-checks.ts: prepareLaunch(spec, ctx, holds, deps) plans the launch or resume, runs probe, then settings, then self-test (each only when the earlier pass) through gateLaunch, and returns the plan only on a pass. It is the one way to a startable plan for launch and resume (AC #7); DIPO-74 and DIPO-51 call it.
- tools/recordings/scenarios.ts: scenarios safety-gitdir-write, safety-pointer-write and safety-gh-token run the self-test command with one probe group each; verify stores the disk facts, the engine verdict and (gh) whether gh auth token works outside the sandbox. test/workers/self-test.test.ts replays them once committed (skipped until then); recordings.test.ts lists them as awaiting capture.

Deviations and open points:
- AC #8 is not checked: the three live recordings are a maintainer step (no live Claude session was started by the implementer).
- The self-test costs one small haiku session per launch and resume.
- The self-test checks more than the three probes of the AC (admin dir, refs, objects, control write) at the DIPO-41 reviewer's request.
- gh auth token (and on macOS the Keychain probe) exiting 126 or 127 inside the sandbox refuses the run as 'cannot run' (the Keychain token was not tested); any other non-zero exit counts as refused, and its exit code and stderr class are kept in the verdict.
- Plugin finding (DIPO-41: user-scope plugins load under --setting-sources project,local): not decided here. The self-test records the plugin count from system/init but does not refuse on it. Options for the maintainer: (a) refuse when system/init lists any plugin; (b) disable them per run by writing enabledPlugins false for each user-enabled plugin into the run settings file (needs a live check that --settings overrides user scope); (c) isolate the worker's config dir (CLAUDE_CONFIG_DIR; needs a live check that the claude.ai login still works); (d) accept with a notice. Each changes 0008 section 2, so it needs an ADR amendment.
- Skills and agents frontmatter check (0008, roles with Agent or Skill) is not built; until it is, the launch checks refuse a role with Agent, Task or Skill (see Review hardening).

Review hardening (PR #46, no Claude session):
- Exact command: the self-test reads the session's Bash tool uses (one per tool use id) and requires exactly one, whose command equals the planned command; no call, extra calls or another command refuse (cannot run). Recordings redact tool inputs, so the capture stores this check as checks.bash and the replay tests use it.
- Trusted tools: perl and gh are resolved outside the sandbox to absolute, symlink-resolved paths from the daemon's PATH and used by path in the command (gh through fork and exec, no shell). The self-test refuses when either lies under a path a worker can write (worktree, sandbox temp dir, /tmp/claude, ~/.claude/debug, ~/.npm/_logs), or when the worker's PATH holds an empty or relative entry or a directory under one of those.
- gh exit 126 or 127 inside the sandbox refuses (cannot run: gh was not found or not executable, so the Keychain token was not tested); it is no longer a pass.
- Cleanup runs in a finally block: the results file, the control file and every forbidden probe file are removed even when a disk read throws.
- claudeLaunchChecks refuses a role whose tools include Agent, Task or Skill (check tools, key = tool) until the .claude/agents and skills frontmatter check exists.
- For DIPO-74: the worker host must accept only a checked plan (for example a branded CheckedLaunchPlan returned by prepareClaudeLaunch), so planClaudeLaunch cannot bypass the launch checks.
- For DIPO-51: lift a hold set for a CLI startFailed outcome only after a passing probe (prepareClaudeLaunch's gate does that).

Second review hardening (PR #46, no Claude session):
- Keychain: on macOS the self-test also runs /usr/bin/security find-generic-password -s gh:github.com (absolute path, stdout discarded), which must fail inside the sandbox; exit 0 refuses as unsafe. gh auth token stays. Each exec probe records its exit code and a class of its stderr (none, not-found, denied, other; never the content) in verdict.refused, so safety-gh-token shows which probe refused and how. Linux runs gh only. The capture also records whether each read works outside the sandbox (ghTokenReadableOutsideSandbox, keychainReadableOutsideSandbox) and the probes it ran.
- Bash call shape: the one Bash call's input may hold only command, description and timeout, plus run_in_background as false; anything else refuses (cannot run).
- Pointer probe: appends one byte (the nonce's first character), so the disk check outside the sandbox sees any write on its own; the engine restores the pointer from the copy it read before the session, in the finally block.
- Lint boundary tests (test/lint-boundaries/) get a 180 s per-test timeout: one oxlint run took about 55 s under load and the shared run is paid by whichever test runs first in random order.

Maintainer test steps (current): macOS, Claude Code >= 2.1.285 logged in with the subscription, gh logged in (token in the Keychain), perl and gh on PATH outside the repository.
1. bun install && bun run verify -> green; 3 tests skipped (the live safety recordings).
2. DIPO_TMP=$(mktemp -d) bun run recordings:capture safety-gitdir-write safety-pointer-write safety-gh-token -> for each: wrote packages/engine/test/recordings/claude-cli/<name> (<n> lines) and a checks line with disk.written [], pointerChanged false, controlWritten true, bash {calls:1, exact:true, shape:true} and verdict {ok:true,...}. For safety-gh-token: probes ["gh-token","keychain"], verdict.refused has gh-token and keychain, each with a non-zero exit other than 126 or 127 and a stderr class, and ghTokenReadableOutsideSandbox and keychainReadableOutsideSandbox are true. The capture runs in a temp fixture repo.
3. bun test packages/engine/test/workers tools/recordings -> all pass, 0 skipped.
4. git add the three directories packages/engine/test/recordings/claude-cli/safety-gitdir-write, safety-pointer-write and safety-gh-token; git commit -m 'test(DIPO-43): record the self-test safety scenarios'; git push. If any verdict is not ok, do not commit; report the checks line.

Live tuning (2026-10-12, in-session with the maintainer's approval, 3 haiku sessions at low effort, on temp fixture repos under DIPO_TMP, Claude Code 2.1.296):
1. safety-gitdir-write with the probe program as a script file under <main>/.git/dipo/self-test/, run as perl <script>: not ok. The permission layer denied the Bash call (decision_reason_type asyncAgent, non_execution_kind permission-rule), apparently because the script lies outside the working directory. Recording deleted.
2. safety-gitdir-write with the program inline again (perl -e), now holding code only for the probes of its group, plus a plainer system prompt and task message (dipo's sandbox self-test, approved by the maintainer, refusals are the expected result, run the one command and report done): ok. Control written; <main>/.git, worktree admin, refs and objects all blocked with Operation not permitted; one Bash call, exact command, allowed shape. Recording left untracked, not committed.
3. safety-gh-token with the same inline approach: not ok. The permission layer denied the Bash call; nothing ran. Outside the sandbox both gh auth token and the Keychain item gh:github.com are readable, so the probe would be meaningful. Recording deleted. Tuning of the credential probe stopped.
The earlier maintainer run of safety-pointer-write was ok; it was not re-run after these changes.
Code kept: inline perl program per probe group (a write-only self-test carries no credential code), plainer system prompt and task message, per-scenario system prompt in the capture tool, perl exec warning fixed.
Open decision for the maintainer (gh and Keychain check), likely an ADR 0008 amendment:
(a) prove the token is unreadable without reading it, for example a sandboxed read of the gh config path that must fail, and drop the live Keychain read from the self-test;
(b) keep the Keychain check out of the per-launch self-test and record it once as a maintainer-run safety recording;
(c) run the credential check through the engine's srt sandbox (DIPO-37) instead of a Claude session, which tests srt's policy rather than Claude Code's Bash sandbox.
AC #8 stays unchecked until this is decided and all three recordings pass.

Approved approach (maintainer, ADR 0008 amendment merged in PR #50): option (a) in the session plus option (c) in the engine.
- Session (self-test.ts): the gh-token and Keychain probes are gone from the session. The probe gh-config opens <home>/.config/gh/hosts.yml for reading and closes it at once without reading anything; only the errno of a failed open is kept. It passes only with EPERM (1) or EACCES (13). An open that succeeds refuses as unsafe; any other errno refuses as cannot run. The engine first confirms the file exists outside the sandbox; a missing file refuses before any session. A permission-layer denial of the Bash call stays cannot run. The exact-command and shape checks are kept.
- Engine (workers/credential-check.ts): gh auth token and, on macOS, /usr/bin/security find-generic-password -s gh:github.com run through runSandboxedStep (dipo daemon sandbox-exec) under the verify-kind srt policy, each wrapped as /bin/sh -c 'exec "$0" "$@" >/dev/null 2>&1' so no output reaches the engine; no model is involved. Both must exit non-zero. Exit 0 holds the adapter as unsafe; startFailed, a timeout, a signal, or exit 126 or 127 holds it as cannot run. gh is the trusted absolute path from resolveSelfTestTools. In claudeLaunchChecks it runs after the settings check and before the session self-test. ClaudeLaunchCheckDeps gains platform, runStep and uid.
- Capture: safety-gh-token now records the session's hosts.yml open (verdict.ghConfigErrno), ghConfigExistsOutsideSandbox, and engineCredentialCheck, the engine-side result run through the real systemSandboxHost.
Live sessions for this split (with the maintainer's approval, haiku at low effort, temp fixture repos under DIPO_TMP), sessions 4 to 7 of the budget: safety-gitdir-write and safety-pointer-write each passed twice in a row. Their latest recordings are left untracked, not committed. I did not run safety-gh-token live: an earlier attempt at the credential probe was stopped by a safety classifier in my session, so its live capture, which includes the engine running gh auth token and the Keychain lookup under srt, is left to the maintainer. AC #8 stays unchecked until it passes.

Review fix (PR #46, unit tests only, no Claude session, no live credential run):
- The engine credential check no longer passes vacuously. Each command runs as /bin/sh -c '"$0" "$@" >/dev/null 2>&1; echo "dipo-credential-exit $?"' inside srt. judgeCredentialStep requires a wrapper exit of 0 and stdout that is exactly that one marker line, and takes the program's exit code from the marker. A missing marker, extra output, a non-zero wrapper exit (125, 1 from an exception in sandbox-exec, 2 from a usage error), a timeout or startFailed hold the adapter as cannot run. Marker 0 holds it as unsafe. Marker 126 or 127 is cannot run. Any other non-zero marker passes as refused. Program output still goes to /dev/null.
- runSandboxedStep: after exit 125, a refusal file that exists but cannot be read is now startFailed instead of exited. systemSandboxHost.readRefusal returns null only on ENOENT and throws otherwise. A missing refusal file with exit 125 stays an ordinary failure, because worker code may exit 125.
- Linux limit: on Linux the check shows that the gh configuration is denied and that gh auth token fails in srt. It does not show that a token stored in the desktop keyring (Secret Service over D-Bus) is unreachable, because srt cannot filter D-Bus on Linux (0008 residual risk: system D-Bus stays reachable). A Linux keyring probe, for example a secret-tool lookup of gh's entry under srt, is a possible follow-up.

Scope added at review: packages/engine/src/workers/credential-check.ts holds the engine-side credential check of the 2026-10-12 0008 amendment; packages/engine/test/sandbox/ holds the runSandboxedStep test for an unreadable refusal file; tools/recordings/capture.ts takes per-scenario system prompts and the engine-side check result for the safety captures.

Keychain closure (maintainer approved option B; ADR 0008 amendment of 2026-10-13 merged in PR #62). No Claude session and no live credential command was run by the implementer.
- Scope additions: packages/engine/src/sandbox/policy.ts and packages/engine/test/sandbox/, because <home>/Library/Keychains joins SECRET_HOME_PATHS, so every engine step's srt policy read-denies it (goldens updated). packages/engine/src/workers/claude-cli/plan.ts, because the worker's run settings file gets sandbox.filesystem.denyRead [<home>/Library/Keychains]; this is a sandbox deny only, not a permission rule (plan goldens updated, and a test checks the rules do not mention it).
- Engine credential check: the Keychain lookup is now security find-generic-password -s gh:github.com -w (still output to /dev/null, marker wrapper unchanged), and it must fail.
- Session self-test: the hosts.yml open is replaced by probe keychains, which lists <home>/Library/Keychains with perl opendir (no file in it is opened) and must fail with EPERM or EACCES. The engine first confirms the folder exists outside the sandbox; a missing folder refuses. A permission-layer denial of the Bash call still refuses as cannot run. The probe runs on macOS only (probesFor); on Linux the session has no credential probe and the engine check covers gh auth token.
- Capture: safety-gh-token now records verdict.keychainsErrno, keychainsExistOutsideSandbox and engineCredentialCheck (gh auth token and, on macOS, the -w lookup under srt).
<!-- SECTION:NOTES:END -->
