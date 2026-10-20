---
id: DIPO-228
title: List what a drop with --delete-branch loses before the typed id
status: To Do
assignee: []
created_date: '2026-10-20 08:20'
updated_date: '2026-10-20 08:20'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/cli/src/story-commands.ts
  - packages/cli/src/story-commands.test.ts
  - packages/engine/src/stories/planning.ts
  - packages/engine/src/worktree/release.ts
  - packages/engine/src/worktree/records.ts
  - packages/engine/test/backlog/planning.test.ts
  - packages/engine/test/backlog/planning.ci.test.ts
  - packages/contract/src/
  - packages/contract/schema/
priority: medium
type: bug
ordinal: 228000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo drop <id> --delete-branch` shows the commits not on the base and the uncommitted and untracked files it removes before it asks for the typed story id; a release that fails after the story PR was closed says the PR was closed; and --delete-branch deletes the kept branch of an unclaimed story, as its text promises.

Context: review of DIPO-160 (PR #251). 0020 section 8: story.drop with deleteBranch removes a dirty worktree with --force, so clients ask for the typed story id after listing the commits not on the base and the uncommitted and untracked files; with --delete-branch the branch is deleted locally and remotely. dropCommand in packages/cli/src/story-commands.ts asks with a fixed warning, and the test in story-commands.test.ts checks "cannot be undone" and "Type DIPO-7". No read gives the lists: story.detail (packages/contract/src/office.ts) holds the view, the active run, runs, verdicts and questions; dirtyFilesOf in packages/engine/src/worktree/release.ts lists the files; nothing lists the commits. drop in packages/engine/src/stories/planning.ts closes the PR (#closePr commits its closed state) before #release, and a failed release throws "<story> was not dropped: <why>" and withdraws the journal entry while the PR stays closed. Without a live claim drop skips #release, so deleteBranch deletes nothing, while the CLI prints "its worktree and branch are removed"; a branch kept by an earlier release stays open in released_branches (packages/engine/src/worktree/records.ts; releasedBranchFor reads one by key and branch). The same loss list will serve `dipo discard` (work.discard, still provisional).

```dipo
branch: "DIPO-228/drop-lists-losses"
unknowns:
  - q: "Where does the CLI read the loss list from? (a) A new office read (for example story.losses { office, story }, since minor 1) that returns the commits on the story's branch not on the base (short sha and subject) and the uncommitted and untracked files of its worktree, for a live claim or an open released branch; dipo discard and the TUI can use it too. (b) story.detail gains these fields, so every detail read runs git. (c) story.drop gains a dryRun argument that answers the lists and changes nothing. Recommended: (a)."
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) dipo drop --delete-branch prints the commits and files before the typed-id question, says nothing is lost when both are empty, and drops nothing when the read fails"
    - kind: "automated"
      check: "(integration, real git) the read lists one commit not on the base and one untracked file of a claimed story's worktree, and the commits of an unclaimed story's kept branch"
    - kind: "automated"
      check: "(unit) a release that fails after the story PR was closed answers an error naming the closed PR and that the story was not archived"
    - kind: "automated"
      check: "(integration, real git) a drop with deleteBranch and no live claim deletes the kept branch locally and on the bare remote and closes its released_branches row"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Before the typed id, `dipo drop <id> --delete-branch` prints the commits on the story's branch that are not on the base (short sha and subject, at most 20 and a count of the rest) and the uncommitted and untracked files of its worktree (at most 50 and a count of the rest), read from the engine through the read the unknown picks; with neither it says that no commits or files are lost, and when the read fails it prints why and drops nothing
- [ ] #2 The engine side of that read lists the commits in the office's git queue against the base as last fetched and the files as dirtyFilesOf does, for a live claim and for an open released_branches branch of the story, and changes nothing
- [ ] #3 When a drop's release fails after the drop closed the story PR, the error says that PR #<n> was closed and the story was not archived, with the release's reason
- [ ] #4 story.drop with deleteBranch and no live claim deletes, locally and on the remote, each branch with an open released_branches row for the story's key, and sets reclaimed_at on those rows so no later claim reuses a deleted branch
- [ ] #5 Tests in packages/cli/src/story-commands.test.ts show the lists before the typed-id question, the empty case and a failed read dropping nothing, with the existing checks for "cannot be undone" and "Type DIPO-7" kept; tests in packages/engine/test/backlog/planning.test.ts and planning.ci.test.ts cover criteria 2 to 4, the ci test with a real repository and a bare remote
<!-- AC:END -->
