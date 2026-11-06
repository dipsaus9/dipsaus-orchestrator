# 0022 Planning sessions

Status: accepted. First written 2026-11-05 from the maintainer's M3 planning interview.

## Decision in short

The rituals of M3 (0003) are one kind of session, the **planning session**: the maintainer talks with Claude in the TUI, turn by turn, and dipo's code files what the maintainer confirms. Claude asks, explains why and recommends; the maintainer decides every choice; nothing is filed or set Ready without a confirm. A session plans new work, refines existing stories or triages drafts. Every incoming idea is audited first, by code and then by a short Claude session; only an idea that passes reaches the maintainer, as a proposed user story, and only what the maintainer accepts becomes a draft. A retro view shows what the data says about past work, computed by code.

## 1. The session

- **Where it runs.** In a box of its own (0008), set up like the reviewer's: no mounts, no writes, the box firewall and web proxy. Its files are a read-only copy of the base branch's tree, the backlog included. Its tools read files, search the code and use the web (search and fetch); it never writes a file, runs a command or calls dipo. Any further access is its own story with the maintainer's yes.
- **What it knows.** The office's code and backlog, and the dipo facts its kind needs (open drafts, the desk, recent runs, retro numbers), which dipo gives it as text.
- **How it works with the maintainer.** dipo's planning prompt holds the interviewing standard, the same in every office: ask, never assume; each question stands on its own, with its purpose before its options and the recommended option, if any, first; explain further when an option is unclear; back every claim about the code with file and line; write stories that lead with who, what and why (0012); propose nothing outside the maintainer's goals. The office file `.dipo/planning.md`, kept in the repository and edited by the maintainer, adds that project's standing preferences.
- **Questions.** Claude asks in a structured block the engine validates: at most four questions, each with a short header, its purpose, two to four options with a description each, at most one marked recommended, and always room for a free answer. The TUI shows the block as a dialog the maintainer answers with keys.
- **Model.** Opus by default, an office setting like the reviewer's model. The model proxy counts its usage like any session's (0008), with no run cap; spend shows live in the TUI, and the daily and monthly spend alerts still apply.
- **Place.** One planning session per office at a time, beside the runs. It holds no run slot (0002).
- **Begin and end.** The maintainer starts a session with a kind and a goal and ends it explicitly. Closing the TUI does not end it: it waits and is shown again when the TUI opens. A session idle for a day ends by itself. What was confirmed is already filed when a session ends.
- **The decision record.** dipo's code stores every confirmed choice, filed or edited story and open question of a session in the database. When Claude's context nears full, or a session continues after its Claude session ended, dipo starts a fresh Claude session whose first message code builds from the record: the goal, the decisions, the filed stories and the open questions. The TUI says the session continued in a fresh session.

## 2. What a session files

Claude proposes in a structured block the engine validates; the maintainer confirms, edits or declines in the TUI; code files, through the planning lane (0010), on backlog PRs dipo opens itself.

- **A new story** is filed `Refined` to the story standard (0012), with a proposed tier and one line of why.
- **An edit** to an existing story (wording, criteria, references, a split, a resolved unknown) is applied as confirmed.
- **Ready.** At the end the maintainer confirms which stories go `Ready`; dipo checks the gate (0012) and sets them Ready in a second backlog PR, never in the PR that filed them.
- **An aside**, an idea that comes up but is not for now, goes to the audit (section 3). The session sends it as an aside block in its answer, a fenced `dipo-aside` block whose schema is in the contract; the engine validates it, holds a valid one as an idea, and refuses an invalid one with a notice that says why.

## 3. Ideas are audited before they reach the maintainer

An idea is a worker's proposal (0020), a reviewer's advisory finding (0002), the maintainer's quick idea (`dipo idea` or a TUI key) or a session's aside. Until its audit passes, dipo holds it as an idea, neither a draft nor a desk item, and records where it came from.

- **When.** The ideas of a run are audited together when that run ends, merged or parked, so the audit sees the finished change and never competes with the worker. An idea without a run is audited when it arrives.
- **Code first.** Code rejects what it can know, with the reason: an idea equal to one already held, or whose title is that of an open or Done story.
- **Then the audit session.** A short Claude session in a box set up like the planning session's (section 1) judges each remaining idea against the office's code and backlog. An idea passes only when no open or Done story already covers it, the problem it names is real in the code (with file and line as evidence), and it serves a milestone goal or is tech debt. Its size is never a reason to reject it. The model is an office setting, `audit.model`, Sonnet by default and not written into the office file. The audit is a session kind of its own with exactly the planning session's tools: it holds no run slot, is not the office's planning session, quotes each idea's text as data, and ends after its one answer, which the engine validates. An idea whose audit fails, is cut off or is refused by schema stays held and is audited again at the next trigger; it is never dropped. `dipo ideas` lists the held, passed and rejected ideas.
- **A passing idea** reaches the desk as a proposed user story, shown in full: what was found, with its evidence and source story; the Story line; what is proposed; why; and the milestone it serves, or tech debt. When the maintainer accepts it, dipo files a Backlog draft with its origin, with no real id and no branch, so it can never run; a tech-debt draft has no milestone and the label `tech-debt`. Dismissing it closes it.
- **A rejected idea** never reaches the desk. dipo keeps it with the audit's reason; the retro view shows how many were rejected and why, and each stays findable.

A triage session goes through the drafts with the maintainer, who refines each into a story or drops it. A worker's decision note is not an idea and stays on the desk.

## 4. Retro

A retro view in the TUI shows, per tier and type: why stories parked, fix rounds and loops, cost and time from Ready to merged, where stories came from, and the ideas the audit rejected, with their reasons. It also shows the share of rework: a merged story whose changed files were mostly changed by another story merged in the 14 days before it. dipo computes every number by code from its database (0007); a planning session may explain them, never compute them.

## How this ADR relates to the others

This ADR governs the M3 stories that build it. Each of those stories rewrites the ADRs whose code it changes (0002, 0007, 0008, 0010, 0012, 0020) in its own PR, so those keep describing what runs.

## Replaced

- Every incoming idea filed as a draft by itself and triaged by the maintainer (2026-11-05). Replaced by an audit of each idea, by code and a Claude session, and a proposed user story on the desk that the maintainer accepts as a draft (2026-11-06).
