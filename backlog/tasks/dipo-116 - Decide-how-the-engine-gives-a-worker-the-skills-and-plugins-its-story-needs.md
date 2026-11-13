---
id: DIPO-116
title: >-
  Decide how role files and the office config give each session its skills and
  plugins
status: Refined
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-11-13 15:06'
labels:
  - architecture
  - 'tier:M'
  - needs-refinement
  - 'role:developer'
milestone: m-4
dependencies:
  - DIPO-108
  - DIPO-285
  - DIPO-292
  - DIPO-296
references:
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0014-worker-prompt-assembly.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
  - docs/decisions/0001-foundational-decisions.md
  - docs/decisions/0003-milestones-and-quality-bar.md
  - docs/decisions/0013-repo-scan-and-script-standard.md
  - packages/engine/src/workers/claude-cli/skills.ts
  - packages/engine/src/workers/claude-cli/plugins.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/workers/claude-cli/box-plan.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/roles/parse.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/src/scan/
priority: high
type: spike
ordinal: 106000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: We need to decide how a role file and the office config grant each session the skills and plugins it needs, and nothing more, so that workers get expert help where it fits without opening a box, or the Mac, to tools nobody chose.

The maintainer decided (planning 2026-11-13): the spike covers skills and plugins. A story run's skills and plugins are named in its role file. The reviewer, planner, auditor and scanner, which are engine code with no role file, get theirs from the office config. Every session may get them, the scan session included. The ADR weighs where skill files come from.

Today no session gets any:
- Every plan passes --disable-slash-commands, and a session whose system/init lists a skill is stopped (packages/engine/src/workers/claude-cli/skills.ts:1-21).
- Every installed plugin is switched off in the run settings, and a system/init that lists a plugin is stopped (plugins.ts:1-6, adapter.ts:254). The office key worker.plugins is gone (0017 line 148).
- A read-only session's plan is refused when a flag adds tools, settings, plugins or MCP servers (0008 section 1, line 38; box-plan.ts:103-146).
- A developer box holds nothing of the maintainer's, and its image comes from the office config, which stories cannot change (0008 section 2). The scan session runs on the Mac with every tool off and no box (0008 section 6).
- A role file accepts only version, purpose, model and effort; an unknown key is refused (packages/engine/src/roles/parse.ts:18-25). DIPO-500 adds kind. 0003 puts the skills and plugins each role brings in M4.

Questions the ADR answers:
- Role file: the key that names a role's skills and plugins, how each is named and pinned, and what a name that is not available does when the file loads and at the Ready gate.
- Office config: the keys that name the reviewer's, planner's, auditor's and scanner's skills and plugins.
- Sources: files on the base under .dipo/, files baked into the box image from the office config, and marketplace plugins; how each is pinned so a run is reproducible, and how each is reviewed before it reaches a session.
- Mechanism for claude -p, measured live on the scratch repository, not assumed: enabledPlugins in the run settings, --plugin-dir, skills copied into the box, the Skill tool for the kind, and how the system/init checks change from refusing every skill and plugin to allowing only the grant.
- Safety: skill and agent frontmatter (permissionMode, hooks) is checked; plugin hooks and MCP servers in a developer box; in the read-only reviewer and planning boxes, whose plan check refuses such flags today; and in the scan session on the Mac, where a hook would run outside any box. For the scan the ADR weighs moving it into a box, allowing only skills without hooks or scripts, or another guard, and names the probe that shows the guard holds.
- Prompt budget and evidence: skill descriptions count toward the 0014 budgets. Which skills and plugins a session got is recorded with the run and shown in the run detail. A run keeps the grant it started with, as it keeps its role (DIPO-477).
- Which decisions change: 0008 sections 1, 2 and 6, 0017 for the role file and office keys, 0014 for the budget, 0001 Roles.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An ADR or amendment answers each question in the context, with the options weighed and the maintainer's approval recorded.
- [ ] #2 A live probe on the scratch repository shows a granted skill and a granted plugin loading and usable in a claude -p session in a developer box, and an ungranted one not loading, recorded in the ADR.
- [ ] #3 A live probe shows a granted skill loading in a read-only reviewer or planning box while the plan check still refuses every flag the grant does not need, recorded in the ADR.
- [ ] #4 The ADR names the guard for the scan session on the Mac, and a recorded probe shows that a granted skill or plugin cannot run a command on the Mac outside that guard.
- [ ] #5 Implementation stories for the decision are filed in milestone m-4.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: skills and plugins live inside the box's image from the office config (0021 section 5).

2026-10-23 (maintainer): moved to M2.
<!-- SECTION:NOTES:END -->
