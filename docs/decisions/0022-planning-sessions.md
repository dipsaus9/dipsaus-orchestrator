# 0022 Planning sessions

Status: accepted. First written 2026-11-05 from the maintainer's M3 planning interview.

## Decision in short

The rituals of M3 (0003) are one kind of session, the **planning session**: the maintainer talks with Claude in the TUI, turn by turn, and dipo's code files what the maintainer confirms. Claude asks, explains why and recommends; the maintainer decides every choice; nothing is filed or set Ready without a confirm. A session plans new work, refines existing stories or triages drafts. Every incoming idea becomes a draft, so only what the maintainer promotes gets a real id. A retro view shows what the data says about past work, computed by code.

## 1. The session

- **Where it runs.** In a box of its own (0008), set up like the reviewer's: no mounts, no writes, the box firewall and web proxy. Its files are a read-only copy of the base branch's tree, the backlog included. Its tools read files, search the code and use the web (search and fetch); it never writes a file, runs a command or calls dipo. Any further access is its own story with the maintainer's yes.
- **What it knows.** The office's code and backlog, and the dipo facts its kind needs (open drafts, the desk, recent runs, retro numbers), which dipo gives it as text.
- **Model.** Opus by default, an office setting like the reviewer's model. The model proxy counts its usage like any session's (0008), with no run cap; spend shows live in the TUI, and the daily and monthly spend alerts still apply.
- **Place.** One planning session per office at a time, beside the runs. It holds no run slot (0002).
- **Begin and end.** The maintainer starts a session with a kind and a goal and ends it explicitly. Closing the TUI does not end it: it waits and is shown again when the TUI opens. A session idle for a day ends by itself. What was confirmed is already filed when a session ends.
- **The decision record.** dipo's code stores every confirmed choice, filed or edited story and open question of a session in the database. When Claude's context nears full, or a session continues after its Claude session ended, dipo starts a fresh Claude session whose first message code builds from the record: the goal, the decisions, the filed stories and the open questions. The TUI says the session continued in a fresh session.

## 2. What a session files

Claude proposes in a structured block the engine validates; the maintainer confirms, edits or declines in the TUI; code files, through the planning lane (0010), on backlog PRs dipo opens itself.

- **A new story** is filed `Refined` to the story standard (0012), with a proposed tier and one line of why.
- **An edit** to an existing story (wording, criteria, references, a split, a resolved unknown) is applied as confirmed.
- **Ready.** At the end the maintainer confirms which stories go `Ready`; dipo checks the gate (0012) and sets them Ready in a second backlog PR, never in the PR that filed them.
- **An aside**, an idea that comes up but is not for now, is filed as a draft.

## 3. Drafts are the one inbox

Every incoming idea becomes a Backlog draft, with no real id and no branch, so it can never run: a worker's proposal (0020), a reviewer's advisory finding (0002), the maintainer's quick idea (`dipo idea` or a TUI key), and a session's aside. Each draft records where it came from. A triage session goes through the drafts with the maintainer, who promotes or drops each one. A worker's decision note is not an idea and stays on the desk.

## 4. Retro

A retro view in the TUI shows, per tier and type: why stories parked, fix rounds and loops, cost and time from Ready to merged, and where stories came from. It also shows the share of rework: a merged story whose changed files were mostly changed by another story merged in the 14 days before it. dipo computes every number by code from its database (0007); a planning session may explain them, never compute them.

## How this ADR relates to the others

This ADR governs the M3 stories that build it. Each of those stories rewrites the ADRs whose code it changes (0002, 0008, 0010, 0012, 0020) in its own PR, so those keep describing what runs.
