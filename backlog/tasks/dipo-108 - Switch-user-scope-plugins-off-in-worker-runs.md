---
id: DIPO-108
title: Switch user-scope plugins off in worker runs
status: Done
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-10-16 10:37'
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
  - packages/engine/src/workers/types.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/outcomes.ts
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
- [x] #1 Office config version 2 adds worker.plugins (default empty, entries in the <plugin>@<marketplace> form enabledPlugins uses) with an identity migration from version 1 (0017 rule of 2026-10-12); a version 1 file still loads and the generated office JSON Schema is regenerated.
- [x] #2 The run settings file sets enabledPlugins to false for every user-scope plugin not named in worker.plugins; the adapter reads the installed list without the engine knowing Claude's file layout.
- [x] #3 The system/init parser keeps the plugins list, and a session whose system/init lists a plugin not in worker.plugins ends with outcome startFailed naming the plugin (the story stays Ready, as the 0008 amendment says), before any tool call.
- [x] #4 Tests cover the settings block, the config migration and the startFailed refusal through a recorded or fake stream.
- [x] #5 A live run on the scratch repository confirms that a user-scope plugin with a hook does not load and that its hook does not run; it is committed as a scrubbed safety-plugin-off recording under packages/engine/test/recordings/claude-cli/ (0017 safety recordings) and noted in the task.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Office config version 2 adds worker.plugins (<plugin>@<marketplace>, default empty); a version 1 file is validated as version 1 and migrated in memory (identity); office.schema.json is the version 2 export. The claude-cli adapter reads ~/.claude/plugins/installed_plugins.json and the synced manifests (plugins.ts, the only file that knows the layout) per launch, and the run settings set enabledPlugins false for every plugin not in worker.plugins; an unreadable list refuses the plan. The system/init parser keeps the plugins list (source, <plugin>@<marketplace>); a plugin not in worker.plugins, builtin ones excepted, sets startFailure naming it (outcome startFailed, no park, story stays Ready) and the turn carries no report, so verify and commit never run on it. The self-test session, which runs under the same settings before every launch and resume, is stopped with SIGTERM at its system/init before its Bash call, and the launch check fails with key plugins. In the worker session itself the engine stops the worker at the end of its first turn (existing startFailed turn-problem path); a stop at init needs a neutral event in workers/types.ts and run/control.ts, outside this story's References.

Live runs (Claude Code 2.1.301, haiku, scratch repo worktree, three sessions): (1) control, current main settings: system/init listed only cc-plugin-agents-md, cc-plugin-telemetry and cc-plugin-plugin-authoring, all @builtin; no hook event; first request 5,788 tokens. (2) switch-off, recorded as safety-plugin-off: same three builtin plugins, warp@claude-code-warp and learning-output-style@claude-plugins-official (both with SessionStart hooks) and dipsaus-ai not loaded, no hook event, 5,788 tokens, done. (3) diagnostic with --setting-sources user,project,local and the switch-off: warp, learning-output-style and dipsaus-ai still did not load (the --settings false beats the user's true), but engineering@synced, an account-synced plugin, did; hence synced manifests are read too. Finding: the three plugins in the DIPO-41 recordings are Claude Code's builtin plugins, not user-scope ones; under project,local user-scope plugins did not load even without the switch-off. Scrubbed with tools/recordings Scrubber and secret guard; no home path, user name, email or prompt text. Scratch worktree removed, no claude processes left.

Review round 1 (References widened to workers/types.ts, run/control.ts, run/outcomes.ts). This replaces the earlier note that the worker session is stopped at the end of its first turn. init() now emits a neutral WorkerEvent startRefused before started. RunControl stops the worker at once (stdin closed, SIGTERM, SIGKILL after 30 s) with a start-failed stop intent, so the exit goes through startFailed: the adapter is held, the claim is released and the story stays Ready, with no park. Test: outcomes.test.ts 'a start the adapter refuses at system/init (DIPO-108)' reads a fake process chunk by chunk; the Bash tool call after init is never read. The builtin exemption fails closed: a marketplace in known_marketplaces.json, an installed plugin or a synced plugin named builtin refuses the plan, and an @builtin id that is also installed or synced is compared like any other. installed_plugins.json must be version 2 with <plugin>@<marketplace> keys and list values. The adapter sets worker.plugins in the parser state from the config of its launch or resume on every line, so a stored null no longer turns the check off. The version 1 hint names version 2 only for worker.plugins. Live session 4 (Haiku, scratch repo, --setting-sources user,project,local with the final switch-off): engineering@synced: false switched the synced plugin off (skills 47 to 37), system/init listed only the three builtin plugins, no hook event, 5,788 tokens, done. Committed as the scrubbed recording safety-plugin-off-user-settings. Scratch worktree removed, no claude processes left.
<!-- SECTION:NOTES:END -->
