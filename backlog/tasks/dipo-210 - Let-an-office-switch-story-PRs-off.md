---
id: DIPO-210
title: Let an office switch story PRs off
status: Refined
assignee: []
created_date: '2026-10-19 08:49'
updated_date: '2026-10-19 08:54'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-144
references:
  - packages/engine/src/config/
  - packages/engine/test/config/
  - packages/engine/test/office/
  - packages/engine/schema/
  - packages/engine/scripts/write-schema.ts
  - packages/engine/src/story-pr/
  - packages/engine/test/story-pr/
  - .dipo/office.yaml
priority: high
type: feature
ordinal: 210000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an office can switch story PRs off with the office key storyPr.open, and this repository does, so dipo opens no GitHub PR while the maintainer side merges its own finish-branch PRs.

Context: DIPO-144 makes the engine open the story PR at the first In Review push and keep it updated (0019 section 3, decided B). No office key turns that off: StoryPrs is always wired in the daemon (packages/daemon/src/foreground.ts) and verify-commit calls storyPr.sync after every In Review push that reached the remote. On this repository the maintainer side never touches dipo's own branch; it opens and merges a PR from a -finish branch with main merged in and the review fixes on top, so dipo's PR would be a second one per story. The maintainer decided on 2026-10-19 (option A) to add the switch first and keep the temp daemon on a binary without DIPO-144 until it lands; the 0019 note is in docs/decisions/0019-review-loop.md (Amendments, 2026-10-19, DIPO-210), and this story does not edit docs/decisions/.

The key is checked through deps.offices.config(officeId) in StoryPrsDeps (packages/engine/src/story-pr/). With it off, StoryPrs opens, updates, polls and retries nothing for that office and raises no pr.openFailed notice; the story stays In Review as today. office.local.yaml gains no key, so the switch is committed with the repository. It takes the next free office config version, 7 (OFFICE_CONFIG_VERSION is 6, DIPO-188), with its in-memory migration (0017 amendment of 2026-10-12); DIPO-164 then takes 8.

Delivery: this story changes .dipo/office.yaml, which a dipo worker cannot write, so it is delivered by hand.

```dipo
branch: "DIPO-210/story-pr-switch"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) office config version 7: a version 6 office.yaml migrates in memory with storyPr.open true, storyPr.open false is read, an older file that names storyPr gets the version hint, office.local.yaml refuses the key, and the committed office.schema.json equals the generator output"
    - kind: "automated"
      check: "(engine) with storyPr.open false a fake host records no create, edit or view call across an In Review push, a later push and a poll, and no pr.openFailed notice is raised; with the default true the existing story-pr tests pass unchanged"
    - kind: "automated"
      check: "(unit) resolveOfficeConfig on the committed .dipo/office.yaml succeeds and gives storyPr.open false"
    - kind: "manual"
      check: "(live) with the binary built after this story and .dipo/office.yaml setting storyPr.open: false, run one story on this repository to In Review"
      expect: "no GitHub PR is opened from the story branch and no pr.openFailed notice appears"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Office key storyPr.open (default true) arrives in office config version 7 with its in-memory migration from 6, KEY_ADDED_IN names it, packages/engine/schema/office.schema.json is regenerated, the tests that pin the config version are updated, and office.local.yaml does not accept it
- [ ] #2 With storyPr.open false the engine opens, updates, polls and retries no story PR for that office and raises no pr.openFailed notice, shown by a test whose fake host counts zero calls
- [ ] #3 With storyPr.open true or absent the story PR behaviour of DIPO-144 is unchanged and its tests pass
- [ ] #4 .dipo/office.yaml sets version: 7 and storyPr.open: false, with a comment that says the maintainer side merges its own finish-branch PRs on this repository until the review loop takes over, and a test loads the committed file and gets storyPr.open false
<!-- AC:END -->
