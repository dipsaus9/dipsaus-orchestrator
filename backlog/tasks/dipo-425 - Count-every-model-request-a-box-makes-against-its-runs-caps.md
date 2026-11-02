---
id: DIPO-425
title: Count every model request a box makes against its run's caps
status: Ready
assignee: []
created_date: '2026-11-02 12:10'
updated_date: '2026-11-02 12:25'
labels:
  - 'tier:L'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/model-proxy.ts
  - packages/engine/src/platform/box-host.ts
  - packages/engine/src/box/workers.ts
  - packages/engine/src/workers/claude-cli/interpret.ts
  - packages/engine/src/run/control.ts
  - packages/engine/src/records/caps.ts
  - packages/engine/test/box/
  - packages/engine/test/workers/
  - packages/engine/test/run/
  - docs/decisions/0008-worker-adapter.md
priority: high
type: bug
ordinal: 403000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: whatever program in a box calls the model (Claude Code, a product's tests using the Anthropic SDK, or `curl`), its tokens count against that run's caps, the tier budget and the spend alerts, so the budgets dipo promises hold.

Found by the M1 close-out review of 2026-11-02 at main 01f38a19. Every developer and reviewer box gets `ANTHROPIC_BASE_URL` (the model proxy) and a placeholder `ANTHROPIC_API_KEY` in its whole environment (`boxModelEnvironment`, packages/engine/src/box/model-proxy.ts about line 287; box/workers.ts about lines 1007 and 1119), and its firewall opens the proxy port. The proxy adds the maintainer's subscription token to every request and keeps no account of usage; caps and spend alerts count only the usage events of Claude Code's own stream (packages/engine/src/workers/claude-cli/interpret.ts, run/control.ts, 0008). So a product's tests that use the Anthropic SDK, in the worker's own test runs or in dipo's verify in the box, or a prompt-injected worker looping `curl`, spend the subscription with no cap seeing it, until the plan limit parks every office.

Design (the maintainer's choice of 2026-11-02: allow, but count it):
- Who sent it: today the proxy's handler gets only the `Request` (`ListenHttp` in model-proxy.ts, `systemListenHttp` in packages/engine/src/platform/box-host.ts) and does not know the sender. `systemListenHttp` passes the peer address (Bun's `server.requestIP`) to the handler. `BoxWorkers` (box/workers.ts), which knows each box's network address when it starts the box, keeps one registry from box address to run id and removes the entry when the box stops; the proxy reads that registry. A header or body that names a run is ignored: only the address counts.
- What counts: the proxy reads the `usage` of each response it passes (the JSON body, or the final `message_delta` usage of a stream) and adds input, output, cache-creation and cache-read tokens to the run, in the records the caps and spend alerts read. The proxy's count is the token total for every model request a box makes. The stream's usage event of a Claude Code turn no longer adds tokens; it keeps the cost the CLI reports (0008: cost is the cost the CLI reports, no price catalog) and labels the turn. So a Claude Code turn is counted once.
- A request from an address no running run owns is refused and never forwarded.
- ADR 0008 (the model proxy and section 7, the caps) is rewritten to say the caps read the proxy's count, with one line in its Replaced list. 0001, 0007.

```dipo
branch: "DIPO-425/count-proxied-usage"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) the model proxy adds the tokens of every response it passes to the run of the box that sent it, so the caps and spend alerts count model use outside Claude Code's stream, and a Claude Code turn is counted once"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A model request sent through the proxy by a program other than Claude Code (a test with a fake upstream) adds its response's input, output, cache-creation and cache-read tokens to the sending box's run, and the run's token cap and the day's spend total include them, shown by a test against the real proxy with a fake upstream
- [ ] #2 A streamed response's tokens are counted from its final usage event, and a stream cut off before it is counted from what arrived, never as zero by default, shown by a test
- [ ] #3 A Claude Code turn is counted once: its stream usage event adds no tokens and keeps the CLI's cost, shown by a test that feeds both the proxy's count and the stream event of one turn
- [ ] #4 The proxy knows the sender only by its peer address through the box-address registry that BoxWorkers keeps, and a run named in a header or body is ignored, shown by a test
- [ ] #5 What the proxy's old barrier caught still fails, each with a test: a path other than POST /v1/messages and /v1/messages/count_tokens (404, not forwarded), another method (405), a body over the size limit (413), a credential the box sends (dropped, the proxy's own token set), and a 3xx answer (passed back without the token); count_tokens requests are forwarded and add no tokens
- [ ] #6 The bypass forms are tested against the real proxy: a request from one box's address claiming another run by header or body, a request sent through the web proxy to the model host, and a request with its own Authorization or x-api-key
- [ ] #7 Fail closed against the real path: when the proxy cannot tell which run owns the sending address, or cannot record the usage, it refuses the request and forwards nothing, shown by a test with the registry lookup and the usage write made to fail
- [ ] #8 ADR 0008 says the caps read the proxy's count, with one Replaced line
<!-- AC:END -->
