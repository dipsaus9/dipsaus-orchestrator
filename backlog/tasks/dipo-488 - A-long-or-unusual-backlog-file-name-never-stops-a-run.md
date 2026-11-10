---
id: DIPO-488
title: A long or unusual backlog file name never stops a run
status: Refined
assignee: []
created_date: '2026-11-10 16:34'
updated_date: '2026-11-10 16:42'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/box/user.ts
  - packages/engine/src/box/apple-args.ts
  - packages/engine/src/box/apple-container.ts
  - packages/engine/src/box/lifetime.ts
  - packages/engine/src/box/parts.ts
  - packages/engine/src/box/cache-extract.ts
  - packages/engine/src/box/code.ts
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

M3 (0022), a bug from 2026-11-10. Evidence: from 14:23 (commit 12619436) to 16:24 every story run failed right after "the install in the box passed". The daemon log held only `INFO deleted a box ... why="it could not be made ready"`, even at debug level. The reason showed nowhere: not on the desk, not in `dipo watch`, not in the log. The story went back to NEXT UP each time. Three drafts had landed whose file names had three unusual traits: a non-ASCII "…" (U+2026), backticks, and a path length of 146 to 150 bytes, for example `backlog/drafts/draft-9 - The-overlays-`open`-and-`shell`-lines-...-l….md`. After PR #660 renamed them to plain ASCII, the next run (run_01M734FC87XPP7P178BBM96EV1) passed the check at once.

