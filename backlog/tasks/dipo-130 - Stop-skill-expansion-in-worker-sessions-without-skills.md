---
id: DIPO-130
title: Stop skill expansion in worker sessions without skills
status: To Do
assignee: []
created_date: '2026-10-16 13:25'
labels:
  - 'tier:S'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/
  - packages/engine/test/workers/
  - packages/engine/test/recordings/claude-cli/
  - docs/decisions/0008-worker-adapter.md
priority: high
type: feature
ordinal: 120000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker session that has no granted skills loads no skill at all, so text sent to a worker that starts with / can never expand a skill or register its hooks.

Context: the DIPO-116 research (probe p16c, Claude Code 2.1.301) found that on today's plan, where the developer role has no Skill tool, a user message starting with /<name> expands a skill from the worktree's .claude/skills with no permission check and registers its frontmatter hooks, which then run outside the sandbox. The task message starts with <story> and cannot trigger it, but steer and answer text is sent verbatim (packages/engine/src/workers/claude-cli/encode.ts), so a maintainer steer or answer starting with / can, with any skill a product repository commits. Claude Code's bundled skills expand the same way. Passing --disable-slash-commands stops it (probe p17b: nothing expands, skills: []). Maintainer decision 2026-10-16: land this before the DIPO-115 cutover. Skill grants themselves are DIPO-116.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The claude-cli plan passes --disable-slash-commands for every worker session (no session has grants until DIPO-116 lands), in the self-test session too
- [ ] #2 The system/init schema reads skills, and a session whose system/init lists any skill emits startRefused naming them, so the engine stops it before any tool call (the DIPO-108 startRefused path)
- [ ] #3 A live recording on the scratch repository shows a steer starting with /x, with a project skill x holding a hook, not expanding, no hook running, and skills: [] in system/init
- [ ] #4 Unit tests cover the argv, the refusal, and a session with an empty skills list starting normally; the proposed dated 0008 note is in the PR for the maintainer's approval
<!-- AC:END -->
