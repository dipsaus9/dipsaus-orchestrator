---
id: DIPO-332
title: Tear down a box run's worktree whose files only lag its branch
status: Refined
assignee: []
created_date: '2026-10-23 12:10'
updated_date: '2026-10-23 13:09'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/worktree/teardown.ts
  - packages/engine/src/worktree/done.ts
  - packages/engine/src/worktree/done-elsewhere.ts
  - packages/engine/src/reconcile/done-on-base.ts
  - packages/engine/src/run/conflicts.ts
  - packages/engine/test/worktree/lagging-worktree.test.ts
priority: high
type: bug
ordinal: 316000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found live on 2026-10-23 (temp office, DIPO-325, DIPO-311 and DIPO-120). After dipo's merge slot squash-merged a box run's PR, dipo never removed its Mac worktree. A box part is committed on the story branch by git plumbing and never touches the Mac worktree's files, while dipo's own task-file commits update the task file there; so the worktree holds the claim's code files plus a later task file, and `git status` lists every delivered file. The DIPO-302 rule (all files equal the start commit, or all equal the tip) does not hold for that mix, so the teardown kept it (teardown.kept), and later the release listed it as leftovers (doneElsewhere.leftovers). DIPO-311 was classed Done elsewhere although its own PR merged it, its local branch was gone while its worktree stayed (HEAD 00000000, every file added), and DIPO-325 got a conflict.inReview notice after it was Done and merged.

```dipo
branch: "DIPO-332/teardown-lagging-worktree"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, real git) lagging-worktree.test.ts: a box run whose Mac worktree only lags its branch (code files at the claim, task file at a later dipo commit) is removed by the Done teardown and by the done-elsewhere release"
    - kind: "automated"
      check: "(unit, real git) lagging-worktree.test.ts: a worktree with a change only it holds (a real edit, a staged-only change, a mode change, an unrelated untracked file) is kept with its files listed"
    - kind: "automated"
      check: "(unit, real git) lagging-worktree.test.ts: the DIPO-311 path: a story whose own PR merged is torn down as done, not released as done elsewhere, by reconcile and the Done poll, and a kept worktree keeps its branch"
    - kind: "automated"
      check: "(unit, real git) conflicts.test.ts: a story Done on the base (its own PR merged, or its status Done) gets no conflict.inReview notice"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Done teardown and the done-elsewhere release of a box run remove its Mac worktree when every difference git lists there is the worktree lagging the branch (its working files equal the claim's commit or any commit dipo made on the branch), and keep it, as today, when a file differs from all of them (a change only the worktree holds)
- [x] #2 The cause why DIPO-311 was classed done elsewhere after its own PR merged, and why its local branch was gone before the teardown, is found and fixed, or named with a reason in the story
- [x] #3 A Done story gets no conflict or catch-up notice (the conflict check skips stories that are Done on the base)
- [x] #4 Tests on real git cover: a box run whose worktree lags its branch (removed), one with a real local edit (kept), the DIPO-311 path, and no conflict notice for a Done story
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Causes found:

- Kept worktree (DIPO-325): the DIPO-302 rule took a worktree as clean only when all its files equalled the start commit, or all equalled the tip. A box run's worktree is a mix: dipo's task-file commits (`commitFromCopy`) also write the task file there, while parts and the close-out move the branch without touching the worktree. Neither commit matched as a whole, so `git worktree remove` without `--force` refused it. Fix: `worktree/lagging.ts` (`unlaggedPaths`) compares each path git status lists, by its working file (content, mode, absence) and its index entry, with the start commit, the claim commit and the first-parent commits the tip and the PR's recorded head hold above the start. Only when every path matches does the teardown, the done-elsewhere release or a drop use `--force`. A path that matches nothing keeps the worktree, and the notice lists only those paths. An unmerged entry, an assume-unchanged or skip-worktree entry, a folder, a nested repository or a git error also keeps it.
- DIPO-311 classed done elsewhere: reconcile (`done-on-base.ts`, at daemon start and on every rescan) released any live claim whose story read Done on `_base`, without checking whether its own branch got it there. After the merge slot merged a PR, the claim stayed live (teardown kept, or a worker host's exit not yet seen, DIPO-328), so the next reconcile released it as `done-elsewhere`. The Done poll could do the same when the host gave no answer and `merge-tree` no longer saw the squash-merged branch as Done because the base had moved on over the same lines. Fix: reconcile leaves a claim whose own story PR is recorded merged, or that `merge-tree` finds Done, to the Done poll. The Done poll never releases a claim with a recorded merged PR as done elsewhere, and `detectDone` takes the recorded merged PR as evidence when the host gives none.
- DIPO-311's local branch gone before its worktree: `settleDoneElsewhere` deleted a branch that adds nothing to the base even when it had just kept the worktree, which left the worktree on a missing branch (HEAD 00000000, every file listed as added). Neither the merge slot (it deletes no local branch) nor the Done teardown (it deletes the branch only after the worktree is gone) did this. Fix: a kept worktree keeps its branch. `dipo discard` removes both.
- DIPO-325's conflict.inReview after Done: the In Review conflict check (`inReviewRunIds`) took every run ended In Review with a live claim, including a merged story whose teardown was waiting. Fix: it skips a run whose own PR is recorded merged, or whose story's status reads Done.

Review fixes (2026-10-23):
- A submodule (an index entry of mode 160000, or a submodule folder) makes the worktree unjudgeable, so git's own refusal keeps it. git status can hide its commits (submodule.<name>.ignore).
- git worktree remove deletes ignored files, forced or not. removeWorktree now lists them (ls-files --others --ignored --exclude-standard --directory) and keeps the worktree, naming them, when any is outside REBUILDABLE_IGNORED (lagging.ts: node_modules and the usual build, cache and coverage folders, plus .DS_Store), or when an ignored folder holds a repository.
- Each commit is compared on the listed paths only (ls-tree with :(literal) pathspecs, up to 256 paths).
- A claim whose own PR is recorded merged, but whose branch moved past that head with changes the base lacks, is released as done by the Done poll or reconcile. Its worktree and branch are settled as leftovers with the dipo discard action (releaseMovedPastMerge).
- The PR poll records the host's head when it records the merged transition.
- Real-git tests cover the submodule, the ignored files, assume-unchanged, skip-worktree, unmerged entries and symbolic links.

Second review fixes (2026-10-23):
- The only ignored entries a removal may delete are a whole ignored node_modules/ folder (the entry itself) with no .git file or folder anywhere inside it, found by a walk that follows no link, and a .DS_Store file. Anything else ignored keeps the worktree, also below a tracked folder such as build/, and so does a failed walk.
- The ignored check runs right before the removal. Before a forced removal, the status and lagging check runs once more, and any change keeps the worktree.
- A claim with an open park whose PR merged and whose branch moved past it is not released. The Done poll and reconcile tell the maintainer in a notice instead, and the park stays on the desk.
<!-- SECTION:NOTES:END -->
