---
id: DIPO-452
title: >-
  Audit every incoming idea by code and a short Claude session before it reaches
  me
status: Refined
assignee: []
created_date: '2026-11-05 20:51'
updated_date: '2026-11-06 09:49'
labels:
  - 'tier:L'
milestone: m-3
dependencies:
  - DIPO-447
references:
  - packages/engine/src/run/proposals.ts
  - packages/engine/src/overview/proposals.ts
  - packages/engine/src/review/verdict.ts
  - packages/engine/src/db/migrations/
  - packages/engine/src/config/schema.ts
  - packages/engine/src/workers/claude-cli/box-plan.ts
  - packages/contract/src/office.ts
  - packages/cli/src/
  - docs/decisions/0002-review-and-testing.md
  - docs/decisions/0007-state-database.md
  - docs/decisions/0020-park-and-resume.md
  - docs/decisions/0022-planning-sessions.md
priority: medium
type: feature
ordinal: 425000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to check every incoming idea first, by code and then by a short Claude session, and keep only the ones that are needed, so that my desk gets few ideas and each one is worth my time.

M3 (0022, rewritten 2026-11-06 from the maintainer's answers). Replaces "every incoming idea becomes a draft": the maintainer wants few items and a first check by dipo. The desk card, accept as draft, `dipo idea` and triage are the next story; this one holds, audits and logs ideas.

Ideas (all four are audited): a worker's proposal (today it waits on the desk for proposal.accept, packages/engine/src/run/proposals.ts, packages/engine/src/overview/proposals.ts), a reviewer's advisory finding (today only in review_verdicts.findings and the PR comment, packages/engine/src/review/verdict.ts), a planning session's aside (an aside block, with a schema in packages/contract that the engine validates, which the planning session sends), and the maintainer's quick idea (its command is the next story). Each idea is kept with its origin and source story in the state database (0007; today's proposals table holds worker proposals only).

When: a run's ideas are audited together after that run is merged or parked, so the audit sees the finished change and never competes with the worker; an idea without a run is audited when it arrives. Code first: an idea equal to one already held, or whose title is that of an open or Done story, is rejected with that reason and no model call. Then one audit session per batch, in the planning session's box with its tools unchanged (DIPO-447), with the office's code and backlog. Pass: no open or Done story already covers it; the problem it names is real in the code, with file and line; it serves a milestone goal or is tech debt. Size is never a reason to reject. The audit answers in a block the engine validates: for a pass a proposed user story (what was found with evidence, the Story line in the 0012 shape, what is proposed, why, and the milestone or tech debt), for a reject its reason. The model is the office setting `audit.model`, default sonnet, a schema default only that is not written into .dipo/office.yaml (a new key there blocks runs until a re-pin); the model proxy counts its usage like any session's (0008).

The audit is its own session kind, mapped to the planning tool set: it does not count as the office's one planning session, holds no run slot, takes one turn and ends after its answer, under the normal watchdog. The idea texts come from workers and reviewers, so they are untrusted: they reach the audit only as quoted data in its prompt, and nothing in them changes its tools. An idea whose audit fails, is cut off or is refused by schema stays held and is audited again at the next trigger; it is never dropped.

Until DIPO-454 lands, a worker's proposal is held as an idea and also still written to the desk unchanged; DIPO-454 removes that desk write together with proposal.accept. Passing ideas are listed by `dipo ideas`. Worker proposals still open on the desk when this lands are held as ideas and audited once (maintainer's choice, 2026-11-06: four such proposals wait for the audit).

Built by dipo where it can (maintainer's choice, 2026-11-05); a builder agent takes over if dipo gets stuck.

```dipo
branch: "DIPO-452/idea-audit"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a worker proposal, a reviewer advisory finding, a session aside and a quick idea are each held as one idea with its origin and source story"
    - kind: "automated"
      check: "(unit) a run's ideas are audited once after the run is merged or parked, never while it runs; an idea without a run is audited when it arrives"
    - kind: "automated"
      check: "(unit) an idea equal to one held, or with the title of an open or Done story, is rejected with its reason and no model call"
    - kind: "automated"
      check: "(unit) with a scripted audit worker, a pass gives a validated proposed user story and a reject keeps its reason; an invalid answer is refused by schema"
    - kind: "automated"
      check: "(unit) the audit session uses the planning session's box plan and tool set and the office's audit.model, default sonnet; it holds no run slot, does not block a planning session and ends after one answer"
    - kind: "automated"
      check: "(unit) the audit prompt states the three pass rules and that size is never a reason to reject, and quotes each idea's text as data"
    - kind: "automated"
      check: "(unit) an idea whose audit fails, is cut off by a restart or is refused by schema stays held and is audited again at the next trigger"
    - kind: "automated"
      check: "(unit) proposals open on the desk before the upgrade are held as ideas and audited once"
    - kind: "automated"
      check: "(unit) a session aside block is validated by its schema and held as an idea; an invalid one is refused with a message"
    - kind: "automated"
      check: "(unit) tools: the planning, review and session tool sets are unchanged; the audit kind spelled in another case or as an alias gets no extra tools; tool or MCP text inside an idea is ignored; an audit plan asking for Bash, Edit or Write is refused on the real adapter"
    - kind: "manual"
      check: "On the scratch repository with a Haiku office, a run whose worker proposes one needed and one duplicate idea, then dipo ideas"
      expect: "after the run ends, one proposed user story with found, Story line, proposal, why and milestone or tech debt, and one rejected idea with its reason"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A worker's proposal, a reviewer's advisory finding, a planning session's aside and a quick idea are each held as an idea with its origin and source story, not as a draft
- [ ] #2 A run's ideas are audited together after that run is merged or parked, and an idea without a run is audited when it arrives
- [ ] #3 Code rejects, with its reason and no model call, an idea equal to one already held or whose title is that of an open or Done story
- [ ] #4 The audit session passes an idea only when no open or Done story covers it, the problem is real in the code with file and line, and it serves a milestone goal or is tech debt, and never rejects for size
- [ ] #5 For a passing idea the audit gives a proposed user story the engine validates: what was found with its evidence and source story, a Story line in the 0012 shape, what is proposed, why, and the milestone it serves or tech debt
- [ ] #6 Every rejected idea is kept with its reason, and dipo ideas lists the held, passing and rejected ideas with their reasons
- [ ] #7 The audit is its own session kind on the planning tool set and the office setting audit.model with default sonnet (a schema default, not written into .dipo/office.yaml); it holds no run slot, does not count as the planning session and ends after its answer
- [ ] #8 A planning session's aside reaches dipo as an aside block with a schema in the contract that the engine validates
- [ ] #9 An idea whose audit fails, is cut off or is refused by schema stays held and is audited again at the next trigger, and is never dropped
- [ ] #10 Until DIPO-454 lands, a worker's proposal is held as an idea and also still written to the desk unchanged
- [ ] #11 Old barrier: what the planning, review and session tool sets allowed before is unchanged, with a test for each
- [ ] #12 Bypass forms are tested: the audit kind spelled in another case or as an alias gets no extra tools, and tool or MCP text inside an idea's text is ignored
- [ ] #13 A fail-closed test against the real adapter shows an audit plan asking for Bash, Edit or Write is refused
- [ ] #14 ADRs 0002, 0007 and 0020 describe ideas and their audit, each with one Replaced line where a decision changed
- [ ] #15 Worker proposals still open on the desk when this lands are held as ideas and audited once
<!-- AC:END -->
