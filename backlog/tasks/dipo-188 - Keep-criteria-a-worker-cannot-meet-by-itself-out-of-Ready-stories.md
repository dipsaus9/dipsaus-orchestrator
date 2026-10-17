---
id: DIPO-188
title: Keep criteria a worker cannot meet by itself out of Ready stories
status: Refined
assignee: []
created_date: '2026-10-17 20:30'
updated_date: '2026-10-17 20:36'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/gate/rules.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/schema/office.schema.json
  - packages/engine/test/gate/
  - packages/engine/test/config/
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/test/prompts/
  - packages/engine/src/gate/types.ts
  - packages/engine/src/gate/evaluate.ts
priority: medium
type: enhancement
ordinal: 177000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a criterion that asks for a step only the maintainer or the engine can take (writing task notes, running the Backlog CLI, a step by the maintainer) fails the Ready gate with a message that says to move it to a manual test plan entry, and a worker that meets the rest reports done with its record in the report evidence instead of parking.

Context: the fourth M1a run, DIPO-176 (run_01M55PE8B6W4X9TMJEW2SYV7B6). Criterion 4 asked for a sandboxed verify "recorded in the task notes". The worker's own session was that sandboxed run, but a worker cannot write task notes: the run settings deny the backlog CLI (packages/engine/src/workers/claude-cli/plan.ts). It read the criterion as needing a separate recording, parked blocked to ask, and the maintainer finished the story by hand. Manual test plan entries (0012 F14) are already where maintainer steps live, and L1 lists them in the <test_plan> section, but nothing stops a criterion from naming such a step.

DIPO-159 makes a worker question wait for an answer before parking. This story removes the need for the question in this case and does not change the question path, so it does not depend on DIPO-159. DIPO-170 changes how R10 matches phrases in packages/engine/src/gate/rules.ts; whichever lands second rebases on the other. With the R27 option, the rule id list in packages/engine/src/gate/types.ts (it ends at R26) and the rule lists in packages/engine/src/gate/evaluate.ts (R02 to R26) gain R27.

A new Ready gate rule is an 0012 section 3 amendment the maintainer approves; the maintainer writes it, and this story does not edit docs/decisions/.

```dipo
branch: "DIPO-188/flag-maintainer-step-criteria"
unknowns:
  - q: "Is the check a new Ready gate rule R27 with its own office list story.maintainerStepPhrases and the message 'criterion #<n> names a step the worker cannot take (\"<phrase>\"); move it to a manual test plan entry' (an 0012 section 3 amendment you approve), or more phrases in R10's story.bannedPhrases (no ADR change, but the failure then says vague phrase)?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the gate fails DIPO-176 criterion 4 with the criterion number and the phrase, and passes a criterion without a listed phrase"
    - kind: "automated"
      check: "(unit) the office config accepts the phrase list, uses the default when it is missing, and refuses a non-string entry"
    - kind: "automated"
      check: "(golden) the rendered system file holds the evidence-is-the-record rule and the manual-entry rule"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Ready gate fails a criterion that contains a phrase from the chosen list, one failure per criterion and phrase, with a message that names the criterion number and the phrase and says to move the step to a manual test plan entry
- [ ] #2 The phrase list is office configuration validated in packages/engine/src/config/schema.ts, its default holds at least "task notes", "implementation notes", "by the maintainer" and "backlog task edit", and packages/engine/schema/office.schema.json is regenerated
- [ ] #3 A test in packages/engine/test/gate/ runs the gate on the text of DIPO-176 criterion 4 and gets the failure, and on a criterion without a listed phrase gets none
- [ ] #4 L1 (packages/engine/src/prompts/contract/implement.md) says the report evidence is the record dipo keeps, so a criterion that asks for a command and its result to be recorded is met when the evidence holds them, and that manual test plan entries are the maintainer's steps and never a reason to report blocked; the golden file packages/engine/test/prompts/golden/system-implement-developer.md is updated
<!-- AC:END -->
