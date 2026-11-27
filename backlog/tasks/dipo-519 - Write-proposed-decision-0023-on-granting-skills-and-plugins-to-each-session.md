---
id: DIPO-519
title: Write proposed decision 0023 on granting skills and plugins to each session
status: In Progress
assignee: []
created_date: '2026-11-27 08:53'
updated_date: '2026-11-27 09:06'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-4
dependencies: []
references:
  - docs/decisions/0023-skills-and-plugins.md
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
  - docs/decisions/0014-worker-prompt-assembly.md
  - docs/decisions/0001-foundational-decisions.md
  - docs/decisions/0021-worker-isolation.md
  - tools/box-probe/probe.sh
  - tools/box-probe/RESULTS.md
  - packages/engine/src/workers/claude-cli/skills.ts
  - packages/engine/src/workers/claude-cli/plugins.ts
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/src/workers/claude-cli/box-plan.ts
  - packages/engine/src/workers/claude-cli/adapter.ts
  - packages/engine/src/roles/parse.ts
  - packages/engine/src/config/schema.ts
type: spike
ordinal: 480000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: We need to decide how a role file and the office config grant each session only the skills and plugins it needs so that workers get expert help where it fits without opening a box, or the Mac, to tools nobody chose.

Replaces DIPO-116, which has no field block and so fails the Ready gate on R15 and R18; a planning edit cannot add one. Same scope as DIPO-116 after its split on 2026-11-26. DIPO-518 runs the live probes this story writes and gets 0023 approved.

The maintainer decided (planning 2026-11-13): the spike covers skills and plugins. A story run's skills and plugins are named in its role file. The reviewer, planner, auditor and scanner, which are engine code with no role file (packages/engine/src/roles/parse.ts:13), get theirs from the office config. Every session may get them, the scan session included.

Today no session gets any skill or plugin:
- Every plan passes --disable-slash-commands, and a session whose system/init lists a skill is stopped (packages/engine/src/workers/claude-cli/skills.ts:1-21, adapter.ts:89).
- Every installed plugin the office does not name is switched off through enabledPlugins in the run settings (plan.ts:311-326), and a system/init that lists another plugin is stopped (plugins.ts). The office key worker.plugins is gone (0017, Replaced).
- A read-only session's plan is refused when it passes a flag such as --settings or --plugin-dir (box-plan.ts, 0008 section 1).
- A developer box holds nothing of the maintainer's, and its image comes from the office config, which stories cannot change (0008 section 2, 0021 section 5). The scan session runs on the Mac with every tool off and no box (0008 section 6).
- A role file accepts version, purpose, model, effort and kind, and an unknown key is refused (roles/parse.ts:18-26, 0017 Role files).

Questions 0023 answers, each with the options weighed and one recommended:
- Role file: the key that names a role's skills and plugins, how each is named and pinned, and what a name that is not available does when the file loads and at the Ready gate.
- Office config: the keys that name the reviewer's, planner's, auditor's and scanner's skills and plugins.
- Sources: files on the base under .dipo/, files baked into the box image from the office config, and marketplace plugins. How each is pinned so a run is reproducible, and how each is reviewed before it reaches a session.
- Mechanism for claude -p: enabledPlugins in the run settings, --plugin-dir, skills copied into the box, the Skill tool for the kind, and how the system/init checks change from refusing every skill and plugin to allowing only the grant.
- Safety: skill and agent frontmatter (permissionMode, hooks), plugin hooks and MCP servers in a developer box, in the read-only reviewer and planning boxes, and in the scan session on the Mac, where a hook would run outside any box. For the scan, 0023 weighs moving it into a box, allowing only skills without hooks or scripts, or another guard.
- Prompt budget and evidence: skill descriptions count toward the 0014 budgets. Which skills and plugins a session got is recorded with the run and shown in the run detail. A run keeps the grant it started with, as it keeps its role.
- Which decisions change: 0008 sections 1, 2 and 6, 0017 for the role file and office keys, 0014 for the budget, 0001 Roles. 0023 names the lines; they change in the implementation stories, not here.

0023 has status proposed. Its Probes section names P1 (developer box: a granted skill and a granted plugin load and are usable, an ungranted one does not), P2 (read-only box: a granted skill loads while the plan check still refuses every flag the grant does not need) and P3 (scan on the Mac: a granted skill or plugin cannot run a command outside the guard). Each probe lists the scratch repository setup, the commands in order and the expected result, in the manner of tools/box-probe/probe.sh. Earlier probe results (p16c, p17b) are in tools/box-probe/RESULTS.md and the comments of skills.ts.

## What it does not do
- Does not run the live probes or approve 0023; DIPO-518 does
- Does not change any code, or any decision file but the new 0023
- Does not archive DIPO-116; you archive it once this story is filed

## ADR lines that change
- docs/decisions/0023-skills-and-plugins.md, Status: new line: Status: proposed, with the options weighed per question and the probes P1 to P3 written out

## Risks and choices
- other: DIPO-116 stays Refined beside this story until you archive it; code comments that cite DIPO-116 probes keep the old id.
- other: Once Ready, dipo may start this story by itself; after it is Done, DIPO-518 may start in a box too, as you chose.
- spend: One tier M spike run that writes a long ADR with web research.

```dipo
branch: "DIPO-519/write-proposed-decision-0023-granting"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 docs/decisions/0023-skills-and-plugins.md exists with status proposed and answers each question in the context, each with the options weighed and one recommended
- [ ] #2 0023 names the guard for the scan session on the Mac and the probe that shows the guard holds
- [ ] #3 0023 has a Probes section with P1, P2 and P3, each with the scratch repository setup, the commands in order and the expected result
- [ ] #4 Every claim in 0023 about how Claude Code loads a skill or plugin that no recorded probe has measured is marked unmeasured and names the probe that checks it
- [ ] #5 0023 lists the lines of 0008, 0017, 0014 and 0001 that the decision would change, and none of those files changes in this story
<!-- AC:END -->
