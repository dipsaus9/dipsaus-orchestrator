# Migration

| # | Id | Step | Tier | Needs | Mocks it must pass (DIPO-520) |
|---|---|---|---|---|---|
| 0 | 520 | Hold every screen to its mock cell for cell, roles included | M | none | the harness; 02-floor, 05-queue, 07-plan whole |
| 0 | 530 | TUI v2: close the gaps to the mocks | M | 520 | tui-v2 02, 03, 04 whole (05-queue is 532's) |
| 0 | 531 | Retro: build the room to its mock (replaces DRAFT-21) | M | 520 | tui-v2 06-retro |
| 0 | 532 | Queue: now and plan views, office.milestones | M | 520 | 10-queue-now, 11-queue-plan |
| A | 521 | Plan view: no cut answers, one fold line, one line per filed story, reasons | S | 520 | tui-v2 07-plan |
| B1 | 522 | ADR 0024 the office chat (maintainer approval) | S | none | none |
| B2 | 523 | One standing chat per office, in threads | L | 522 | 02-chat-room head lines; 07-states C5 |
| B3 | 524 | Context facts with every message | M | 523 | none (engine) |
| B4 | 525 | Action cards | M | 523 | 05-run-with-dock-wide; 07-states C5 cards |
| B5 | 526 | The chat always in view: panel, strip or line; `\` toggles, `` ` `` focuses | M | 520, 521, 523 | 08-desk-chat-panel, 09-queue-chat-strip, 01-queue-with-dock, 02-chat-room, 05-run-with-dock-wide; 07-states C5, C6 |
| C1 | 527 | The engine's background list | M | none | none (engine) |
| C2 | 528 | BACKGROUND on the Floor, its level, the header chip | M | 520, 527 | 03-floor-background, 04-background-detail; 07-states C6 |
| C3 | 529 | Focus: `!`, `'`, room memory, links | M | 526, 528 | 06-desk-jump-and-line |

Track 0 and track A can start now. B and C run in parallel after their first step.

## The ADR change (522)
0022 keeps the box, the model, the interviewing standard, the decision record and the one-Claude-session rule. It changes: sessions become threads of one standing chat (`/new`, `/end`, a day idle); the kind becomes context (room and focused item, facts by code); the chat may add steer, answer, resume, ready and command cards, which run only as the maintainer's own command on `c` with origin chat, never drop or discard. Rewrite 0022 where it changes and add one Replaced line.

## Contract additions
1. `chat.message { office, thread?, text, context: { room, item? } }`; planning.start, planning.message and planning.end stay one release as aliases (523, 524).
2. Card schemas `steer`, `answer`, `resume`, `ready`, `command`, validated as proposals are (525).
3. `OfficeSnapshot.background` and the `background.changed` event (527): `{ kind, ref, subject, state: failed | needs-you | running | waiting | done, ci?, next?, since, url? }[]`, in engine order.
4. `office.milestones` (532): per milestone id, title, description, counts by status, open stories in chain order and the chain picture.
5. `office.retro` as data per period instead of text lines (531).
6. A reason on a refused command where only a count comes back today (`set Ready DIPO-116: 1 refused`) (521).

## What stays
One Claude session per office answering at a time; the read-only box; `.dipo/planning.md`; the 07-plan.txt layout (DIPO-487); `⏎` send and `shift-⏎`/`⌥⏎` new line; `c` copy; the Composer for every prompt outside the chat.
