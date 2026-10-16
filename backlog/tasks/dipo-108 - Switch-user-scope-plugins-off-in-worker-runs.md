---
id: DIPO-108
title: Switch user-scope plugins off in worker runs
status: To Do
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-10-16 09:47'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - docs/decisions/0008-worker-adapter.md
  - packages/engine/src/config/
  - packages/engine/test/workers
  - packages/engine/test/
  - packages/engine/src/workers/claude-cli/
  - packages/engine/schema/
  - packages/engine/test/recordings/claude-cli/
priority: high
type: feature
ordinal: 98000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker session loads no user-scope plugin unless the office names it in worker.plugins, as the 2026-10-12 amendment to 0008 section 2 decides, so plugin hooks never run outside the sandbox with the maintainer's credentials during an unattended run.

Context: user-scope plugins load in worker sessions even under --setting-sources project,local (0008 amendment 2026-10-12, recordings success-single and others). The run settings file has no plugin key (packages/engine/src/workers/claude-cli/plan.ts settings()), office config is still version 1 with no worker.plugins (packages/engine/src/config/schema.ts), the self-test only counts plugins (packages/engine/src/workers/claude-cli/self-test.ts pluginCount) and the system/init check reads only apiKeySource and the model (packages/engine/src/workers/claude-cli/interpret.ts). The amendment said the switch-off would be confirmed live before story runs are enabled; it was not. Found by the 2026-10-16 milestone review (TL;DR 2). A refusal at system/init alone is not enough, because plugin SessionStart hooks can run before system/init is printed, so the run settings must switch plugins off and the init check is the backstop.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Office config version 2 adds worker.plugins (default empty, entries in the <plugin>@<marketplace> form enabledPlugins uses) with an identity migration from version 1 (0017 rule of 2026-10-12); a version 1 file still loads and the generated office JSON Schema is regenerated.
- [ ] #2 The run settings file sets enabledPlugins to false for every user-scope plugin not named in worker.plugins; the adapter reads the installed list without the engine knowing Claude's file layout.
- [ ] #3 The system/init parser keeps the plugins list, and a session whose system/init lists a plugin not in worker.plugins ends with outcome startFailed naming the plugin (the story stays Ready, as the 0008 amendment says), before any tool call.
- [ ] #4 Tests cover the settings block, the config migration and the startFailed refusal through a recorded or fake stream.
- [ ] #5 A live run on the scratch repository confirms that a user-scope plugin with a hook does not load and that its hook does not run; it is committed as a scrubbed safety-plugin-off recording under packages/engine/test/recordings/claude-cli/ (0017 safety recordings) and noted in the task.
<!-- AC:END -->
