---
id: DIPO-164
title: Give workers web search and fetch
status: Ready
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-18 14:29'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-115
  - DIPO-139
references:
  - packages/engine/src/workers/
  - packages/engine/src/hooks/
  - packages/daemon/src/
  - packages/engine/test/hooks/
  - packages/engine/src/prompts/
  - packages/engine/src/config/
  - packages/engine/schema/
  - packages/engine/scripts/write-schema.ts
  - packages/engine/src/run/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/test/db/
  - packages/engine/test/run/
  - packages/engine/test/workers/
  - packages/engine/test/prompts/
  - packages/engine/test/config/
  - packages/engine/test/office/
  - packages/engine/test/recordings/claude-cli/
  - tools/recordings/
  - docs/decisions/
priority: high
type: feature
ordinal: 153000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: with worker.web on, the developer role gets WebSearch and WebFetch, every call shows in the worker output and is counted on the run outcome, and a fail-closed PreToolUse hook refuses a URL or query that holds a value from the copied env files, so a worker can look up facts without sending env values off the machine.

Context: implements ADR 0020 section 11b (more input or research: web search and fetch for now; spike answer 4) including the maintainer decision of 2026-10-17 that env values never leave in a web call, and the worker.web config version of section 15 (after DIPO-139). DIPO-169 (Refine worker research access) narrows domains and limits later.

```dipo
branch: "DIPO-164/worker-web-search-and-fetch"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) with worker.web true the plan adds WebSearch and WebFetch and the allow rules, and with false it matches the M0 tool list"
    - kind: "automated"
      check: "(unit) the PreToolUse check denies a URL holding an env value, plain and percent-encoded, names file and key without the value, and allows a clean URL"
    - kind: "automated"
      check: "(unit) the relay prints a deny when the engine does not answer within 2 seconds"
    - kind: "automated"
      check: "(replay) the recording with a search, a fetch and a refused fetch parses and the web calls are counted"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Office key worker.web (default true) arrives in the next office config version after DIPO-139's with its migration and JSON Schema, and worker.web false restores the M0 developer tool list
- [ ] #2 With worker.web true the developer role's --tools gain WebSearch and WebFetch and the run settings allow both, while the Bash sandbox network stays closed and the reviewer gets no web tools
- [ ] #3 The run settings register a PreToolUse hook with matcher WebFetch|WebSearch; dipo hook PreToolUse relays the URL or query and waits within the relay's 2-second limit; the engine denies, naming the env file and key and never the value, a URL or query that holds a value from the copied env files as written or percent-encoded, else allows; with no answer in time the relay prints a deny
- [ ] #4 Every web call shows in the worker output with its query or URL, and run_outcomes gains web call counts by tool through a migration
- [ ] #5 L1 for the developer says the worker may search the web for documentation, that every query and URL is shown to the maintainer, never to send repository content, secrets or file contents in a query or URL, and to ask a question for a decision; L1 stays golden-tested
- [ ] #6 A live recording shows a search, a fetch and a refused fetch, and a replay test reads it
<!-- AC:END -->
