---
id: DIPO-98
title: Close the srt default write paths in the worker sandbox
status: To Do
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-15 19:33'
labels:
  - 'tier:S'
milestone: m-0
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/sandbox/policy.ts
  - packages/engine/src/workers/claude-cli/self-test.ts
  - docs/decisions/0008-worker-adapter.md
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/golden/plan-S.json
  - packages/engine/test/workers/golden/plan-M.json
  - packages/engine/test/workers/golden/plan-L.json
  - packages/engine/test/workers/self-test.test.ts
  - packages/engine/test/workers/launch-fixtures.ts
  - packages/engine/test/workers/launch-checks.test.ts
  - packages/engine/test/sandbox/srt-default-writes.ci.test.ts
priority: high
type: feature
ordinal: 88000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker can write in the maintainer home directory only where dipo allows it on purpose; the srt convenience write paths ~/.npm/_logs and ~/.claude/debug and the shared /tmp/claude are each denied or accepted for the worker sandbox by an explicit, recorded decision.

Context: srt 0.0.79 always adds /tmp/claude and /private/tmp/claude, and adds ~/.npm/_logs and ~/.claude/debug unless a denyRead entry covers them (node_modules @anthropic-ai/sandbox-runtime 0.0.79 dist/sandbox/sandbox-utils.js:487-544, HOME_CONVENIENCE_WRITE_DIRS at 501). The worker plan only denies reads of ~/Library/Keychains (and the shell snapshot with Safe-Chain) (packages/engine/src/workers/claude-cli/plan.ts:286-307), so a worker can write into ~/.npm/_logs whenever ~/.npm is readable, and into /tmp/claude, which other sandboxes share. dipo knows these paths (SRT_DEFAULT_WRITE_PATHS and SRT_DEFAULT_HOME_WRITE_PATHS, packages/engine/src/sandbox/policy.ts:110-115) but only uses them to refuse pinned programs, not to close them. The 0008 amendment of 2026-10-12 (docs/decisions/0008-worker-adapter.md:360) accepts these three paths as residual risks for engine steps only; nothing records a decision for the worker sandbox, so closing or accepting them there needs a 0008 amendment approved by the maintainer.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The worker sandbox denies writes to ~/.npm/_logs (and ~/.claude/debug unless the Claude CLI needs it there, measured), for example with a denyRead or denyWrite entry that srt honours, and dipo run --dry-run shows each such path with its reason.
- [ ] #2 /tmp/claude is either denied or accepted with a written reason; the maintainer approves the choice as a 0008 amendment.
- [ ] #3 The sandbox self-test proves a worker cannot write to ~/.npm/_logs, and a live Haiku run on the scratch repo still completes.
- [ ] #4 The Safe-Chain install plan (DIPO-84) does not reopen these paths unless that story records why.
<!-- AC:END -->
