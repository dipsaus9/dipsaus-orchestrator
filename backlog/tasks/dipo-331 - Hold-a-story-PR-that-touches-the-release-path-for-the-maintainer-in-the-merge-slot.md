---
id: DIPO-331
title: >-
  Hold a story PR that touches the release path for the maintainer in the merge
  slot
status: Done
assignee: []
created_date: '2026-10-23 11:28'
updated_date: '2026-10-23 13:34'
labels: []
milestone: m-1
dependencies: []
references:
  - packages/engine/src/merge-slot/
  - packages/engine/test/merge-slot/
  - packages/engine/src/db/migrations/0053-merge-gate-hand-merge.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/merge-slot/commands.ts
  - packages/engine/src/merge-slot/gates.ts
  - packages/engine/src/merge-slot/index.ts
  - packages/engine/src/merge-slot/release-path.ts
  - packages/engine/src/merge-slot/story-git.ts
  - packages/engine/src/merge-slot/story-slot.ts
  - packages/engine/src/views/desk.ts
  - packages/engine/test/merge-slot/commands.test.ts
  - packages/engine/test/merge-slot/no-bypass.test.ts
  - packages/engine/test/merge-slot/release-path-slot.test.ts
  - packages/engine/test/merge-slot/release-path.test.ts
  - packages/engine/test/merge-slot/story-helpers.ts
  - packages/engine/test/merge-slot/story-slot.git.test.ts
priority: medium
type: feature
ordinal: 311000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up of DIPO-321 (0016 amendment of 2026-10-23). A PR that changes .github/, install.sh, renovate.json or the release-please config needs the maintainer's code owner approval, which for a PR opened with the maintainer's login is the bypass merge. dipo's merge slot would try to merge such a story PR and fail. It must hold the PR for the maintainer instead, and never pass --admin.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The merge slot reads the release-path list (the paths .github/CODEOWNERS assigns to the maintainer) and, for a story PR whose diff touches one, holds it with a merge gate that only the maintainer's merge on the host resolves
- [x] #2 dipo never passes --admin or any bypass to gh pr merge; a test checks the merge call
- [x] #3 The desk names the held PR and says the maintainer merges it on the host
- [x] #4 Tests cover a held PR, a PR outside the list, and the hand merge closing the gate
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done 2026-10-23 (maintainer session): built outside dipo, reviewed by a separate agent (all criteria met; its advisories are fixed: unknown CODEOWNERS syntax counts as owned, the base is fetched before the last check, mode and delete cases, the desk's parks text)
<!-- SECTION:NOTES:END -->
