---
id: DIPO-448
title: >-
  Keep a planning session's decisions and continue it in a fresh Claude session
  when needed
status: Parked
assignee: []
created_date: '2026-11-05 20:51'
updated_date: '2026-11-06 13:21'
labels:
  - 'tier:M'
milestone: m-3
dependencies:
  - DIPO-447
references:
  - packages/engine/src/db/migrations/
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/run/session-run.ts
  - packages/engine/src/records/usage.ts
  - packages/contract/src/office.ts
  - docs/decisions/0007-state-database.md
modified_files:
  - docs/decisions/0007-state-database.md
  - packages/contract/schema/commands.schema.json
  - packages/contract/schema/events.schema.json
  - packages/contract/src/office.ts
  - packages/contract/src/work.test.ts
  - packages/contract/src/work.ts
  - packages/contract/test/fixtures.ts
  - packages/engine/src/db/migrations/0003-planning-records.ts
  - packages/engine/src/db/schema.ts
  - packages/engine/src/prompts/task/planning.md
  - packages/engine/src/prompts/templates.ts
  - packages/engine/src/records/planning-record.ts
  - packages/engine/src/records/usage.ts
  - packages/engine/src/retention/policy.ts
  - packages/engine/src/retention/run.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/test/db/migrations.test.ts
  - packages/engine/test/prompts/task.test.ts
  - packages/engine/test/run/planning-record.test.ts
  - packages/engine/test/run/planning-session.test.ts
  - packages/engine/test/run/planning-world.ts
priority: high
type: feature
ordinal: 421000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to keep every decision of a planning session in its own record and continue the session in a fresh Claude session when the context fills or the session was stopped, so that a long planning session never loses what we decided.

M3 (0022), the maintainer's answer to a filling context. Needs DIPO-447.

A record per session in dipo's database (one table; the maintainer's office scope like other tables, 0007): each entry is a confirmed choice (question and answer), a filed or edited story id, or an open question, with its time. Entries are written by code when the maintainer confirms (DIPO-450 adds filed stories). When Claude's context nears full (from the usage dipo already counts, or a compaction fact) or a session continues after its Claude session ended (idle end, daemon restart), dipo ends that Claude session and starts a fresh one whose first message code builds from the record: the goal, the decisions, the filed stories and the open questions, plus the facts of DIPO-447's first message. An event says the session continued in a fresh session. Retention keeps a session's record until the session ends and then for the usual aged period.

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-448/planning-decision-record"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) each confirmed choice, filed or edited story and open question is stored in the session's record in order"
    - kind: "automated"
      check: "(unit) near a full context, and on a continue after the Claude session ended or the daemon restarted, a fresh Claude session starts whose first message holds the goal, decisions, filed stories and open questions, and an event says so"
park:
  reason: "verify-failing"
  from: "In Review"
  note: "required checks were red on 2 pushed heads (the CI cap is 2). Required check ci-ok failed on the pushed head.\nJob: ci-ok\nFailing steps: none found\nLink: https://github.com/dipsaus9/dipsaus-orchestrator/actions/runs/42224053430/job/127915192625\nLocations:\n- none found\nLast log lines:\nno log: it failed because other jobs of its workflow run failed (verify (3)).\nBudget: 70 turns used, 130 left; 17 minutes used, 73 left; 243,285 tokens used, 556,715 left.\n\nRequired check verify (3) failed on the pushed head.\nJob: verify (3)\nFailing steps: bun test on this shard's files\nLink: https://github.com/dipsaus9/dipsaus-orchestrator/actions/runs/42224053430/job/127913290635\nLocations:\n- packages/contract/scripts/schema.test.ts:23:25\nLast log lines:\n[dipo: showing the last 43 of 3,198 output lines.]\n(pass) worker report schema > exports a JSON Schema without a dialect line that requires the core fields and the test plan [0.03ms]\n(pass) worker report schema > refuses unknown fields and a missing summary [0.07ms]\n\n##[endgroup]\n\n##[group]packages/engine/test/config/schema-file.test.ts:\n(pass) office.schema.json > rejects unknown keys and has no privacy or retention keys [2.68ms]\n(pass) office.schema.json > equals a fresh export (run `bun packages/engine/scripts/write-schema.ts` and commit it) [1.90ms]\n(pass) office.schema.json > says that prompt budget letters are project size classes, not tiers [1.99ms]\n\n##[endgroup]\n\n##[group]packages/contract/src/runtime-layout.test.ts:\n(pass) the records > read a runtime record only with every field [0.08ms]\n(pass) the records > read a PID record with a null runtime directory, and refuse a broken one [0.08ms]\n(pass) the software folders > see the test marker in any of the environments [0.04ms]\n(pass) the software folders > are under the passwd home's Library, or under DIPO_HOME for tests [0.10ms]\n(pass) the software folders > tell a folder inside another apart from one that only shares a prefix [0.44ms]\n(pass) the software folders > never count <dir>/../x as inside <dir>, and resolve . and .. before they compare [0.14ms]\n(pass) the environment of a detached process > drops the Bun flag and supervisor variables and unset values [0.04ms]\n(pass) the folder checks > take a private directory of this user, and say why another is refused [0.11ms]\n(pass) the folder checks > refuse a runtime directory too long for every socket path [0.10ms]\n\n##[endgroup]\n\n1 tests skipped:\n(skip) dipo daemon lifecycle on the compiled binary > starts, reports, restarts and stops the daemon, and autostarts it for a command\n\n\n4 tests failed:\n(fail) JSON Schema export > events.schema.json equals a fresh export (run `bun run contract:schema` and commit packages/contract/schema/) [3.42ms]\n(fail) JSON Schema export > commands.schema.json equals a fresh export (run `bun run contract:schema` and commit packages/contract/schema/) [2.51ms]\n(fail) JSON Schema export > reads.schema.json equals a fresh export (run `bun run contract:schema` and commit packages/contract/schema/) [4.25ms]\n(fail) JSON Schema export > work.schema.json equals a fresh export (run `bun run contract:schema` and commit packages/contract/schema/) [3.06ms]\n\n --seed=1338286120\n 2218 pass\n 1 skip\n 4 fail\n 97942 expect() calls\nRan 2223 tests across 188 files. [221.55s]\nerror: script \"test\" exited with code 1\n##[error]Process completed with exit code 1.\nBudget: 70 turns used, 130 left; 17 minutes used, 73 left; 243,285 tokens used, 556,715 left."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 dipo stores a record per planning session in its database: each confirmed choice, filed or edited story and open question, in order
- [x] #2 When the context nears full, dipo ends the Claude session and starts a fresh one whose first message code builds from the record
- [x] #3 A session that continues after its Claude session ended, after an idle end or a daemon restart, continues in a fresh Claude session built from the record
- [x] #4 An event says the session continued in a fresh Claude session, and ADR 0007 lists the record
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-06 13:21 UTC: verify-failing
- Detail: required checks were red on 2 pushed heads (the CI cap is 2). Required check ci-ok failed on the pushed head.
- Run: run_01M6RDZS9GM3QCAP758JP8JEDV
- Criteria met: 4 of 4 (as the worker reported them)
- Loops: 0 of 5; CI attempts: 2 of 2
- Review rounds: 2, failed 1 of 3
- Budget used: 243,285 of 800,000 tokens; 70 of 200 turns; 18 of 90 minutes
- Last good commit: 1040a29b74d566591eed67b43ab9a573c829bfbc
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-06 13:08 UTC
- Criteria met: 4 of 4 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 2, failed 1
- Budget used: 215,965 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
