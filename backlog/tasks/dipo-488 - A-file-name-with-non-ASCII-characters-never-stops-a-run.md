---
id: DIPO-488
title: A file name with non-ASCII characters never stops a run
status: Refined
assignee: []
created_date: '2026-11-10 16:34'
updated_date: '2026-11-10 16:34'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/box/lifetime.ts
  - packages/engine/src/box/parts.ts
  - packages/engine/src/box/cache-extract.ts
  - packages/engine/src/box/code.ts
  - packages/engine/src/box/user.ts
  - packages/engine/src/box/apple-args.ts
  - packages/engine/src/git/tree.ts
  - packages/engine/src/run/launch.ts
  - packages/engine/src/worktree/claim.ts
  - packages/tui/src/desk.tsx
  - packages/cli/src/watch-command.ts
  - packages/engine/src/run/idea-answers.ts
  - packages/engine/src/records/ideas.ts
  - packages/engine/src/backlog/lane/propose.ts
  - packages/engine/test/box/real-box.box.test.ts
priority: high
type: bug
ordinal: 460000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a run to start whatever characters a backlog file name holds, and to see why a box was not made ready, so that one odd file name never silently stops all work.

M3 (0022), a bug from 2026-11-10. Evidence: from 14:23 (commit 12619436) to 16:24 every story run failed right after "the install in the box passed". The daemon log held only `INFO deleted a box ... why="it could not be made ready"`, even at debug level. The reason showed nowhere: not on the desk, not in `dipo watch`, not in the log. The story went back to NEXT UP each time. Three drafts had landed whose file names held a non-ASCII "…" (U+2026) and backticks, for example `backlog/drafts/draft-9 - The-overlays-`open`-and-`shell`-lines-...-l….md`. After PR #660 renamed them to ASCII, the next run (run_01M734FC87XPP7P178BBM96EV1) passed the check at once. Longer ASCII paths in the tree (dipo-359, 136 bytes) never failed, so the length is not the cause; the non-ASCII byte is.

Where it fails: `BoxLifetime.#ready` (packages/engine/src/box/lifetime.ts:400-430) runs the install, then `boxes.changedSinceStart` (packages/engine/src/box/parts.ts:1381-1415), which takes `/work` out of the box as a tar (`partArchiveCommand`, parts.ts:394-416, GNU tar in the box), extracts it on the Mac (`extractArchive`, packages/engine/src/box/cache-extract.ts:246), walks it (`readPartFiles`, parts.ts:699-722) and compares the names with `git ls-tree -r -z` of the start commit (`listTree`, packages/engine/src/git/tree.ts:25-30) in `comparePart` (parts.ts:314-356). A box name that differs by one byte from the tree's counts as an added path plus a deleted one, so the result is `changed`. It was `changed`, or a refusal that logs nothing (cap, ignoreFile, ignoreWork, storyFolder): an exception in the check and a refused archive both log a WARN (parts.ts:1408, :1635), and none was in the log.

Ruled out on the Mac side (code reading and a scratch check on 2026-11-10): `ls-tree -z` prints raw bytes, so `core.quotePath` never applies; the system tar unpacks `git archive`'s pax path with the "…" byte-exact even with only PATH in its environment (`unpack`, packages/engine/src/box/code.ts:98-124); `extractArchive` reads that name byte-exact from both a GNU (`L`) and a pax archive; "…" has no canonical decomposition, so NFC against NFD does not change it (it would for "é"). Not checked, since only a real box can: the copy into the box (`container copy` through `copyInAsUser`, packages/engine/src/box/user.ts:120-140, packages/engine/src/box/apple-args.ts:329-330), the box user's `cp -R` into `/work` (user.ts:77), and GNU tar's names out of the box under the box's locale. The first criterion finds which of these changes the name and fixes that hop; the tree check stays byte-exact.

