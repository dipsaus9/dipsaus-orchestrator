---
id: DIPO-116
title: Propose decision 0023 on how roles and the office grant skills and plugins
status: Refined
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-11-26 14:50'
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
  - docs/decisions/0023-skills-and-plugins.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
  - docs/decisions/0014-worker-prompt-assembly.md
  - docs/decisions/0001-foundational-decisions.md
  - docs/decisions/0003-milestones-and-quality-bar.md
  - tools/box-probe/probe.sh
  - packages/engine/src/workers/claude-cli/skills.ts
  - packages/engine/src/workers/claude-cli/plugins.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/workers/claude-cli/box-plan.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/roles/parse.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/src/scan/feature.ts
priority: high
type: spike
ordinal: 106000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: We need to decide how a role file and the office config grant each session the skills and plugins it needs, and nothing more, so that workers get expert help where it fits without opening a box, or the Mac, to tools nobody chose.

The maintainer decided (planning 2026-11-13): the spike covers skills and plugins. A story run's skills and plugins are named in its role file. The reviewer, planner, auditor and scanner, which are engine code with no role file, get theirs from the office config. Every session may get them, the scan session included.

Split on 2026-11-26: this story writes the proposed decision docs/decisions/0023-skills-and-plugins.md, with the options weighed and the live probes as exact steps. A worker in a box cannot run those probes, because they need a developer box, a read-only box and the scan session on the Mac. The split-off story, taken by the maintainer or a builder, runs them, records the results in 0023 and gets it approved.

Today no session gets any skill or plugin:
- Every plan passes --disable-slash-commands, and a session whose system/init lists a skill is stopped (packages/engine/src/workers/claude-cli/skills.ts:1-21, adapter.ts:98).
- Every installed plugin is switched off through enabledPlugins in the run settings (plan.ts:312-325), and a system/init that lists another plugin is stopped (plugins.ts:1-6). The office key worker.plugins is gone (0017, Replaced).
- A read-only session's plan is refused when it passes a flag such as --settings or --plugin-dir (box-plan.ts:106-149, 0008 section 1).
- A developer box holds nothing of the maintainer's, and its image comes from the office config, which stories cannot change (0008 section 2). The scan session runs on the Mac with every tool off and no box (0008 section 6).
- A role file accepts version, purpose, model, effort and kind, and an unknown key is refused (packages/engine/src/roles/parse.ts:18-26, 0017 Role files).

Questions 0023 answers, each with the options weighed and one recommended:
- Role file: the key that names a role's skills and plugins, how each is named and pinned, and what a name that is not available does when the file loads and at the Ready gate.
- Office config: the keys that name the reviewer's, planner's, auditor's and scanner's skills and plugins.
- Sources: files on the base under .dipo/, files baked into the box image from the office config, and marketplace plugins. How each is pinned so a run is reproducible, and how each is reviewed before it reaches a session.
- Mechanism for claude -p: enabledPlugins in the run settings, --plugin-dir, skills copied into the box, the Skill tool for the kind, and how the system/init checks change from refusing every skill and plugin to allowing only the grant.
- Safety: skill and agent frontmatter (permissionMode, hooks), plugin hooks and MCP servers in a developer box, in the read-only reviewer and planning boxes, and in the scan session on the Mac, where a hook would run outside any box. For the scan, 0023 weighs moving it into a box, allowing only skills without hooks or scripts, or another guard.
- Prompt budget and evidence: skill descriptions count toward the 0014 budgets. Which skills and plugins a session got is recorded with the run and shown in the run detail. A run keeps the grant it started with, as it keeps its role.
- Which decisions change: 0008 sections 1, 2 and 6, 0017 for the role file and office keys, 0014 for the budget, 0001 Roles. 0023 names the lines; they change in the implementation stories, not here.

0023 has status proposed. Its Probes section names P1 (developer box: a granted skill and a granted plugin load and are usable, an ungranted one does not), P2 (read-only box: a granted skill loads while the plan check still refuses every flag the grant does not need) and P3 (scan on the Mac: a granted skill or plugin cannot run a command outside the guard). Each probe lists the scratch repository setup, the commands in order and the expected result, in the manner of tools/box-probe/probe.sh.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 docs/decisions/0023-skills-and-plugins.md exists with status proposed and answers each question in the context, each with the options weighed and one recommended
- [ ] #2 0023 names the guard for the scan session on the Mac and the probe that shows the guard holds
- [ ] #3 0023 has a Probes section with P1, P2 and P3, each with the scratch repository setup, the commands in order and the expected result
- [ ] #4 Every claim in 0023 about how Claude Code loads a skill or plugin that no recorded probe has measured is marked unmeasured and names the probe that checks it
- [ ] #5 0023 lists the lines of 0008, 0017, 0014 and 0001 that the decision would change, and none of those files changes in this story
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reshaped by decision 0021 (worker isolation, DIPO-263, 2026-10-21); rewrite before Ready: skills and plugins live inside the box's image from the office config (0021 section 5).

2026-10-23 (maintainer): moved to M2.
<!-- SECTION:NOTES:END -->
