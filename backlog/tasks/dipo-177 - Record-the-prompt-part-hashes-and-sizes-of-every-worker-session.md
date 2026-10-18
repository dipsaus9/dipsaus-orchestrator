---
id: DIPO-177
title: Record the prompt part hashes and sizes of every worker session
status: Done
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-18 07:19'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/run/
  - packages/engine/test/run/
  - packages/engine/src/prompts/parts.ts
  - packages/engine/test/prompts/
priority: medium
type: bug
ordinal: 166000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every worker session dipo starts has its prompt parts measured and stored (sha256, bytes and estimated tokens per part), as 0014 section 2 decided.

Context: finding 21 of the DIPO-115 cutover, found while filing DIPO-137. recordPromptParts (packages/engine/src/prompts/parts.ts) has no production caller. A first session (renderRunPrompts in packages/engine/src/run/prompts.ts, called from packages/engine/src/run/launch.ts; the agents row in packages/engine/src/run/work-run.ts) and a resume or handoff (packages/engine/src/run/resume.ts) store only agents.system_hash and the nudge sources, so the per-part measurement of 0014 section 2 never happens. DIPO-137 stores the prompt text next to the same agents row and does not call recordPromptParts; this story does not depend on it. DIPO-99 left the nudge pseudo rows (task.context:<path>, task.inputs:<path>) in the same table; they stay as they are.

```dipo
branch: "DIPO-177/record-prompt-parts"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a first session, a handoff and a resume each store their prompt parts with the sha256 and bytes of the texts sent"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A first session records the system part, the task part and one task.<section> part per section of its task message through recordPromptParts, keyed by run and agent, when its agents row is written
- [x] #2 A handoff session records its system and task parts, and a resume records the task part of the first message it sends, each under its own agent
- [x] #3 Tests read promptPartsOf after a launch, a handoff and a resume and compare each part with the sha256 and byte count of the text the session got, computed in the test with node:crypto
- [x] #4 The nudge pseudo rows in prompt_parts are written and read as before: the existing nudge tests pass unchanged
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M56XARR1738NKJV46MBH3JE8 (Haiku low, 24 turns, about $0.04, 5 min) reported done, all four criteria, In Review on DIPO-177/record-prompt-parts. Verify outside the sandbox on DIPO-177/record-prompt-parts-finish: 3248 pass, 2 skip, 0 fail.

Maintainer side: review blocked once on criterion 3: the first session's task.<section> parts were not compared with the sent text (the expected names came from the stored parts). Fixed on top: start.test.ts lists the five section names as literals and compares each `<name>` block of the sent stdin text by sha256 (node:crypto) and byte count; a mutation adding a newline to the measured section text in prompts/parts.ts fails the test. reattach.test.ts: preparedSpecs is cleared per test, and the realResumer doc comment is back above its function.

Left as is: a handoff records no task.<section> parts (the criterion asks for system and task only). WorkRun was already over 400 lines on main; this story adds 3.
<!-- SECTION:NOTES:END -->
