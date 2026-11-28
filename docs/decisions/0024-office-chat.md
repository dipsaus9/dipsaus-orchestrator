# 0024 Office chat

Status: accepted. First written 2026-11-28 from the maintainer's answers to the chat and activity proposals (`docs/design/chat-and-activity/spec.md`, P1 to P4). It changes the planning session of 0022 and is the conversation layer of M5 (0003).

## Decision in short

The chat is dipo's voice in the office: the one place the maintainer talks to dipo about whatever is in front of them. Each office has one standing chat, held in threads. Every message carries the place it is written from, a room and a focused item, and code builds the facts for that place; no kind is chosen. The chat explains and helps the maintainer decide, fix, plan and improve the process. It never acts. It may offer action cards, and the maintainer's `c` sends one of them as the maintainer's own command.

## 1. Purpose

The chat is for:

- **Explaining.** Why a story waits, why a run loops, why CI is red, what a change does, what something cost. It reads the facts the rooms show and answers with file and line.
- **Helping to decide.** On a merge, a question, a park or a proposal it says what the choice means and what it unblocks, and can draft the answer, the note or the top-up.
- **Helping to fix.** On a failing run or check it reads the stream, verify and CI output and proposes a steer, a resume with a note, or a fix story.
- **Planning.** It files, splits, refines and edits stories and takes them through the Ready step (0022).
- **Improving the process.** In Retro and Roles it reads the numbers and the role files and proposes changes to stories, roles and preferences.

What it is not:

- **Not an actor.** It sends no command by itself. Every action is a card the maintainer confirms with `c`, or a proposal confirmed as 0022 says.
- **Not a second dashboard.** State lives in the rooms. The chat explains it and never repeats it as a feed.
- **Not a replacement for keys.** Every verb keeps its key in its room. The chat adds a way to understand, not a second way to act.
- **Not a guesser.** It answers from facts code built and from the repository. It says when it does not know, and it gives no estimated times.

## 2. One standing chat, in threads

- **One chat per office.** Its conversation is a list of threads. A thread is what a planning session was: a title, its decisions, the stories it filed, and its record (0022). `/new` starts a thread. Nothing refuses a new one while another is open.
- **Closing.** `/end` closes a thread with the Ready step of 0022: it lists each story the thread filed that stayed Refined, with the gate's first message. A thread idle for `planning.idleHours` (a day) closes by itself. Closing the TUI closes nothing: the thread waits and is shown again when the TUI opens. What was confirmed is already filed when a thread closes.
- **One answer at a time.** One Claude session answers per office at a time. A message sent while it answers waits in the chat as `queued · sends when the answer ends`. The chat holds no run slot (0002).
- **Commands in the chat.** `/new`, `/end`, `/threads` (the threads, each with its filed stories), `/general` (asks without the place) and `/here` (adds the focused item to the place).

The box, the model, the interviewing standard, the decision record and the one-Claude-session rule are 0022's and hold unchanged.

## 3. Context, not kind

- **Each message carries its place**: the room the maintainer is in and the focused item, if any (`chat.message` with `context: { room, item? }`). Nothing else chooses what the chat reads.
- **Code builds the facts for that place** and gives them to Claude as text, from the same engine views the room shows:

  | Place | Facts code builds |
  |---|---|
  | Desk | the focused item, its reason, what it blocks, the actions it offers |
  | Floor and Run | the story's phase, health, criteria, stream tail, verify and CI output, findings, budget |
  | Queue | the Ready gate's messages, the chain, the lists of `now` or `plan`, the focused milestone's counts |
  | Story reader | the story, its review rounds and findings |
  | Retro | the numbers of the period on screen (0022) |
  | Roles | the roster, the role files that fail to load, recent runs per role (0022) |
  | Background | the item and its log tail |

- **The record keeps the kind** of each thread as a value, as it did before, so old threads read the same. A new message has no kind; its context is its place.
- **Every proposal kind is allowed in any place.** The place sets the facts, not which proposals may be made. A story proposal from the Roles room and a role proposal from the Retro room are valid if their schema is.
- **Preferences are not written by the chat.** A preference it suggests is text in its answer; the maintainer edits `.dipo/planning.md` by hand (0022).

## 4. Action cards

An answer may carry five kinds of action card besides the story and role proposals of 0022:

- `steer`: a text for a running worker, sent as the steer command of its run.
- `answer`: the text answering a question that parks a run.
- `resume`: a parked story, resumed with a note.
- `ready`: a Refined story set Ready; the Ready gate decides it as on any Ready step.
- `command`: one other command of the command set, named by the line it would send.

The rules:

- **Validated.** The engine validates each card against the command's schema and the current state, when the answer is read and again when `c` is pressed, as proposals are. An invalid card is refused with the reason in place of the card.
- **Sent by the maintainer.** `c` on a card sends the command as the maintainer's own command with origin `chat`, which the events and the run record. The card shows `◌ …ing…`, then `✓` or the refusal with its reason. The chat never sends one on its own.
- **Drop and discard never run from a card.** A `command` card that names drop or discard does not run: `c` copies its command line to the input, and the maintainer sends it there, or uses `X` or `D` to open the existing prompt, which asks again.
- **Nothing else acts.** No tool in the chat's box calls dipo (0022), so a card is the only way an answer reaches the engine.

## Replaced

The planning sessions and their rules that this ADR changes are in 0022's Replaced list.
