---
id: DIPO-137
title: Store the prompts dipo sends to workers
status: Ready
assignee: []
created_date: '2026-10-16 19:43'
updated_date: '2026-10-18 10:03'
labels:
  - 'tier:M'
  - 'slice:m1b'
milestone: m-1
dependencies:
  - DIPO-135
references:
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/engine/test/db/
  - packages/engine/src/retention/
  - packages/engine/test/retention/
  - packages/engine/src/prompts/
  - packages/engine/test/prompts/
  - packages/engine/src/run/
  - packages/engine/test/run/
  - packages/engine/src/config/
  - packages/engine/test/config/
  - packages/engine/src/views/
  - packages/engine/test/views/
  - packages/contract/src/
  - packages/contract/schema/
  - packages/tui/src/
priority: medium
type: feature
ordinal: 125500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the maintainer reads the prompt each worker session started with (the system file and the first message dipo sent) from the TUI detail, without setting anything, because privacy.storePrompts is on by default and stores that text for tier R; `privacy.storePrompts: false` in .dipo/office.local.yaml stores none.

Context: 0007 section 8 lists privacy.storePrompts (assembled prompts, tier R) as an opt-in, and its retention table (section 7) deletes "opt-in prompt bodies" in tier R. The key exists in the office config schema (packages/engine/src/config/schema.ts), but nothing reads it: packages/engine/src/prompts/parts.ts measures sha256, bytes and estimated tokens per part and stores no text, and its recordPromptParts has no caller outside the prompts module today. The maintainer decided (2026-10-16) that prompts are stored by default from this story on; DIPO-135 turned storeCommandBodies on and left storePrompts false until this story. keepRawEvents stays off.

Where the prompts are made: a first session renders the system file and the task message in packages/engine/src/run/prompts.ts (renderRunPrompts, called from packages/engine/src/run/launch.ts), and packages/engine/src/run/work-run.ts inserts the `agents` row and writes the session's nudge sources. A resume or handoff goes through packages/engine/src/run/resume.ts: a handoff starts a new session with a new system file and a task message that holds the handoff block; a resume continues the session with --resume and sends a short delta first message (prompts/feedback/resume.md) or the message the caller gave. Its recordAgent writes the `agents` row and nudge sources. The prompt rows are written next to the `agents` row of each session, from the configuration in force when the session starts (launch and resume both hold it). Without a configuration nothing is stored, the same safe fallback as DEFAULT_OUTPUT_PRIVACY for commands.

What is stored per session: the system file text and the first message text, keyed by run and agent. A resume stores only its first message, because the session keeps the system file it started with. Nudge texts sent through hooks stay measured in prompt_parts only and are not part of this story. Stored prompts get no redaction; they hold story text, context pack excerpts and handoff text from the repository, and tier R retention (retention.shortDays) is their only limit.

Storage: a new office-scoped table (for example `prompt_texts`: office, run, agent, part `system` or `message`, text, recorded time) in a migration appended to packages/engine/src/db/schema.ts after the newest step when this story starts, with a line in TABLE_RETENTION (packages/engine/src/retention/policy.ts) at tier R; the schema test fails for an office-scoped table without one. The retention pass in packages/engine/src/retention/run.ts deletes rows recorded more than shortDays ago.

Read and TUI: a new contract read (for example `work.prompt { run, agent }`) in packages/contract/src/office.ts, handled in packages/engine/src/views/feature.ts next to work.outputRange, returns the stored texts or says none is stored; packages/contract/schema/ is regenerated and packages/contract/src/version.ts notes the minor addition. The live agent detail (0009 section 4) gets the key i, a third output pane next to [w]orker and [v]erify, that shows the stored prompt of the selected agent's session; p stays pause. DIPO-136, which follows this story, lists storePrompts with the new default in its settings view.

Slice: M1b. The M1a review-and-park loop needs no stored prompt text, and the TUI part sits with the M1b TUI desk next to DIPO-136. If the M1a reviewer session exists when this story starts, its prompts are stored the same way.

```dipo
branch: "DIPO-137/store-worker-prompts"
unknowns:
  - q: "Which key opens the stored prompt in the live agent detail, given the keys 0009 section 6 and the detail already use?"
    status: "resolved"
    answer: "i (maintainer, 2026-10-18), shown as a third output pane next to [w]orker and [v]erify; p stays pause (0009 section 5). Esc goes back, as everywhere."
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) with storePrompts on, a first session stores its system file and task message, a handoff stores its system file and handoff message, and a resume stores its first message, each under its own agent; with storePrompts off or no configuration in force nothing is stored"
    - kind: "automated"
      check: "(engine) the migration is registered in db/schema.ts, a fresh database and a migrated one match, and the new table has a TABLE_RETENTION line at tier R"
    - kind: "automated"
      check: "(engine) a retention pass deletes prompt rows recorded more than shortDays ago and keeps newer ones"
    - kind: "automated"
      check: "(unit) the new read returns the stored texts of a run's agent and says none is stored for an agent without rows; the TUI detail shows the text and the none-stored message"
    - kind: "automated"
      check: "(unit) an office with no privacy keys resolves storePrompts to true, and office.local.yaml with storePrompts: false turns it off"
    - kind: "manual"
      check: "(live) on the scratch repo with no .dipo/office.local.yaml, run a story, open its detail and read the system file and task message the worker started with; set storePrompts: false in office.local.yaml, run another story and see that none is stored"
      expect: "the first story's detail shows the system file and task message on the key i; the second story's detail says no prompt is stored"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With privacy.storePrompts on, every worker session stores the prompt text dipo sent, keyed by run and agent: a first session and a handoff store the system file and the first message, a resume stores its first message; with it off, or with no configuration in force, no prompt text is stored
- [ ] #2 The prompt text sits in a new office-scoped table whose migration is registered in packages/engine/src/db/schema.ts and tested in packages/engine/test/db/, with a TABLE_RETENTION line at tier R in packages/engine/src/retention/policy.ts
- [ ] #3 The retention pass deletes prompt rows recorded more than retention.shortDays ago
- [ ] #4 A contract read returns the stored prompt texts of a run and agent, or says none is stored; packages/contract/schema/ is regenerated
- [ ] #5 The TUI live agent detail shows the stored prompt of the selected agent session on the key i, as an output pane next to [w]orker and [v]erify, says when none is stored, and p still sends work.pause
- [ ] #6 privacy.storePrompts defaults to true in OFFICE_DEFAULTS.privacy, `privacy.storePrompts: false` in .dipo/office.local.yaml turns it off, and the config tests assert the new default
<!-- AC:END -->
