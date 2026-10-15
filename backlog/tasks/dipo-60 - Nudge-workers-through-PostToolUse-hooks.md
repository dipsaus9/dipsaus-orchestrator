---
id: DIPO-60
title: Nudge workers through PostToolUse hooks
status: Done
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-15 11:41'
labels:
  - 'tier:S'
  - after-cutover
milestone: m-0
dependencies:
  - DIPO-47
  - DIPO-59
references:
  - packages/engine/src/hooks/nudges.ts
  - packages/engine/src/prompts/feedback/
  - packages/engine/test/hooks/
  - packages/engine/src/workers/types.ts
  - packages/engine/src/workers/claude-cli/encode.ts
  - packages/engine/src/hooks/types.ts
  - packages/engine/src/hooks/index.ts
  - packages/engine/src/index.ts
  - packages/engine/src/workers/claude-cli/hooks.ts
  - packages/engine/src/workers/claude-cli/schema.ts
  - packages/engine/src/host/relay.ts
  - packages/engine/src/run/prompts.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/test/workers/
  - packages/engine/test/run/
  - packages/daemon/src/hook.ts
  - packages/daemon/src/hook.test.ts
  - packages/daemon/src/runs.ts
  - packages/engine/src/run/work-run.ts
documentation:
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: medium
type: feature
ordinal: 60000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine answers `PostToolUse` and `SessionStart` hook calls with a short nudge (for Claude, `additionalContext`) only when a fact makes it relevant: a write outside scope, a stale context-pack file, budget past 80%, or an input changed on the base.

Context: the nudge is an adapter-neutral `encode` op and the Claude adapter maps it to `additionalContext`, so `engine/src/hooks` stays free of Claude formats (maintainer decision D11, DIPO-15; 0008 amendment of 2026-10-12). References: 0014 section 8 (triggers, texts, 300 characters, once per fact signature, 2 s limit, counted per run); 0008 section 1 (`encode`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

Built after cutover: dipo delivers this story itself (M0 review decision D14, DIPO-15).

```dipo
branch: "DIPO-60/nudge-workers-through-posttooluse-hooks"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) each trigger with a fact gives its text; the same signature twice gives one nudge."
    - kind: "automated"
      check: "(unit) the Claude adapter's `encode` of a `nudge` op gives the hook reply with `additionalContext` holding the text."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Each of the four triggers in the 0014 section 8 table produces its nudge text and nothing else produces one.
- [x] #2 A nudge is at most 300 characters and sent once per fact signature per session.
- [x] #3 The hook answers within 2 s and prints nothing on any failure.
- [x] #4 Nudges are counted per run in `prompt_parts`.
- [x] #5 `SteerOp` gains the neutral op `{ kind: "nudge", text }`; the Claude CLI adapter's `encode` turns it into `additionalContext` on the pending `PostToolUse` or `SessionStart` hook reply, and `engine/src/hooks/nudges.ts` emits only the neutral op.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S44 (DIPO-15). After cutover: built by dipo itself, not by a hand-run agent.

Live test 2026-10-15 (test agent, Haiku on the scratch repo, $0.0028): run reached In Review; SessionStart and PostToolUse hooks registered with --nudge behind the DIPO-59 cd hardening; no measurable hook latency vs the pre-DIPO-60 baseline (tool calls 77-140 ms, total 11.8 s vs 12.1 s); no nudge fired on this small task (expected). ADR 0008 amendments approved by the maintainer and recorded in a2df41c.
<!-- SECTION:NOTES:END -->
