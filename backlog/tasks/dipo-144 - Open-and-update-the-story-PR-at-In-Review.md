---
id: DIPO-144
title: Open and update the story PR at In Review
status: Ready
assignee: []
created_date: '2026-10-17 12:51'
updated_date: '2026-10-18 14:29'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-140
  - DIPO-141
  - DIPO-142
references:
  - packages/engine/src/story-pr/
  - packages/engine/src/run/verify-commit.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/views/
  - packages/daemon/src/
  - packages/engine/test/story-pr/
  - packages/engine/test/db/
priority: high
type: feature
ordinal: 133000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each In Review push opens or updates one ready PR with a code-built title and body, recorded in story_prs and shown as StoryView.pr and the story.pr event, so a delivered story has its PR without the maintainer.

Context: implements ADR 0019 section 3 (the story PR: when it opens, the record, ready not draft, title, body) and the story_prs table of section 16. M0 ends the run at In Review after the push and opens no PR (0019 fact 4, run/verify-commit.ts; 0010 section 7 says the PR opens in M1).

```dipo
branch: "DIPO-144/open-story-pr-at-in-review"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the title builder maps each story type and applies the subject rules, including an acronym and a cut at 100 characters"
    - kind: "automated"
      check: "(unit) the body renders in section order, keeps the contract whole at the 20,000 character cap and skips an update with an unchanged hash"
    - kind: "automated"
      check: "(unit) with a fake host, an existing open PR is reused after a crash between push and create"
    - kind: "automated"
      check: "(migration) story_prs exists with retention tier S"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Right after the In Review push the engine looks for an open PR with the story branch as head and creates a ready PR, not a draft, when none exists; every later In Review push updates the same PR, and a crash between push and create never opens a second one
- [ ] #2 The title is <type>(<ID>): <subject>, with feature and enhancement mapped to feat, bug to fix, docs and spike to docs and every other type to chore, and the subject being the story title without trailing full stops, first letter lowercased unless the second character is uppercase, cut to at most 100 characters on a word boundary
- [ ] #3 The body is built by code in the order outcome, criteria ticked as in the task file, test plan, declared scope, status block, footer; it is at most 20,000 characters with the story contract never cut, and is updated only when its stored hash changes
- [ ] #4 A story_prs row (key, run, number, URL, branch, base, pushed head, state, body hash, opened and closed times; retention tier S) is written per PR, StoryView.pr shows it, and story.pr is emitted when a PR opens, changes state or gets a new head
- [ ] #5 A failed create raises a pr.openFailed notice, the story stays In Review, and a retry every polling.prStateSeconds creates the PR
<!-- AC:END -->
