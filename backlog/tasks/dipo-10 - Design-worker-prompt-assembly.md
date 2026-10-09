---
id: DIPO-10
title: Design worker prompt assembly
status: To Do
assignee: []
created_date: '2026-10-09 19:59'
labels:
  - architecture
milestone: m-0
dependencies:
  - DIPO-8
priority: high
type: spike
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR defining how the engine builds each worker's prompt from templates plus structured data (role, story fields, office context, prior feedback such as reviewer findings or the maintainer's test notes) so workers never read a process manual. This is the project's core token-saving claim. Cover: template structure and where templates live, what context is included or left out, how mechanical steps (git, worktrees, verify) stay in code and out of the prompt, how prompts stay short and stable, and how token savings are measured against the dipsaus-ai skills baseline. See docs/vision.md and docs/decisions/0011-office-model.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0014-worker-prompt-assembly.md defines the template structure and the data each prompt receives
- [ ] #2 ADR lists which steps stay in code and never appear in a prompt
- [ ] #3 ADR defines how token use is measured and compared with the dipsaus-ai backlog-deliver baseline
- [ ] #4 Maintainer approved the decision
<!-- AC:END -->
