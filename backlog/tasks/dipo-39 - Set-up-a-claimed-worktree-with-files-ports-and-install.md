---
id: DIPO-39
title: 'Set up a claimed worktree with files, ports and install'
status: Done
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 11:43'
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
- packages/engine/src/db/migrations/0014-once-notices.ts: new migration 14, table once_notices, records that the env-file notice (AC #4) was shown once per office (renumbered from 11: DIPO-65 took 11 and 12, DIPO-71 took 13).
- packages/engine/src/db/schema.ts: registers migration 14 in MIGRATIONS.
- packages/engine/src/retention/policy.ts: once_notices is tier P (kept until office purge), as the retention policy test requires for every office-scoped table.
- packages/engine/src/worktree/claim.ts and feature.ts (DIPO-38 code, inside References): claimStory takes an optional setup hook and runs in three steps, as 0010 section 7 orders (setup, then the claim commit, then the push). Queue item A: re-check, claim checks, worktree add, lock, live claim record, base merge of a reused branch. Then setup outside the git queue. Queue item C: re-check that the claim is still live and the worktree snapshot unchanged, then the claim commit and the push. A failed setup rolls back in its own queue item with nothing committed or pushed: a new branch is deleted only while it points at its start SHA, a reused branch goes back to exactly where it was released and its release is reopened; the claim row ends as setup-failed and the skip is pickupCheckFailed with the setup log. StoryClaims.claim passes the hook through.
- packages/engine/src/worktree/records.ts: failedClaimOf also matches setup-failed.

Choices: the slot table is a file, <state>/slots.json (0007 section 2 keeps it outside dipo.db); an entry whose worktree no longer exists is dropped when the table is next written. The ignore check is git check-ignore with many paths per call (same rule as -q per path); names git would quote are refused. Files are copied from exactly the checked list; each entry is re-checked (no symlink on its path, same device and inode) right before and after its copy. .claude/settings.local.json reaches the worktree only stripped: listed or under a copied directory it is routed to its own rule; a link entry on it or a directory above it refuses setup. A settings.local.json that is a symlink, tracked or not a JSON object is left out with a notice. setup and post_create run under the closed-network policy, install under the install policy. A run-profile command with a working directory other than the root fails setup. Setup fails when its steps leave files git does not ignore, so the claim commit holds only the task file.

Re-check follow-up:
- Claims released by something else while setup ran: the rollback re-reads the row and then removes only the worktree. The row, its release and the branch stay as that release left them, and the claim UPDATE is guarded with released_at is null.
- claim_sha is now recorded after every finished claim (the tip when the status was already In Progress). A live claim with claim_sha null is therefore one whose setup never finished. The claims load step (StoryClaims.recover, packages/engine/src/worktree/feature.ts) rolls such claims back after a daemon restart: worktree removed, branch restored, row set to setup-failed, slot freed when StoryClaimsDeps.slots is given, and a claim.setupInterrupted notice.
- Each worktree file is opened with O_NOFOLLOW, its fstat device and inode are compared with the check, and its bytes are streamed from that descriptor to an O_EXCL | O_NOFOLLOW destination.
- The setup.failed notice names files that setup left unignored and suggests a frozen install.

AC #2: worktree files are streamed through a fixed-size memory buffer from the source descriptor to the destination; the contents pass through memory but are never inspected, hashed or logged.

Hand-off to DIPO-74: pass the <state> SlotTable to StoryClaims when setup is wired into the daemon, so recover frees the slot of an interrupted setup. recover treats every live claim with claim_sha null as an interrupted setup; no live claims exist before this change because work.run (DIPO-48) is not live yet.
<!-- SECTION:NOTES:END -->
