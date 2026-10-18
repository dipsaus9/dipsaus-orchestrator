---
id: DIPO-182
title: Keep worker session transcripts under the run directory and its retention
status: Refined
assignee: []
created_date: '2026-10-17 17:06'
updated_date: '2026-10-18 09:32'
labels:
  - 'tier:S'
  - cutover
  - dropped
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/
  - packages/engine/test/workers/
  - packages/engine/src/retention/
  - packages/engine/test/retention/
  - docs/decisions/0007-state-database.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: medium
type: bug
ordinal: 171000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker session's Claude transcript (full prompts, tool output, thinking) is written under its run directory, or not at all, and is deleted by dipo's retention, instead of staying in the maintainer's ~/.claude/projects outside dipo's privacy settings.

Context: seen after the cutover. The hook payload's transcript_path shows that a worker session writes its transcript to ~/.claude/projects/<escaped worktree path>/<session>.jsonl in the maintainer's home, outside dipo's run directory, retention (0007 section 7) and privacy settings (0007 section 8). The launch passes the real HOME (ENV_ALLOWLIST in packages/engine/src/workers/claude-cli/plan.ts), and nothing in packages/ sets CLAUDE_CONFIG_DIR. 0008 answered its open question 4 on 2026-10-10 by leaving transcripts to Claude Code's 30-day retention, and its files table says the same; 0007 section 8 says that by default the run directories hold no transcripts, and 0014 section 2 (Privacy) leaves Claude Code's own transcripts to Claude Code. This story reverses the maintainer's 2026-10-10 answer to 0008 open question 4; that is the maintainer's decision, so it is the first part of the open unknown. Native resume needs the transcript: resume-check (packages/engine/src/workers/claude-cli/resume-check.ts) looks for it in the home directory. DIPO-134 will read usage from the transcript path the hook reports, so with no transcript written its tailer has nothing to read after a host crash.

Candidates on the installed CLI (2.1.302): CLAUDE_CONFIG_DIR per run moves the projects directory, but also where Claude Code keeps its configuration, plugin lists and maybe its login; `--no-session-persistence` (print mode only) writes no transcript, but then `--resume` cannot continue the session (0008 section 8, 0020) and a resume becomes a handoff (0014 section 6). The story cannot pass the Ready gate (R15) until the unknown is settled.

```dipo
branch: "DIPO-182/transcripts-under-run-dir"
unknowns:
  - q: "Does the maintainer want to reverse the 2026-10-10 answer to 0008 open question 4 (worker transcripts stay in ~/.claude/projects under Claude Code's 30-day retention)? If yes: which setting of the pinned Claude CLI puts a session's transcript under the run directory without moving its login, plugins or settings (CLAUDE_CONFIG_DIR per run, or another key), or does dipo pass --no-session-persistence and give up native resume for workers?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the launch plan sets the transcript place under the run directory, or --no-session-persistence, and resume-check reads that place"
    - kind: "automated"
      check: "(unit) the retention pass removes a run directory with its transcript at its tier"
    - kind: "manual"
      check: "(live) on the scratch repo, run a story and list ~/.claude/projects for its worktree path"
      expect: "no new transcript for the run there; the transcript is in the run directory or absent"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A worker session started by dipo writes no transcript under the maintainer's ~/.claude/projects: the transcript is under the run directory, or none is written, checked by a test of the launch plan and a CI-only or live check against the pinned CLI
- [ ] #2 When dipo keeps the transcript, resume-check finds it at its new place and a resume continues the session; when none is written, a resume becomes a handoff session and the PR says so
- [ ] #3 The retention pass deletes a kept transcript with its run directory at the run directory's tier, and a test checks the deletion
- [ ] #4 The Claude login check and the plugin switch-off of DIPO-108 still pass for a session launched with the new setting
- [ ] #5 The PR proposes dated notes for docs/decisions/0008-worker-adapter.md (open question 4 and the files table), docs/decisions/0014-worker-prompt-assembly.md section 2 (Privacy) and docs/decisions/0007-state-database.md section 8 where they change, for the maintainer's approval
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Closed (maintainer, 2026-10-18): the 2026-10-10 answer to 0008 open question 4 stays. Worker transcripts stay in ~/.claude/projects under Claude Code's retention: native resume and the DIPO-134 transcript reads depend on that place, and a per-run CLAUDE_CONFIG_DIR would risk the worker's login, plugins and settings.
<!-- SECTION:NOTES:END -->
