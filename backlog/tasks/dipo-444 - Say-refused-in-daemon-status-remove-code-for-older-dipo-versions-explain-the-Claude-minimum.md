---
id: DIPO-444
title: >-
  Say refused in daemon status, remove code for older dipo versions, explain the
  Claude minimum
status: In Review
assignee: []
created_date: '2026-11-04 12:24'
updated_date: '2026-11-06 09:18'
labels:
  - 'tier:S'
milestone: m-2
dependencies: []
references:
  - packages/cli/src/daemon-commands.ts
  - packages/client/src/recovery.ts
  - packages/engine/src/create/recovery.ts
  - packages/engine/src/create/lifecycle.ts
  - docs/decisions/0005-command-and-event-model.md
  - packages/engine/src/records/worker-hosts.ts
  - packages/engine/test/host/pending-hosts.test.ts
  - packages/engine/test/run/conflicts.test.ts
  - packages/engine/test/backup/backup.test.ts
  - packages/client/test/unit/client.test.ts
  - packages/engine/test/create/surface.test.ts
  - packages/engine/src/workers/claude-cli/probe.ts
  - packages/engine/test/workers/probe.test.ts
modified_files:
  - packages/cli/src/daemon-commands.ts
  - packages/cli/src/lifecycle-commands.test.ts
  - packages/engine/src/db/backup-files.ts
  - packages/engine/src/db/migrations.ts
  - packages/engine/src/records/worker-hosts.ts
  - packages/engine/src/workers/claude-cli/probe.ts
  - packages/engine/test/backup/backup.test.ts
  - packages/engine/test/create/recovery.test.ts
  - packages/engine/test/host/pending-hosts.test.ts
  - packages/engine/test/host/verify-real-process.test.ts
  - packages/engine/test/host/worker-hosts.test.ts
  - packages/engine/test/run/conflicts.test.ts
  - packages/engine/test/run/planning.test.ts
priority: medium
type: chore
ordinal: 417000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the daemon status to say plainly when the daemon refused its database, code kept only for older dipo versions removed, and the minimum Claude version explained, so that what dipo tells me and keeps is true.

Three items the maintainer took from the not-now list into M2, planning interview 2026-11-04. Does not block M2.

- Status: a daemon that refused a database from before the migration squash (DatabaseBeforeSquashError) shows as "recovering" in dipo daemon status. 0005 keeps such a daemon in the recovering state with the reason, and the state shape is fixed, so only the text changes: the CLI prints refused, with the reason and the fix that stateReason already carries (packages/engine/src/create/recovery.ts), for every database the daemon cannot use (from before the squash, too new, damaged). The status text is printed in packages/cli/src/daemon-commands.ts and packages/client/src/recovery.ts.
- Old code: the "older dipo" signalStop branch in packages/engine/src/records/worker-hosts.ts and its test in packages/engine/test/host/pending-hosts.test.ts, and tests that set up state no current dipo writes: packages/engine/test/run/conflicts.test.ts (around line 25), packages/engine/test/backup/backup.test.ts (around 47), packages/client/test/unit/client.test.ts (around 370) and packages/engine/test/create/surface.test.ts (around 490). The squashed database (0007) refuses older state, so these paths cannot run.
- Claude minimum: MIN_CLAUDE_VERSION in packages/engine/src/workers/claude-cli/probe.ts is 2.1.285, set for sandbox locks that are gone. Keep the value and write in one comment what needs it, or lower it to the lowest version whose features dipo uses and name that feature; a version is lowered only when the code shows nothing newer is needed.

Built by dipo: it is off dipo's run path.

```dipo
branch: "DIPO-444/status-refused-old-code-claude-min"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) daemon-commands tests: a daemon whose database is from before the squash, too new or damaged prints refused with the reason and the fix"
    - kind: "automated"
      check: "(unit) worker-hosts and pending-hosts tests pass without the older dipo branch"
    - kind: "automated"
      check: "(unit) probe.test.ts: a version below the minimum is refused and the minimum itself passes"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 dipo daemon status prints refused, with the reason and the fix, for every database the daemon cannot use (from before the squash, too new or damaged), while the protocol state stays recovering as 0005 says
- [x] #2 Each code path kept only for state older than the squashed database is removed together with its test: the older dipo signalStop branch, the hand-off of older steps and the earlier dipo's daily copies; tests of robustness against an entry that does not render stay
- [x] #3 MIN_CLAUDE_VERSION has one comment naming what needs it, and it is lowered only when the code shows no newer feature is used
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-06 09:10 UTC
- Criteria met: 3 of 3 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 1, failed 0
- Budget used: 128,733 of 300,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
