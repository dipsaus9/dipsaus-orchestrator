---
id: DIPO-80
title: Adopt open dipo/backlog-* PRs after a lost database
status: To Do
assignee: []
created_date: '2026-10-14 13:14'
updated_date: '2026-10-14 13:15'
labels:
  - 'tier:M'
milestone: m-1
dependencies:
  - DIPO-56
references:
  - packages/engine/src/backlog/pr/
  - packages/engine/src/platform/host.ts
  - packages/engine/src/backlog/lane/
  - packages/engine/src/reconcile/
priority: medium
type: feature
ordinal: 71000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: after the state database is lost or replaced, dipo finds the office's open backlog PR (`dipo/backlog-*`) on the code host and takes it over, so the merge slot can merge it again once its structural check passes.

Context: found in the DIPO-36 and DIPO-74 live tests (2026-10-14) and recorded on DIPO-56. A fresh state database does not know the office's open backlog PR (for example scratch PR #5), so the merge slot never merges it. It was left out of DIPO-56 because it needs more than reconcile:
- the code host has no call that lists open PRs by head-branch prefix (`platform/host.ts` only finds a PR by exact head);
- adopting the PR means writing `backlog_prs` and lining the planning lane's open branch and journal up with a branch the engine no longer journaled (0010 section 2);
- the gate decisions that the structural check requires for each new Ready are lost with the database, so an adopted PR that sets Ready fails its check until the gate passes again.
References: 0007 section 6 (reconcile), 0010 section 2 (lane b, structural check), 0016 rule 1, DIPO-35, DIPO-73, DIPO-56.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP`.

```dipo
branch: "DIPO-80/adopt-open-dipo-backlog-prs-after-lost"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a fresh database with one open dipo/backlog-* PR on a fake host adopts it into backlog_prs and the lane, and the merge slot merges it once the check passes."
    - kind: "automated"
      check: "(engine) two open dipo/backlog-* PRs, or a new Ready without a gate decision, give a notice and no merge."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 At daemon start and on office.rescan, reconcile lists the open pull requests on the office's repository whose head branch starts with dipo/backlog- through the code host, and a new code-host listing call does that without changing the existing ones.
- [ ] #2 An open dipo/backlog-* PR that backlog_prs does not know is adopted into backlog_prs and the lane, so the merge slot and the lane treat it as the office's backlog PR, with an engine.notice; at most one backlog PR stays open per office.
- [ ] #3 The structural check of an adopted PR runs as for any backlog PR; a new Ready with no stored gate decision (lost with the database) fails it with a notice naming the story, and nothing is merged until the gate passes again.
- [ ] #4 More than one open dipo/backlog-* PR, or one whose branch the lane cannot rebuild from, is reported with a notice and not adopted; nothing is closed or force-pushed.
<!-- AC:END -->