Which trait, and which hop: a one-off box diagnostic on 2026-11-10 (Apple container 1.6.0, debian:trixie-slim with GNU tar 1.35 and the POSIX locale) fed one git tree with four names (a "…"-only name, a backticks-only name, a 169-byte ASCII-only path, and one with all three) through each hop, comparing name bytes. The tree (`git ls-tree -z`) and the Mac stage (`git archive` unpacked by the system tar, `unpack`, packages/engine/src/box/code.ts:98-124) kept all four byte-exact. `container copy` into the box (`copyInAsUser`, packages/engine/src/box/user.ts:120-140, `copyInArgs`, packages/engine/src/box/apple-args.ts:329-331) turned "…" (bytes e2 80 a6) into one "*" (2a): `ellipsis-only-l….md` arrived as `ellipsis-only-l*.md`. The backticks-only name and the long ASCII path arrived byte-exact, so neither backticks nor length (nor ustar's 100-byte name and 155-byte prefix limits) is the cause. The box user's `cp -R` into `/work` (user.ts:77) and GNU tar's archive out of the box read back through `extractArchive` (packages/engine/src/box/cache-extract.ts:246) kept the already-changed name as it was. So the copy into the box is the hop that changes the name, and only for non-ASCII characters.

Why that fails the check: `BoxLifetime.#ready` (packages/engine/src/box/lifetime.ts:400-430) runs the install, then `boxes.changedSinceStart` (packages/engine/src/box/parts.ts:1381-1415), which compares the box's names with the start commit's tree in `comparePart` (parts.ts:314-356). The box holds `...l*.md` where the tree holds `...l….md`: one added path and one deleted one, so the result is `changed` and the launch stops. The check itself is right to count it; the fix belongs in the copy, so the tree check stays byte-exact and unquoted (`ls-tree -z`, packages/engine/src/git/tree.ts:25-30, no `core.quotePath`, no Unicode normalisation).

Why nothing showed the reason: `#make` discards the box with the fixed why "it could not be made ready" (lifetime.ts:390) and returns the reason to the launch, whose `fail` (packages/engine/src/run/launch.ts:419-423) hands it to the claim as `{ reason, log }`. The claim rolls back and puts the reason only in an `engine.notice` with code `setup.failed` (packages/engine/src/worktree/claim.ts:174-188). The desk shows no such notice (`DESK_NOTICES`, packages/tui/src/desk.tsx:86-90), `dipo watch` prints it only while it is running, and nothing reads `ClaimSkip.log` or `ClaimSetupFailed.log` (claim.ts:82, :96). That notice's hint (claim.ts:187) tells the maintainer to run `dipo daemon logs --level debug` to read the step's output, but no step output reaches the log, so the hint is false. DIPO-484 makes failed audits and sessions show their cause; it does not cover a launch whose box was not made ready, so that part stays here.

Where the "…" comes from: an accepted idea's title is cut to 120 characters with "…" by `capped` (packages/engine/src/run/idea-answers.ts:77-80) through `draftWords` in `ideaDraft` (:132, `DRAFT_CAPS.title` at :58), after the idea's own cut by a second, duplicate `capped` (`ideaTitle`, packages/engine/src/records/ideas.ts:61-70, `IDEA_CAPS.title` in packages/contract/src/ideas.ts:33). The backlog lane files it with `draft create` (packages/engine/src/backlog/lane/propose.ts:94, :130-152), and the Backlog CLI builds the file name from the title. One shared title cut replaces both `capped` functions (0001).

The tree check is a guard (CLAUDE.md, R30): it stops a run whose install changed files git does not ignore. The old check caught a rewritten lockfile, a generated tracked file and a deleted tracked file; each is still caught, with a test. Bypass forms to test: a changed file whose name is non-ASCII, backticks-only or a 150-byte-plus ASCII path still counts as changed; a tracked file renamed by the install counts as changed; a name with quoting characters (backticks, quotes, spaces) counts like any other. The fail-closed test runs on the real path: a real temporary git repository holding such names, through the real `changedSinceStart`.

```dipo
branch: "DIPO-488/box-path-check"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the copy into a box, fed a recorded copy whose names hold the mangled bytes (… arrived as *), makes the box's /work hold the tree's names byte-exact, and changedSinceStart then gives same"
    - kind: "automated"
      check: "(unit) changedSinceStart on a real temporary git repository with …, other UTF-8, backticks-only, a 150-byte-plus ASCII path, spaces and quotes: an unchanged tree is same; a changed, deleted or renamed file with such a name is changed and named"
    - kind: "automated"
      check: "(unit) the old check still catches a rewritten lockfile, a generated tracked file and a deleted tracked file"
    - kind: "automated"
      check: "(unit) a launch whose box is not made ready logs WARN with the run, the story and the reason, and the desk and dipo watch show the reason; the setup.failed hint names only where the reason really is"
    - kind: "automated"
      check: "(unit) one shared title cut: an idea or draft title longer than the cap is cut on a word boundary with no … and no other non-ASCII mark added, and both former capped callers use it"
    - kind: "manual"
      check: "Run DIPO_TEST_BOX=1 bun test on the box test that makes a box from a start commit holding a …-only name, a backticks-only name, a 150-byte-plus ASCII path and one with all three"
      expect: "Every name in the box's /work matches the tree byte for byte, and changedSinceStart after an install that writes nothing gives same"
    - kind: "manual"
      check: "On main of the scratch repository, add a draft whose file name holds … and backticks, then start a Ready story with dipo run --box"
      expect: "The run passes the check after the install and its worker starts"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The copy into a box keeps every file name byte-exact, so a non-ASCII name such as … no longer arrives as * (container copy, the hop the 2026-11-10 diagnostic found), with the fix in dipo's copy path; a *.box.test.ts proves it on a real box and the maintainer runs it by hand (a manual test-plan entry, 0017), and a unit test with a recorded copy holding the mangled bytes proves the fix without a box
- [ ] #2 The tree check compares paths byte-exact and unquoted end to end (git -z output, no core.quotePath quoting, no Unicode normalisation), with tests for …, other UTF-8, a backticks-only name, a 150-byte-plus ASCII path, spaces and quotes
- [ ] #3 The old check still catches a rewritten lockfile, a generated tracked file and a deleted tracked file, each with a test
- [ ] #4 Bypass forms have tests: a changed file whose name is non-ASCII, backticks-only, quoted or a 150-byte-plus ASCII path still counts as changed and is named, and a tracked file the install renamed counts as changed
- [ ] #5 A fail-closed test on the real path runs the real changedSinceStart against a real temporary git repository holding such names: an unchanged tree is same, a changed one is changed
- [ ] #6 A launch whose box is not made ready logs WARN with the run, the story and the reason (not only the fixed why of the box's deletion), and the reason shows on the desk and in dipo watch; the setup.failed hint at worktree/claim.ts:187 (run dipo daemon logs --level debug) becomes true because the step's output is logged, or is removed; DIPO-484 does not cover this launch path
- [ ] #7 One shared title cut replaces both capped functions (run/idea-answers.ts:77-80 and records/ideas.ts:61-65) and the duplicate is removed; a title over the cap is cut on a word boundary with no … or other non-ASCII mark added, so dipo never puts … into a file name, with a test
<!-- AC:END -->
