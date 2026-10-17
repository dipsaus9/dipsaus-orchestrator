---
id: DIPO-181
title: Let dipo's permission decision reach a worker's approval-needing calls
status: Refined
assignee: []
created_date: '2026-10-17 17:06'
updated_date: '2026-10-17 17:06'
labels:
  - 'tier:M'
  - cutover
  - security
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/
  - packages/engine/test/workers/
  - packages/engine/src/hooks/
  - packages/engine/test/hooks/
  - packages/engine/test/recordings/claude-cli/
  - tools/recordings/
  - docs/decisions/0008-worker-adapter.md
priority: high
type: bug
ordinal: 170000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker's call that needs approval gets dipo's permission decision (allow, deny, or the maintainer's answer), not an automatic deny from the Claude CLI before dipo can answer.

Context: seen in run_01M55CQA2468N35QN7V2D5S9MY (DIPO-123) after the cutover. The worker sent a compound Bash command (`sed ...; echo ----; sed ...`). The PermissionRequest hook fired, and 4 ms later Claude Code emitted `{"type":"system","subtype":"permission_denied","decision_reason_type":"asyncAgent","decision_reason":"no approval surface in this session; permission request denied automatically"}` and told the worker that every later call needing approval would be denied the same way for the rest of the session. dipo's reply then failed with the daemon WARN `a permission decision did not reach the worker host ... hookReply: hook.unknown: No hook call waits as 45362`. So the permission wait of 0008 section 5 (PermissionAsks in packages/engine/src/hooks/permissions.ts, DIPO-59 and DIPO-119) never decides anything.

The plan starts workers with `-p --permission-mode default --permission-prompts none` (packages/engine/src/workers/claude-cli/plan.ts). 0008 says that under `none` anything that would prompt is denied unless a PermissionRequest hook allows it, and the permission-wait recording (packages/engine/test/recordings/claude-cli/permission-wait, CLI 2.1.300) shows the CLI waiting for the hook on a write outside the worktree. The installed CLI 2.1.302 describes `none` as "nobody: anything that would prompt is denied automatically", with no mention of hooks; `host` sends prompts to the SDK host or `--permission-prompt-tool` (0008 option E). Whether the change comes from the CLI version or from the kind of call is not known. The story cannot pass the Ready gate (R15) until the unknown is settled. If the answer changes 0008 section 5 (for example a decision in PreToolUse, or `--permission-prompt-tool`), the PR proposes a dated 0008 note for the maintainer's approval.

```dipo
branch: "DIPO-181/permission-decision-reaches-worker"
unknowns:
  - q: "Which flag or setting of the pinned Claude CLI lets dipo's PermissionRequest hook decide a call in a -p session (2.1.300 waited for it; the DIPO-123 run denied a compound Bash command 4 ms after the hook fired), or must dipo decide in PreToolUse, or through --permission-prompts host with --permission-prompt-tool, instead?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(ci) a worker session on the pinned CLI runs a compound Bash command that needs approval; dipo's deny reason is in its tool result and the next such call reaches dipo too"
    - kind: "automated"
      check: "(unit) the self-test refuses a launch whose approval-needing call is denied before dipo's decision"
    - kind: "manual"
      check: "(live) on the scratch repo with the maintainer present, run a story whose worker needs a compound Bash command"
      expect: "the TUI shows the permission question, and the worker gets the maintainer's allow or deny"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A worker call that needs approval, at least a compound Bash command joined with `;` and a write outside the worktree, gets dipo's decision under permissions.ask (allow, deny, or the maintainer's answer within timeouts.permissionWaitSeconds), and the CLI does not deny it before that decision arrives
- [ ] #2 When dipo denies a call, the worker's tool result holds dipo's deny reason; the CLI's automatic-deny text never reaches the worker, and later calls needing approval in the same session still reach dipo
- [ ] #3 A CI-only test against the pinned Claude CLI, or a new live recording under packages/engine/test/recordings/claude-cli/ captured with tools/recordings/ and a replay test, shows a compound Bash command reaching dipo's decision and the worker reading it
- [ ] #4 The session self-test checks that a call needing approval reaches dipo's decision and refuses the launch when it does not, so a CLI update that changes this holds the adapter instead of running unguarded
- [ ] #5 If the chosen path changes 0008 section 5, the PR proposes a dated note for docs/decisions/0008-worker-adapter.md, for the maintainer's approval
<!-- AC:END -->
