---
id: DIPO-437
title: >-
  Keep dipo's temp folders and sweeps to its own state and treat Yarn's token
  file as a secret
status: Refined
assignee: []
created_date: '2026-11-03 09:54'
updated_date: '2026-11-04 13:59'
labels:
  - 'tier:M'
dependencies: []
references:
  - packages/engine/src/run/temp-dirs.ts
  - packages/engine/src/worktree/sweep.ts
  - packages/engine/src/backlog/branch-read.ts
  - packages/engine/src/merge/story-git.ts
  - packages/engine/src/platform/output-files.ts
  - packages/engine/src/context/secrets.ts
  - packages/engine/test/run/temp-dirs.test.ts
  - packages/engine/test/worktree/sweep.test.ts
  - packages/engine/test/platform/spawn-output-file.test.ts
  - packages/engine/test/context/secrets.test.ts
  - packages/engine/test/box/parts.test.ts
priority: low
type: bug
ordinal: 410000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo's temp folders and cleanup sweeps to touch only what is dipo's own, and its secret scan to know Yarn's token file, so that another user or a second dipo cannot redirect them and no package token reaches the remote.

Three low findings of the M1 close-out review (2026-11-02), filed together. They add or tighten barriers, so the criteria follow the CLAUDE.md rule for such stories.

- Run temp folder (M1-8): prepareRunTempDir in packages/engine/src/run/temp-dirs.ts makes the run temp folder and its owner file without the checks its sibling prepareShortTempDir has (lstat, not a link, owned by this user). A second local user who plants /tmp/dipo-run-<id> as a link to a folder of the maintainer gets that folder set to mode 0700 with an owner file in it. Only the Mac scan session uses this folder today, with a fresh id each time.
- Sweeps (M1-9): sweepBranchReads in packages/engine/src/worktree/sweep.ts removes every _branch-read-* folder under the repository's worktree root that is older than this daemon's start, and sweepOutputDirs in packages/engine/src/platform/output-files.ts checks only the owner uid and the age, in a temp root every daemon on the Mac shares. Two daemons on one repository (a second state folder in a test or a hand check) remove each other's work. Same class as DIPO-419 and DIPO-423. Branch reads are made in packages/engine/src/backlog/branch-read.ts and packages/engine/src/merge/story-git.ts. The fix writes an owner file with the state folder's hash when a folder is made, as packages/engine/src/run/temp-dirs.ts does for run temp folders (RUN_TEMP_OWNER_FILE, runTempOwner), and sweeps only folders whose owner file matches. A folder with no owner file or another owner is left alone, so folders left by an earlier binary stay until the maintainer removes them (design choice, not a maintainer decision; the maintainer may change it before a run).
- Secret names (M1-13): .yarnrc.yml can hold npmAuthToken but is missing from SECRET_NAMES in packages/engine/src/context/secrets.ts, so the context pack can show it and the part scan in packages/engine/src/box/parts.ts does not refuse it by name. Many Yarn projects commit a .yarnrc.yml without a token; after this change a worker's change to that file parks the story for the maintainer, which is the wanted trade (design choice, not a maintainer decision; the maintainer may change it before a run).

Not now (maintainer, 2026-11-04): this story left M2 and also holds the reload-loop finding split off DIPO-438. Reload loop (M1-10, a risk the review did not show can happen): on stream.resetRequired the office store in packages/client/src/store/office-store.ts reloads and resubscribes at once, with no backoff and no cap; the fix uses the store's retry backoff (#scheduleRetry) for a second reset within a short window. Before this story is picked up it is split again by what the maintainer then wants.

```dipo
branch: "DIPO-437/own-temp-folders-and-yarn-secret"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) temp-dirs.test.ts: the run temp folder is refused when it is a link, a link to a link, a relative link, a file or another user's folder, and the link's target keeps its mode and gets no owner file"
    - kind: "automated"
      check: "(unit) sweep.test.ts and spawn-output-file.test.ts: each sweep removes an old folder of its own state folder and leaves an old folder of another state folder, one without an owner file, and one whose owner file is a link"
    - kind: "automated"
      check: "(unit) secrets.test.ts and parts.test.ts: .yarnrc.yml in any case and at any depth is a secret name, the context pack lists it by path only and a part that adds it is refused; every name listed before still is"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The run temp folder gets the checks of the short temp folder: a path that is a link, not a directory, or owned by another user is refused with an error that names it, before any mode change or owner file
- [ ] #2 The branch-read sweep and the output-folder sweep write an owner file naming the state folder when they make a folder, and remove only old folders whose owner file names this state folder (design choice, not a maintainer decision; the maintainer may change it before a run)
- [ ] #3 .yarnrc.yml is a secret file name: the context pack lists it by path only, the workspace refuses to read it, and a part that adds or changes it is refused by the secret scan
- [ ] #4 Tests show the old barrier still catches what it caught: the short temp folder's link, owner and run-file checks, the sweeps' uid and age limits and their skip of a folder with a .git entry, and every secret file name listed before this change
- [ ] #5 Tests cover the bypass forms: a link to a link, a relative link, a link to another folder of the same user, an owner file that is a link or names another state folder, and the secret name in another case or in a subfolder
- [ ] #6 A fail-closed test against the real path: prepareRunTempDir on a real planted link under DIPO_TMP throws and leaves the link's target unchanged, and a sweep that cannot read an owner file leaves that folder in place
<!-- AC:END -->
