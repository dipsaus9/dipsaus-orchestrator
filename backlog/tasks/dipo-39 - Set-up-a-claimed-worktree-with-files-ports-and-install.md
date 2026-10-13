---
id: DIPO-39
title: 'Set up a claimed worktree with files, ports and install'
status: In Progress
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 08:54'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-37
  - DIPO-38
  - DIPO-72
references:
  - packages/engine/src/worktree/setup.ts
  - packages/engine/src/worktree/slots.ts
  - packages/engine/src/worktree/
  - packages/engine/test/worktree/
documentation:
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0013-repo-scan-and-script-standard.md
priority: high
type: feature
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after a claim, the engine copies or links the configured gitignored files, copies a filtered `.claude/settings.local.json`, assigns a machine-wide port slot, builds the run environment, and runs install, `setup` and `post_create` inside `srt`, rolling back the claim when setup fails.

Context: teardown is DIPO-58. The run profile comes from DIPO-72's stored profile. References: 0010 section 8 (files, install, setup, post_create, run environment), section 9 (slots and bind check), failure case "Setup fails", amendment from 0008 (settings copy, env-file notice); 0013 section 4 (env file facts); 0008 section 2 "Project settings" (dropped keys), "Env files".

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-39/set-up-claimed-worktree-files-ports"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) a tracked path in `worktree.files` is refused; an ignored `.env` is copied; its content never appears in logs."
    - kind: "automated"
      check: "(unit) slot allocation and freeing; environment substitution."
    - kind: "automated"
      check: "(integration) a failing `setup` script rolls back the claim and leaves the story Ready."
    - kind: "automated"
      check: "(unit) with a fake disk probe reporting 1 GB free before install, setup fails and rolls back the claim."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Each `worktree.files` path is repo-relative, must be ignored per `git check-ignore -q` in the new worktree (every file under a directory), and is copied with modes or linked when `mode: link`; a missing required source fails setup, an optional one is skipped with a notice.
- [x] #2 File contents are never read, hashed or logged.
- [x] #3 `.claude/settings.local.json` is copied when present and gitignored, without `permissions.allow`, `permissions.ask`, `permissions.additionalDirectories`, `permissions.defaultMode` and the three MCP keys of 0008.
- [x] #4 The first env-file copy per office shows the "worktree env files hold development secrets only" notice once and lists the files.
- [x] #5 Slots are machine-wide in `<state>`: the lowest free slot 1 to `maxSlots` is taken and kept while the worktree exists.
- [x] #6 The run environment holds `DIPO_SLOT`, `DIPO_PORT_OFFSET`, `DIPO_STORY`, `DIPO_WORKTREE`, named ports or `PORT`, and `env` entries with only the documented placeholders substituted.
- [x] #7 Install from the run profile, then `setup`, then each `post_create` argument list run through DIPO-37 in order, without a shell.
- [x] #8 Before install the DIPO-38 free-space check runs again; less than 2 GB free fails setup with a log line naming the free space.
- [x] #9 On setup failure the worktree is removed, the branch deleted only if it still points at the start SHA, the story stays Ready, and the skip is `pickupCheckFailed` with the setup log.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S23 (DIPO-15). Before cutover: built by hand-run agents.

Scope additions:
- packages/engine/src/db/migrations/0011-once-notices.ts: new migration 11, table once_notices, records that the env-file notice (AC #4) was shown once per office. Renumbered at merge if another open PR takes 11.
- packages/engine/src/db/schema.ts: registers migration 11 in MIGRATIONS.

Choices: setup runs after claimStory (outside its git queue item, so a long install does not hold the office git queue). Because the claim commit and push already happened, the rollback deletes the local branch only while its tip is the recorded start_sha or claim_sha (rollbackClaim, refactored out of DIPO-38's rollback), and deletes the pushed branch on the remote only while it still points at what the claim pushed (git push --delete --force-with-lease=<ref>:<sha>). A reused branch whose claim commit is pushed keeps its ref (rewinding it would need a force push); its release is reopened. The slot table is a file, <state>/slots.json (0007 section 2 keeps it outside dipo.db); an entry whose worktree no longer exists is dropped when the table is next written. The ignore check is git check-ignore with many paths per call (same rule as -q per path); names git would quote are refused. setup and post_create run under the closed-network policy, install under the install policy. A run-profile command with a working directory other than the root fails setup. .claude/settings.local.json that is a symlink, tracked or not a JSON object is left out with a notice instead of failing setup. The failed claim row gets release_reason setup-failed; failedClaimOf matches it too.
<!-- SECTION:NOTES:END -->
