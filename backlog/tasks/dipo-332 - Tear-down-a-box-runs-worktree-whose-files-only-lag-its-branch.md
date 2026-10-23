---
id: DIPO-332
title: Tear down a box run's worktree whose files only lag its branch
status: Refined
assignee: []
created_date: '2026-10-23 12:10'
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
- [ ] #1 The Done teardown and the done-elsewhere release of a box run remove its Mac worktree when every difference git lists there is the worktree lagging the branch (its working files equal the claim's commit or any commit dipo made on the branch), and keep it, as today, when a file differs from all of them (a change only the worktree holds)
- [ ] #2 The cause why DIPO-311 was classed done elsewhere after its own PR merged, and why its local branch was gone before the teardown, is found and fixed, or named with a reason in the story
- [ ] #3 A Done story gets no conflict or catch-up notice (the conflict check skips stories that are Done on the base)
- [ ] #4 Tests on real git cover: a box run whose worktree lags its branch (removed), one with a real local edit (kept), the DIPO-311 path, and no conflict notice for a Done story
<!-- AC:END -->
