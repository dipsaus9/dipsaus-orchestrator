---
id: DIPO-194
title: Refuse a worker Bash command that sets DIPO_TMP or TMPDIR
status: Refined
assignee: []
created_date: '2026-10-17 23:16'
updated_date: '2026-10-17 23:16'
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
  - packages/engine/test/workers/hooks.test.ts
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/golden/
  - packages/daemon/src/hook.ts
  - packages/daemon/src/hook.test.ts
priority: medium
type: bug
ordinal: 183000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker Bash command that sets or clears DIPO_TMP or TMPDIR is refused before it runs, with a reason that names the variable and the rule, so a worker no longer loses its verify to EPERM on temp paths it chose itself.

Context: the M1a run of DIPO-135 (run_01M5619VZDHNJH9AHJY3VCZAYK). The worker ran `export DIPO_TMP=$TMPDIR && bun run verify`, although L1 (packages/engine/src/prompts/contract/implement.md, section Temp files, since DIPO-184) says never to set DIPO_TMP or TMPDIR, and 71 daemon tests failed with EPERM on socket paths. The runs of DIPO-175 and DIPO-178 did the same before DIPO-184. A prompt rule lowers the rate but does not stop it, so this is code.

Which hook sees the call: the run settings allow Bash (permissions() in packages/engine/src/workers/claude-cli/plan.ts), so such a command needs no approval and never reaches the PermissionRequest hook (REGISTERED_HOOKS in packages/engine/src/workers/claude-cli/hooks.ts; PermissionAsks in packages/engine/src/hooks/permissions.ts). DIPO-181 is about calls that need approval, so it does not help here and is not a dependency. PreToolUse fires for every tool call before the permission rules. No PreToolUse hook is registered today; DIPO-164 adds one with matcher WebFetch|WebSearch, relayed by `dipo hook PreToolUse` (packages/daemon/src/hook.ts), so this story depends on DIPO-164 and adds Bash to it. The check is pure and needs nothing from the engine, so the relay can decide a Bash call in its own process without a round trip, which keeps every Bash call fast and never fails open or closed on a slow daemon. The other route is permission deny rules in the run settings (Bash(DIPO_TMP=*), Bash(export DIPO_TMP=*), Bash(env DIPO_TMP=*) and the TMPDIR forms). Their deny text is Claude Code's generic one, without the rule, and whether Claude Code matches a rule against a leading assignment is not checked. DIPO-195 reuses the same check for gh. The criteria below are for the PreToolUse route and change before Ready if the answer picks the deny rules.

Both routes change ADR 0008, so the maintainer decides. This story does not edit docs/decisions/.

```dipo
branch: "DIPO-194/refuse-temp-variable-overrides"
unknowns:
  - q: "The DIPO-132 amendment of 0008 registers a PreToolUse hook for WebFetch and WebSearch only, decided by the engine. Do you approve a 0008 section 5 amendment that also registers it for Bash and lets dipo hook PreToolUse decide a Bash call in its own process with a pure check, no engine wait (deny when the command sets or clears DIPO_TMP or TMPDIR, else no decision)? Or should the run settings carry deny rules for those forms instead, which changes the 0008 section 2 deny list and gives Claude Code's generic deny text?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the check refuses each assignment form of DIPO_TMP and TMPDIR, also inside a compound command, and passes a command that only reads them or names a longer variable"
    - kind: "automated"
      check: "(unit) the relay prints a PreToolUse deny for export DIPO_TMP=$TMPDIR && bun run verify and no decision for bun run verify, without contacting the worker host"
    - kind: "automated"
      check: "(unit) the run settings register the PreToolUse hook for Bash next to the web tools"
    - kind: "manual"
      check: "(live) on the scratch repo, run a story whose task tells the worker to run its tests with DIPO_TMP set to its TMPDIR"
      expect: "the call is denied with dipo's reason naming DIPO_TMP, and the worker's next call runs the tests without setting it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A pure function in packages/engine/src/hooks/ takes a Bash command text and returns a refusal naming the variable when any simple command in it (split at &&, ||, ;, | and newlines) sets DIPO_TMP or TMPDIR as a prefix assignment (X=v cmd), as a bare assignment, through export X=..., through env with X=..., or clears it with unset X; it returns null for a command that only reads the variable ($X or ${X}), names it as a later argument (echo X=1), or names a longer variable (DIPO_TMP_ROOT)
- [ ] #2 Unit tests in packages/engine/test/hooks/ cover each form of #1, also after cd x && inside a compound command, and the command export DIPO_TMP=$TMPDIR && bun run verify from run_01M5619VZDHNJH9AHJY3VCZAYK
- [ ] #3 The run settings' PreToolUse hook (added by DIPO-164) also matches Bash, and a test in packages/engine/test/workers/plan.test.ts asserts it; the golden plan files in packages/engine/test/workers/golden/ are updated
- [ ] #4 dipo hook PreToolUse (packages/daemon/src/hook.ts, with the Claude payload and output shapes in packages/engine/src/workers/claude-cli/hooks.ts) decides a Bash call with the function of #1 in its own process, without contacting the worker host: a refusal prints a PreToolUse deny whose reason names the variable and says dipo sets DIPO_TMP and the sandbox sets TMPDIR for the run; any other Bash call prints no decision, so the permission rules decide as before; tests in packages/daemon/src/hook.test.ts and packages/engine/test/workers/hooks.test.ts show both
<!-- AC:END -->
