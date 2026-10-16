---
id: DIPO-99
title: Keep nudge source rows out of prompt size and record them for resumed sessions
status: Done
assignee: []
created_date: '2026-10-15 16:49'
updated_date: '2026-10-16 07:32'
labels:
  - 'tier:S'
milestone: m-0
dependencies:
  - DIPO-60
references:
  - packages/engine/src/hooks/nudges.ts
  - packages/engine/src/prompts/parts.ts
  - packages/engine/src/run/resume.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/db/
  - packages/engine/src/hooks/index.ts
  - packages/engine/src/retention/
  - packages/engine/src/run/launch.ts
  - packages/engine/src/run/prompts.ts
  - packages/engine/test/
priority: medium
type: feature
ordinal: 89000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: prompt size figures count only real prompt parts, and a resumed or handoff session whose context pack changed is nudged against its own pack.

Context: DIPO-60 stores the context pack and input paths as pseudo rows task.context:<path> and task.inputs:<path> in prompt_parts, each measured with the file text (packages/engine/src/hooks/nudges.ts:66-69, 222-237), next to the real prompt parts that recordPromptParts writes (packages/engine/src/prompts/parts.ts:51-62). promptPartsOf returns all rows of an agent (packages/engine/src/prompts/parts.ts:89-101), so any byte or token total over it over-counts. Only the first session writes the rows (packages/engine/src/run/work-run.ts:544-547); the resume path (packages/engine/src/run/resume.ts) gathers a context pack but never records it, and the lookup reads paths over all agents of the run (packages/engine/src/hooks/nudges.ts:267-287).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Nudge source paths live apart from prompt parts (own table, or a kind column excluded from prompt size), and promptPartsOf and any prompt size total return real parts only.
- [x] #2 A resumed or handoff session records its own context pack and input paths, and the context and input nudges check the current session paths.
- [x] #3 A migration moves existing pseudo rows; tests cover the size total and a resumed session with a changed pack.
<!-- AC:END -->