Why nothing showed the reason: `#make` discards the box with the fixed why "it could not be made ready" (lifetime.ts:390) and returns the reason to the launch, whose `fail` (packages/engine/src/run/launch.ts:419-423) hands it to the claim as `{ reason, log }`. The claim rolls back and puts the reason only in an `engine.notice` with code `setup.failed` (packages/engine/src/worktree/claim.ts:174-188). The desk shows no such notice (`DESK_NOTICES`, packages/tui/src/desk.tsx:86-90), `dipo watch` prints it only while it is running, and nothing reads `ClaimSkip.log` or `ClaimSetupFailed.log` (claim.ts:82, :96), so the daemon log never gets the reason. DIPO-484 makes failed audits and sessions show their cause; it does not cover a launch whose box was not made ready, so that part stays here.

Where the "…" comes from: an accepted idea's title is cut to 120 characters with "…" by `capped` (packages/engine/src/run/idea-answers.ts:77-80) through `draftWords` in `ideaDraft` (:132, `DRAFT_CAPS.title` at :58), after the idea's own cut (`ideaTitle`, packages/engine/src/records/ideas.ts:61-70, `IDEA_CAPS.title` in packages/contract/src/ideas.ts:33). The backlog lane files it with `draft create` (packages/engine/src/backlog/lane/propose.ts:94, :130-152), and the Backlog CLI builds the file name from the title.

The tree check is a guard (CLAUDE.md, R30): it stops a run whose install changed files git does not ignore. The old check caught a rewritten lockfile, a generated tracked file and a deleted tracked file; each is still caught, with a test. Bypass forms to test: a changed file whose name is non-ASCII still counts as changed; a tracked file renamed by the install counts as changed; a name with quoting characters (backticks, quotes, spaces) counts like any other. The fail-closed test runs on the real path: a real temporary git repository holding such names, through the real `changedSinceStart`.

```dipo
branch: "DIPO-488/box-path-check"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(box, DIPO_TEST_BOX=1) a box made from a start commit whose paths hold …, é in NFC and NFD, other UTF-8, backticks, spaces and quotes, after an install that writes nothing, gives changedSinceStart same"
    - kind: "automated"
      check: "(unit) changedSinceStart on a real temporary git repository with such names: an unchanged tree is same; a changed, deleted or renamed file with a non-ASCII or quoted name is changed and named"
    - kind: "automated"
      check: "(unit) the old check still catches a rewritten lockfile, a generated tracked file and a deleted tracked file"
    - kind: "automated"
      check: "(unit) a launch whose box is not made ready logs WARN with the run, the story and the reason, and the desk and dipo watch show the reason"
    - kind: "automated"
      check: "(unit) an accepted idea whose title is longer than the cap becomes a draft title cut on a word boundary, ASCII only at the cut, with no …, and its file name holds no …"
    - kind: "manual"
      check: "On main of the scratch repository, add a draft whose file name holds … and backticks, then start a Ready story with dipo run --box"
      expect: "The run passes the check after the install and its worker starts"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A box made from a start commit whose paths hold non-ASCII characters (…, é in NFC and NFD, other UTF-8), backticks, spaces or quotes passes the check after an install that writes nothing; the hop that changed such a name (the copy into the box, the copy into /work or the tar out of it) is found by a box test and fixed
- [ ] #2 The tree check compares paths byte-exact and unquoted end to end (git -z output, no core.quotePath quoting, no Unicode normalisation), with tests for …, other UTF-8, backticks, spaces and quotes
- [ ] #3 The old check still catches a rewritten lockfile, a generated tracked file and a deleted tracked file, each with a test
- [ ] #4 Bypass forms have tests: a changed file whose name is non-ASCII or quoted still counts as changed and is named, and a tracked file the install renamed counts as changed
- [ ] #5 A fail-closed test on the real path runs the real changedSinceStart against a real temporary git repository holding such names: an unchanged tree is same, a changed one is changed
- [ ] #6 A launch whose box is not made ready logs WARN with the run, the story and the reason (not only the fixed why of the box's deletion), and the reason shows on the desk and in dipo watch; DIPO-484 does not cover this launch path
- [ ] #7 dipo never cuts a draft's or idea's title with … into a file name: a title over the cap is cut on a word boundary with no non-ASCII mark added, with a test
<!-- AC:END -->
