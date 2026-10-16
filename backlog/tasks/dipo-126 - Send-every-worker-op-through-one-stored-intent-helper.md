---
id: DIPO-126
title: Send every worker op through one stored-intent helper
status: To Do
assignee: []
created_date: '2026-10-16 13:06'
updated_date: '2026-10-16 13:11'
labels:
  - 'tier:M'
milestone: m-1
dependencies:
  - DIPO-123
references:
  - packages/engine/src/run
  - packages/engine/src/hooks/nudges.ts
  - packages/engine/src/hooks/permissions.ts
  - packages/engine/test/run
  - packages/engine/test/hooks
  - docs/decisions/0008-worker-adapter.md
  - packages/engine/src/db/migrations
  - packages/engine/src/db/schema.ts
priority: medium
type: task
ordinal: 116000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the 0008 rule that every op sent to a running worker is stored as an intent first lives in one helper, and every op either goes through it or is a written exception.

Context: packages/engine/src/run/intents.ts says every op the engine sends to a running worker is stored as pending before it is sent (0008 sections 6 and 7, DIPO-50). That store-then-send-then-mark sequence is hand-coded about six times (run/control.ts, run/outcomes.ts, run/reattach.ts), and the copies have drifted. Three ops are sent with no intent: closeStdin in run/control.ts, nudges in hooks/nudges.ts and hook replies in hooks/permissions.ts. DIPO-123 changes the act() failure path in the same code, so this follows it. Found by the 2026-10-16 milestone review, section 1c CC5.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One function in run/intents.ts (for example sendAsIntent(office, runId, kind, detail, op)) stores the intent, sends, and marks it sent or failed; every site that stores, sends and marks today uses it with unchanged behaviour, and record-only sites (stored and marked in one transaction with no send, as in run/outcomes.ts) stay as they are, listed in the PR
- [ ] #2 closeStdin, nudges and hook replies each either go through it or are listed as exceptions with their reason in the intents.ts header; a new intent kind comes with a migration (run_intents.kind has a CHECK constraint) and an outcomeOfIntent test; if an exception changes what 0008 says, a dated 0008 note is proposed in the PR for the maintainer's approval
- [ ] #3 Tests cover a failed store (no op sent), a failed send (intent marked failed) and each exception
<!-- AC:END -->
