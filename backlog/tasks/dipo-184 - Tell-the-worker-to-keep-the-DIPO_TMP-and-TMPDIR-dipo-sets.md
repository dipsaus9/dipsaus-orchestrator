---
id: DIPO-184
title: Tell the worker to keep DIPO_TMP and the sandbox TMPDIR as set
status: Done
assignee: []
created_date: '2026-10-17 17:24'
updated_date: '2026-10-17 20:55'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/test/prompts/
priority: medium
type: bug
ordinal: 173000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the worker uses the DIPO_TMP dipo sets for its run and the TMPDIR its sandbox gives it, instead of overriding them with /tmp, so it does not lose turns to EPERM from temp paths its sandbox cannot write.

Context: the first M1a run, DIPO-123 (run_01M55CQA2468N35QN7V2D5S9MY). The worker ran `DIPO_TMP=/tmp bun test ...`, which failed with EPERM on mkdtemp inside the sandbox, probably because this repository's CLAUDE.md says tests write under DIPO_TMP with the fallback /tmp. dipo sets only DIPO_TMP: the run's short temp root (packages/engine/src/workers/claude-cli/plan.ts, DIPO-118), writable in the sandbox and listed in the dry run's environment. TMPDIR is not set by dipo: plan.ts passes the daemon's TMPDIR through ENV_ALLOWLIST, and the run temp directory is only an allowWrite path of the sandbox. Inside the sandbox the worker's TMPDIR is Claude Code's own writable directory (in the DIPO-123 run, $TMPDIR/base-head resolved to /private/tmp/claude-501/base-head). /tmp itself is not writable there, which the EPERM showed. The worker's system prompt is L1, packages/engine/src/prompts/contract/implement.md, followed by the developer role; neither mentions DIPO_TMP or TMPDIR. L1+L2 stay byte-identical for every story with the same role (0014 section 5), so the line names the variables and /tmp, never a run's own paths.

```dipo
branch: "DIPO-184/worker-keeps-dipo-tmp"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(golden) the rendered system file holds the DIPO_TMP and TMPDIR rule and names no path but /tmp"
    - kind: "manual"
      check: "(live) on the scratch repo, run a story whose tests write temp files"
      expect: "the worker runs its tests without setting DIPO_TMP or TMPDIR on the command line"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 L1 (packages/engine/src/prompts/contract/implement.md) states that DIPO_TMP is set for the run and the sandbox gives a writable TMPDIR, that commands use both as they are and never set either to another path, and that /tmp is not writable in the sandbox, even where project rules name it as a fallback
- [x] #2 The new text holds no run-specific path, id or date (the only path it names is /tmp), and the golden file packages/engine/test/prompts/golden/system-implement-developer.md is updated and its test passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M55T3N9MN5DFQGCYSAF94KA7 (Haiku low, 12 turns, about $0.01, under a minute) reported done with no denials. L1 gains a Temp files section; the system-file test now allows exactly one path token, /tmp, and a new test pins the rule's sentences; the golden file is updated. Verify outside the sandbox on DIPO-184/worker-keeps-dipo-tmp-finish: 3155 pass, 2 skip, 0 fail. The manual live check of the test plan (a scratch-repo story whose tests write temp files) is left for the maintainer.
<!-- SECTION:NOTES:END -->
