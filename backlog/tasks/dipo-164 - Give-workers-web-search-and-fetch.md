---
id: DIPO-164
title: Give workers web search and fetch
status: Ready
assignee: []
created_date: '2026-10-17 12:52'
updated_date: '2026-10-19 08:49'
labels:
  - 'tier:M'
  - 'slice:m1a'
milestone: m-1
dependencies:
  - DIPO-115
  - DIPO-139
  - DIPO-210
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

OFFICE_CONFIG_VERSION is 6 (DIPO-188, story.maintainerStepPhrases) and DIPO-210 (storyPr.open) takes 7, so worker.web takes version 8. The worker sandbox has no network, so a worker cannot run claude to capture a live recording: the web recording it commits is derived by tools/recordings/derive.ts from committed live recordings, with every field no live run showed listed in meta.cites, and the maintainer captures the live one with the web scenario this story adds (manual test plan entry).

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
      check: "(unit) office config version 8: a version 7 office.yaml migrates in memory with worker.web true, worker.web false is read, an older file that names worker.web gets the version hint, and the committed office.schema.json equals the generated schema"
    - kind: "automated"
      check: "(unit) with worker.web true only the developer role gains WebSearch and WebFetch: the review kind's plan, or before DIPO-145 lands the role check that adds the web tools, gets neither"
    - kind: "automated"
      check: "(golden) the developer L1 holds the web lines of AC5"
    - kind: "automated"
      check: "(migration) run_outcomes gains web call counts by tool, and a run with two searches and one fetch records 2 and 1"
    - kind: "automated"
      check: "(replay) the derived recording with a search, a fetch and a refused fetch parses, each web call shows in the worker output with its query or URL, and the calls are counted by tool"
    - kind: "manual"
      check: "(live, on the maintainer's machine with network) run bun run recordings:capture for the web scenario: a WebSearch, a WebFetch, and a WebFetch whose URL holds a value from a copied env file"
      expect: "the recording is written with source live, shows the search and the fetch with their query and URL and the third fetch denied by the PreToolUse hook naming the env file and key but not the value, and the web replay test passes on it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Office key worker.web (default true) arrives in office config version 8 (version 7 is DIPO-210's): a version 7 file migrates in memory, KEY_ADDED_IN names worker.web, the regenerated packages/engine/schema/office.schema.json holds it, and worker.web false restores the M0 developer tool list
- [ ] #2 With worker.web true the developer role's --tools gain WebSearch and WebFetch and the run settings allow both, while the Bash sandbox network stays closed and the reviewer gets no web tools
- [ ] #3 The run settings register a PreToolUse hook with matcher WebFetch|WebSearch; dipo hook PreToolUse relays the URL or query and waits within the relay's 2-second limit; the engine denies, naming the env file and key and never the value, a URL or query that holds a value from the copied env files as written or percent-encoded, else allows; with no answer in time the relay prints a deny
- [ ] #4 Every web call shows in the worker output with its query or URL, and run_outcomes gains web call counts by tool through a migration
- [ ] #5 L1 for the developer says the worker may search the web for documentation, that every query and URL is shown to the maintainer, never to send repository content, secrets or file contents in a query or URL, and to ask a question for a decision; L1 stays golden-tested
- [ ] #6 tools/recordings/derive.ts derives a recording with a WebSearch, a WebFetch and a WebFetch the PreToolUse hook refused from committed live recordings into packages/engine/test/recordings/claude-cli/, with the fields no live run showed in meta.cites; tools/recordings/scenarios.ts gains the live web scenario; and a replay test reads the recording and counts the web calls by tool
<!-- AC:END -->
