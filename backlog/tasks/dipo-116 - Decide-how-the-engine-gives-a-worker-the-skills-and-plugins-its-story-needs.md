---
id: DIPO-116
title: Decide how the engine gives a worker the skills and plugins its story needs
status: Refined
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-10-21 16:26'
labels:
  - architecture
  - 'tier:M'
  - needs-refinement
milestone: m-1
dependencies:
  - DIPO-108
  - DIPO-285
references:
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0013-repo-scan-and-script-standard.md
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0014-worker-prompt-assembly.md
  - packages/engine/src/workers/claude-cli/
  - packages/engine/src/scan/
  - packages/engine/src/config/schema.ts
priority: high
type: spike
ordinal: 106000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR (a new decision or an amendment to 0008, approved by the maintainer) that decides how the engine, not the worker or a model, gives each worker session exactly the skills and plugins its work needs, for example a react architecture skill for a developer working on React code, while everything else stays off.

Context: DIPO-108 switches every user-scope plugin off unless the office names it in worker.plugins, and the developer role has neither the Skill nor the Agent tool (0008 amendment 2026-10-12, DIPO-43), so today a worker gets no skills at all. The maintainer wants skills granted per need, chosen by the orchestrator (code drives, AI fills the gaps). Questions the ADR answers:
- Selection: which facts choose a skill, in code: the run profile and scan facts (0013, for example React detected), the story's components or labels (0012), the role (M4 roster), office config; and how a maintainer overrides it per office and per story.
- Sources: skills vendored in the repository or .dipo/, user-scope plugins named by the office, marketplaces; pinning, so a run is reproducible.
- Mechanism for claude -p: enabledPlugins in the run settings, a session plugin directory, skills copied into the worktree, the Skill tool for the role; measured live on the scratch repository, not assumed.
- Safety: skill and agent frontmatter (permissionMode, hooks) checked as DIPO-43 requires; skill scripts run inside the sandbox; plugin hooks run outside it, so granting a plugin with hooks is reviewed like code; sandbox read paths for skill files.
- Prompt budget and evidence: skill descriptions count toward 0014 budgets; which skills a session got is recorded as a run fact and shown in the run detail.
- Where it lands: M1 or the M4 roster.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An ADR or amendment answers each question above, with the options weighed and the maintainer's approval recorded.
- [ ] #2 A live probe on the scratch repository shows a granted skill loading and being usable in a claude -p worker session and an ungranted one not loading, recorded in the ADR.
- [ ] #3 Implementation stories for the decision are filed in the milestone the ADR names.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: skills and plugins live inside the box's image from the office config (0021 section 5).
<!-- SECTION:NOTES:END -->
