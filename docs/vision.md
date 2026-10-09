# Vision

dipsaus-orchestrator is software that orchestrates AI coding agents the way a team lead runs a development team. It is a program, not a skill file.

## Why software and not a skill

The `dipsaus-ai` backlog skills (`backlog-plan`, `backlog-deliver`, `backlog-run`) put mechanical work in prose that an LLM re-reads and re-executes every run:

- Gate checks, lane detection, branch and slug derivation, worktree setup, base sync, teardown and batch selection are all LLM-executed.
- Every worker reloads hundreds of lines of instructions, which costs tokens and varies run to run.
- There is no progress stream, no persistent run state, and no resume after a crash.
- Human-in-the-loop is limited to chat prompts. There is no overview of what is happening.

LLM output is non-deterministic. Anything that can be code must be code. The model should only be asked for judgment: interviewing, decomposing, implementing, reviewing.

## Goals

1. **Deterministic mechanics in code.** Git, worktrees, branch naming, gates, collision checks, batch selection and teardown are never delegated to a model.
2. **Fewer tokens.** The engine builds each worker's prompt from templates plus structured story data. Workers never read a process manual.
3. **Human in the driver's seat.** An experienced developer guides agents and their output. The most important work is preparing jobs, not fixing results afterwards.
4. **Visual overview and feedback loop.** One clear view of the whole orchestration: what is queued, running, parked, in review.
5. **Unattended execution.** Planning is interactive. Coding and review run unattended, including overnight.

## Principles

- **Prepare, don't repair.** A story must be Ready before it can run. Ready means the unknowns are resolved.
- **Engine is separate from UI.** The engine is headless. A TUI is the first client, a local web UI or desktop app can follow. Clients only send commands and read events.
- **Park, don't guess.** When an unattended worker needs a human, it parks the story with a structured reason and the rest of the run continues.
- **Flexible composition.** Phases (implement, verify, review) are composable rather than hard-wired.
- **Model-agnostic at the edge.** Workers sit behind an adapter interface. Claude is the first adapter.

## Not goals

- No sprints or timeboxes. Work flows continuously from a Ready queue.
- Not a replacement for Backlog.md. It builds on it.
