---
id: DIPO-470
title: Idea audits are not refused by dipo's own token cap
status: In Progress
assignee: []
created_date: '2026-11-10 10:16'
updated_date: '2026-11-10 10:54'
labels:
  - 'tier:S'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/records/proxied-usage.ts
  - packages/engine/src/records/caps.ts
  - packages/engine/src/box/model-proxy.ts
  - packages/engine/src/run/audit-session.ts
  - packages/engine/src/run/session-run.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/run/outcome-exits.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/test/box/model-proxy-count.test.ts
  - packages/engine/test/records/caps.test.ts
  - packages/engine/test/run/audit-session.test.ts
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0022-planning-sessions.md
  - docs/decisions/0020-park-and-resume.md
priority: high
type: bug
ordinal: 443000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want each idea's audit session to get its model answers through dipo's own model proxy, so that the ideas dipo holds are audited and reach my desk as proposed user stories at last.

M3 (maintainer's choice, 2026-11-10). The trigger: with DIPO-469 pinned (binary at e3763d12), every idea audit gets past its start check, but ends after about 3 minutes with `WARN an audit left ideas held ideas=20 reason="the audit session failed: the session ended plan-limit"`. The maintainer's Claude plan is not at its limit. 20 ideas still never reach the desk (0022).

The cause: the audit records its run (packages/engine/src/run/audit-session.ts ~:203-232) as kind `session`, role `auditor`, `budgetLimit: 0`, and its spec has `caps.budgetTokens: 0` (~:245): no token cap, as 0022 and 0008 mean for a session. The model proxy's ledger (packages/engine/src/records/proxied-usage.ts) exempts only `PLANNER_ROLE` from the cap, in two places: `scopeOf` (~:66-71) and `capReached` (~:80). The auditor role (DIPO-452) was never added, so for an audit `capReached` is `0 >= 0`, true before its first token; `open` throws `ModelUseCapped` (~:97-98) and packages/engine/src/box/model-proxy.ts (~:464-465) answers 429 "the run's token budget is used up". Claude Code retries the 429, then reports a rate limit, and packages/engine/src/workers/claude-cli/interpret.ts (~:1056, ~:1224) reads every 429 as the plan's limit. No test sends an audit session's model request through the real `proxiedUsageLedger` and `startModelProxy`: packages/engine/test/box/model-proxy-count.test.ts covers story runs only.

The fix, one mechanism (0001): one rule decides "this run has no token cap", keyed on the run's own record, not on an agent's role: a run of kind `session` whose recorded budget limit (`run.budgetLimit`, never the caps with grants added) is 0 is uncapped. One function next to the caps (packages/engine/src/records/caps.ts) answers it, and both `scopeOf` and `capReached` ask it. It replaces the planner-only role check (`role === PLANNER_ROLE` in both places), which goes. Every other run keeps its cap as today: a story run's developer, a reviewer's own cap (0002), and the scan session, a session run with a real budget (packages/engine/src/run/session-run.ts ~:223).

Not in scope: a later 429 the proxy sends for a real cap is still read as the plan's limit by the interpreter. After this fix no session without a budget is refused, and a story run at its cap is parked budget-exceeded by the engine's own cap watch while Claude Code still retries; the ledger keeps no record of a refusal, so telling the two apart would need new state. It stays on the watch list and becomes a story only if it recurs.

ADR: 0008 says only the planning session's box is never refused for a cap. Its line on the proxy's cap changes to name the rule: a session run with no budget, which today is the planning session and the idea audit, is never refused for a cap. The maintainer approves that wording in this story's PR. This lines 0008 up with 0022, which sets up the audit box like the planning session's.

This touches a guard, the proxy's token cap (R30): the criteria list what the old barrier caught, the bypass forms and a fail-closed test on the real path.

Built by dipo where it can (tier S). A failed audit leaves its ideas held and never drops one (0022), so the held ideas are audited at the next trigger once the fix is pinned.

```dipo
branch: "DIPO-470/audit-proxy-cap"
unknowns:
  - q: "The fix is in and verified: idea audits and planning sessions are uncapped by one rule on the run's record. isUncapped(run) in caps.ts (kind session and budgetLimit 0) replaces the planner-only role check in both scopeOf and capReached in proxied-usage.ts. The proxy header comment in model-proxy.ts now states the rule. Tests added in caps.test.ts and model-proxy-count.test.ts cover criteria 1 to 5. bun run verify passes (format, lint, typecheck, all 7 test shards). Criterion 6 is blocked on your approval of the 0008 wording; I did not edit the ADR. The part was taken by dipo-part. The change is uncommitted in the working tree.</summary>\n<parameter name=\"question\">Do you approve this wording for 0008 line 63? It replaces 'A planning session's box is counted the same way, against its planning run, which has no cap: its requests count in the office's usage and spend and are never refused for one.' Proposed: 'A session run with no token budget (a planning session's or an idea audit's, recorded with budget limit 0) is counted the same way, against that run: its requests count in the office's usage and spend and are never refused for a cap.' If yes, I will write it, or you can apply it yourself."
    status: "resolved"
    answer: "Approved: write the proposed 0008 line 63 wording, then finish the story"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) packages/engine/test/records/caps.test.ts: the one function says uncapped for a session run with budget limit 0 (a planning run and an audit run, each built in a fixture database) and capped for a session run with a real budget (the scan session), a story run with a real budget and a story run with budget 0; proxied-usage.ts has no role check for the planner or the auditor left"
    - kind: "automated"
      check: "(unit) packages/engine/test/box/model-proxy-count.test.ts, the old barrier, one case each: a story run's developer over its budget gets 429 with nothing forwarded; a reviewer over its own cap gets 429; a scan session run over its real budget gets 429; an address with no run row is refused 403 as today"
    - kind: "automated"
      check: "(unit) packages/engine/test/box/model-proxy-count.test.ts, bypass forms, each refused with 429 once the run's tokens reach its budget: a story run recorded with budget limit 0 (refused before its first token, as today); an agent whose role is the string planner or auditor on a story run with a real budget; an agent with an unknown role on a story run"
    - kind: "automated"
      check: "(unit) fail closed on the real path: the real startModelProxy with a fake upstream, a fixture-built office database and the real proxiedUsageLedger, as model-proxy-count.test.ts does: an audit session's request (run kind session, role auditor, budget limit 0) is forwarded and answered 200 with its tokens counted in the office's usage, and in the same test a developer at its cap is refused 429 with nothing forwarded"
    - kind: "manual"
      check: "After the story merges and dipo is re-pinned, wait for the next audit trigger (or add one idea with dipo idea), then read the daemon log and dipo ideas, and open dipo desk"
      expect: "the log shows no 'the session ended plan-limit' warning for an audit, the held ideas are passed or rejected with a reason in dipo ideas, and each passed idea is on the desk as a proposed user story"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An idea audit session's model requests go through the model proxy (200) and count in the office's usage and spend, with no token cap, as a planning session's do
- [ ] #2 One function next to the caps decides that a run has no token cap, keyed on the run's record (kind session and budget limit 0); scopeOf and capReached in proxied-usage.ts both ask it, and the planner-only role check it replaces is gone
- [ ] #3 The old barrier still holds, with a test for each: a story run's developer over its budget gets 429, a reviewer over its own cap gets 429, a scan session over its real budget gets 429, and an address with no run row is refused as today
- [ ] #4 Tests cover the bypass forms, each refused with 429 at its budget: a story run recorded with budget limit 0, an agent whose role is planner or auditor on a story run, and an agent with an unknown role
- [ ] #5 A fail-closed test on the real path: the real startModelProxy, a fake upstream, a fixture-built office database and the real ledger forward an audit session's request (200) and refuse a developer at its cap (429, nothing forwarded)
- [ ] #6 The 0008 line on the proxy's cap names the rule (a session run with no budget is never refused for a cap); the maintainer approves the wording in this story's PR
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-10 10:47 UTC: ambiguous-spec
- Detail: The fix is in and verified: idea audits and planning sessions are uncapped by one rule on the run's record. isUncapped(run) in caps.ts (kind session and budgetLimit 0) replaces the planner-only role…
- Run: run_01M72GXWVBZAJ6346ZFSMFXX2S
- Criteria met: 5 of 6 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 99,082 of 300,000 tokens; 40 of 90 turns; 2 of 45 minutes
- Last good commit: 1f2ae2f7265f6f31d809a653edb0377abdef1e47

Resumed 2026-11-10 10:54 UTC; grants: none; note: Approved: write the proposed 0008 line 63 wording, then finish the story
<!-- SECTION:NOTES:END -->
