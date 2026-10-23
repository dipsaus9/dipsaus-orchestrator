---
id: DIPO-166
title: File follow-up and spike proposals from a worker
status: Done
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-23 10:04'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-158
  - DIPO-160
  - DIPO-186
  - DIPO-284
  - DIPO-159
  - DIPO-290
  - DIPO-149
  - DIPO-292
  - DIPO-294
  - DIPO-295
  - DIPO-296
  - DIPO-152
references:
  - '- packages/contract/src/'
  - docs/decisions/0019-review-loop.md
  - docs/decisions/0020-park-and-resume.md
  - packages/cli/src/
  - packages/cli/src/index.ts
  - packages/cli/src/propose-command.test.ts
  - packages/cli/src/propose-command.ts
  - packages/contract/schema/
  - packages/contract/schema/commands.schema.json
  - packages/contract/schema/events.schema.json
  - packages/contract/src/fixtures.ts
  - packages/contract/src/office.ts
  - packages/contract/src/work.test.ts
  - packages/daemon/src/
  - packages/daemon/src/foreground.ts
  - packages/engine/src/backlog/lane/
  - packages/engine/src/backlog/lane/feature.ts
  - packages/engine/src/backlog/lane/index.ts
  - packages/engine/src/backlog/lane/lane.ts
  - packages/engine/src/backlog/lane/ops.ts
  - packages/engine/src/backlog/lane/propose.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/migrations/0049-proposal-decisions.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/features.ts
  - packages/engine/src/reads/hello.ts
  - packages/engine/src/retention/
  - packages/engine/src/run/
  - packages/engine/src/run/control.ts
  - packages/engine/src/run/index.ts
  - packages/engine/src/run/proposals.ts
  - packages/engine/src/run/report-data.ts
  - packages/engine/src/workers/
  - packages/engine/test/db/
  - packages/engine/test/db/proposal-decisions.test.ts
  - packages/engine/test/db/worker-report-data.test.ts
  - packages/engine/test/run/
  - packages/engine/test/run/proposals-lane.test.ts
  - packages/engine/test/run/proposals.test.ts
priority: high
type: feature
ordinal: 137200
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the stored worker proposals are shown on the desk, and accepted ones become Backlog drafts through the backlog lane, so improvements a worker sees beyond its story reach the maintainer; storing the proposals is DIPO-259.

Context: the maintainer's decision D6 of 2026-10-20 split this story: DIPO-259 (166a) adds the proposals report field and the proposals table now; this story (166b) keeps the desk listing (after DIPO-158), the commands, the events and the CLI. Implements ADR 0020 section 11c (improvements beyond the story; maintainer decision c), the proposals table of section 15 and the proposal commands and events of section 14.

```dipo
branch: "DIPO-166/worker-follow-up-proposals"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the desk lists open proposals, spike before follow-up, each with its accept and dismiss commands"
    - kind: "automated"
      check: "(unit) accept creates a draft through lane b with the outcome and references, and dismiss closes it; both emit proposal.closed, and a stored proposal emits proposal.filed"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Each proposal DIPO-259 stores emits proposal.filed, behind the capability flag proposals in reads/hello.ts
- [x] #2 The desk lists open proposals, spike before follow-up, each with dipo propose accept <id> and dipo propose dismiss <id>
- [x] #3 proposal.accept creates a Backlog draft through lane b with backlog draft create, carrying the title, the outcome line, the paths as references and the source story in the description; proposal.dismiss closes the proposal; both emit proposal.closed, behind capability flag proposals in reads/hello.ts
- [x] #4 dipo propose accept|dismiss <proposal> exists in the CLI and sends proposal.accept or proposal.dismiss
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-23: built outside dipo, reviewed (pass; five advisories fixed: no home-relative paths, list markers stripped from titles, a forged marker line never counts as filed, no second filing, error code proposal.notOpen). Accepted proposals become Backlog drafts, as 0020 section 11c says. Migration 0049.
<!-- SECTION:NOTES:END -->
