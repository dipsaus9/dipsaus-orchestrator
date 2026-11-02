---
id: DIPO-425
title: Count every model request a box makes against its run's caps
status: Refined
assignee: []
created_date: '2026-11-02 12:10'
updated_date: '2026-11-02 12:12'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/model-proxy.ts
  - packages/engine/src/box/workers.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/records/caps.ts
  - packages/engine/src/box/web-proxy.ts
  - packages/engine/test/box/
  - packages/engine/test/run/
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0021-worker-isolation.md
priority: high
type: bug
ordinal: 403000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: whatever program in a box calls the model (Claude Code, a product's tests using the Anthropic SDK, or `curl`), its tokens count against that run's caps, the tier budget and the spend alerts, so the budgets dipo promises hold.

Found by the M1 close-out review of 2026-11-02 at main 01f38a19. Every developer and reviewer box gets `ANTHROPIC_BASE_URL` (the model proxy) and a placeholder `ANTHROPIC_API_KEY` in its whole environment (`boxModelEnvironment`, packages/engine/src/box/model-proxy.ts about line 287; box/workers.ts about lines 1007 and 1119), and its firewall opens the proxy port. The proxy adds the maintainer's subscription token to every request and keeps no account of usage; caps and spend alerts count only the usage events in Claude Code's own stream (run/control.ts, 0008). So a product's tests that use the Anthropic SDK, in the worker's own test runs or in dipo's verify in the box, or a prompt-injected worker looping `curl`, spend the subscription with no cap seeing it, until the plan limit parks every office.

Design (the maintainer's choice of 2026-11-02: allow, but count it): model access stays open to every program in the box. The proxy knows which box sent a request by its box-network address, as the web proxy admits boxes, and adds the `usage` of each response (also a streamed one) to that box's run, in the same records the stream's usage writes, marked as proxy usage. Requests Claude Code makes are counted once: the stream's own usage and the proxy's count are reconciled so a turn is never counted twice (for example the proxy's count is the total and the stream's usage only labels it). A request from an address no run owns is refused. ADR 0008 (caps) and 0021 (the model proxy) are rewritten to say the proxy's count is what the caps read, with one line each in their Replaced list. 0001, 0007.

```dipo
branch: "DIPO-425/count-proxied-usage"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) the model proxy adds the usage of every response it passes to the run of the box that sent it, so the caps and spend alerts count model use outside Claude Code's stream"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A model request sent through the proxy by a program other than Claude Code (a test with a fake upstream) adds its response's input and output tokens to the sending box's run, and the run's token cap and the day's spend total include them, shown by a test against the real proxy with a fake upstream
- [ ] #2 A streamed response's usage is counted from its final usage event, shown by a test
- [ ] #3 A Claude Code turn is counted once, not once from the stream and once from the proxy, shown by a test that feeds both
- [ ] #4 A request from a box address that no running run owns is refused and never forwarded, shown by a test
- [ ] #5 ADR 0008 and 0021 say the caps read the proxy's count, each with one Replaced line
- [ ] #6 What the proxy's old barrier caught still fails, each with a test: a path other than POST /v1/messages and /v1/messages/count_tokens (404, not forwarded), another method (405), a credential the box sends (dropped, the proxy's own token set), and a 3xx answer (passed back without the token)
- [ ] #7 The bypass forms are tested against the real proxy: a request from one box's address claiming another run (by header or body), a request sent through the web proxy to the model host, a request with its own Authorization or x-api-key, and a streamed request cut off before its usage event (counted from what arrived, never zero by default)
- [ ] #8 Fail closed against the real path: when the proxy cannot tell which run owns the sending address, or cannot record the usage, it refuses the request and forwards nothing, shown by a test with the run lookup and the usage write made to fail
<!-- AC:END -->
