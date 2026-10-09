# Vision

> Status: draft for the maintainer's review (revised 2026-10-09 after the maintainer clarified the scope). Statements marked **[assumption]** are the author's interpretation and need confirmation. See also [concepts](concepts.md) and [decision 0011](decisions/0011-office-model.md).

## In one sentence

dipsaus-orchestrator is a code-driven orchestration product in which one person and an AI model run that person's software products together, the way a small office or development team would, with AI filling in the work that code cannot do.

## The picture: an office

The product represents the maintainer's office, mirroring how the maintainer actually works:

- The maintainer is the **visionary and manager**. They decide what the products should become, discuss what needs to be done, shape new planning and features, and micromanage the result.
- The maintainer cannot do everything alone, so they work with an **orchestrator** (a helper that sets things up and coordinates) and a **roster of agents** that can be hired for specific jobs.
- Like a real team, the roster can hold different roles: developers, testers, reviewers, UX designers, visual designers, and more. Each role has its own instructions, and each job gets a fitting amount of effort.
- The maintainer can **test the products** from within the same environment.
- The orchestrator is initialized **per project**. Whether one environment should also give an overview across several projects is not decided (open question 1).

The result is a stricter overview of what needs to be done and how, like the board and standup of a real team, but always current and always actionable.

## The problem with the current approach

The existing `dipsaus-ai` skills (`backlog-plan`, `backlog-deliver`, `backlog-run`) express the whole process as prose that a model re-reads and re-executes on every run:

- Mechanical steps such as gate checks, branch and slug derivation, worktree setup, base sync, teardown and batch selection are performed by the LLM, so they cost tokens and vary between runs.
- Each worker reloads hundreds of lines of instructions.
- There is no progress stream, no persistent run state, and no resume after a crash.
- Human in the loop is limited to chat prompts, with no visual overview of the whole operation.
- A skill file cannot carry state, supervise processes, or give a live overview. Orchestration with a human in the loop needs real software.

## Core principle: code drives, AI fills the gaps

This is the central design rule. The orchestrator is a **code-driven project**. AI is used where judgment or content is needed, and never for things code can know.

| Situation | Code knows and does | AI does |
|---|---|---|
| Maintainer plans a new story or milestone | Knows the backlog format and its rules, creates the item through the Backlog CLI, assigns the id, branch name, dependencies and milestone, runs validation and collision checks | Drafts the content: outcome, acceptance criteria, unknowns, test script. Interviews the maintainer. The maintainer and the AI write this together |
| Maintainer tells the orchestrator to pick up work | Selects ready, non-colliding stories, creates branches and worktrees, spawns workers with the right prompt, enforces caps and gates, tracks state | The workers implement, self-review and are reviewed by a separate reviewer |
| A job needs an agent | Chooses the role, model and token budget from the job's size and difficulty, within configured limits | The agent does the work for its role |
| A worker is stuck | Detects it, parks the story with a structured reason, continues other work, reports it in the overview | Explains the blocker and proposes options when asked |
| Status question: "what is going on?" | Answers from state, with no model call | Optionally summarizes |

A useful test: **if the orchestrator already knows the answer from the backlog, git or its own state, it must not ask a model.**

## What the product does

### 1. Initialized per project
The orchestrator is set up per project, with its own backlog, configuration and local state. A cross-project overview of all the maintainer's products is a possible later capability and is not decided.

### 2. An orchestrator that helps set things up
The orchestrator is the helper the maintainer talks to. It sets up planning, new items, new agents and runs. It combines software and AI: it uses code for everything it can know or do directly, and AI to draft and discuss. The exact interaction style (conversation versus commands) is an open question.

### 3. Team-lead rituals
Plan, refine, find unknowns, estimate, mark Ready, run, review, retro. Each is a physical command connected to Backlog.md and to interview sessions with the model. The engine refuses to run a story that is not Ready. Work flows continuously with no sprints.

### 4. A roster of agents with roles
The maintainer can "hire" an agent for a specific job and give it specific instructions. A role defines its purpose, instructions, tools, default model and default effort. Roles can include developer, tester, reviewer, UX designer and visual designer **[assumption: non-code roles produce artifacts that are tracked as stories in the same backlog]**.

### 5. Effort and model chosen by difficulty
Each job's size and difficulty decide how many tokens may be spent on it and which model does it. Easy jobs get a cheaper model and a small budget. Hard jobs get a stronger model and a larger budget. The orchestrator proposes, the maintainer can override, and hard caps always apply. This also keeps shared subscription limits from being exhausted by one job.

### 6. Unattended execution and parking
The maintainer drives planning. Execution can run unattended, including overnight. When a worker needs a human it parks its story with a structured reason (`ambiguous-spec`, `verify-failing`, `conflict`, `scope-violation`, `review-blocked`, `budget-exceeded`) and the rest continues. The morning view is a triage list.

### 7. Review and testing
A reviewer agent checks every PR against the story goal. The maintainer reviews by **testing behavior**, only for stories they choose to flag, and not by reading code except by exception. The product makes testing cheap by showing what to test and providing a runnable checkout.

### 8. A visual overview and feedback loop
The headless engine runs as a daemon so work survives closing the UI. A TUI is the first client. A local web UI or desktop app can follow. Clients only send commands and read events.

## The maintainer's role

The maintainer visions the whole plan and micromanages it **[assumption: micromanaging means full visibility and control over direction, plans, roles, budgets and gates, while execution of prepared work may run without presence]**. The most important work is preparing jobs well, because fixing afterwards is expensive. Agents do the hard work. The maintainer is the mastermind.

## Principles

1. **Code drives, AI fills the gaps.** See above.
2. **Prepare, don't repair.** A story must be Ready, with unknowns resolved, before it runs.
3. **Engine separate from UI.** Commands in, events out.
4. **Park, don't guess.** Stuck unattended work stops and waits for a human.
5. **Effort follows difficulty.** Model and budget are chosen per job and always capped.
6. **Model-agnostic at the edge.** Workers sit behind an adapter. Claude through the CLI on the Max login comes first.
7. **Backlog is the project goal.** Stories live in Backlog.md. Git holds code history. A local database holds orchestration state and machine insights.
8. **Built to last.** A long-lived open source project, not a proof of concept.

## Not goals

- No sprints or timeboxes.
- Not a replacement for Backlog.md. It builds on it.
- Not a hosted service. It runs on the maintainer's machine **[assumption, local-first]**.

## Open questions

These are not decided and should be resolved before or during the architecture spikes.

1. **Cross-project view:** the orchestrator is initialized per project. Should there also be one overview across all projects, and if so, what does it show and where does its state live? Undecided.
2. **Orchestrator interaction:** is the orchestrator a persistent conversational assistant inside the TUI, a set of commands that open AI sessions, or both?
3. **Roles and artifacts:** what do non-code roles (UX, visual design) produce, and where does that output live (in the repo, in Backlog.md, elsewhere)?
4. **Hiring:** is a hired agent a stored role definition reused across jobs, or a one-off configuration? Who may edit its instructions?
5. **Difficulty to effort mapping:** who defines difficulty (estimate at refine, the orchestrator's proposal, or the maintainer), and what are the default tiers?
6. **Testing products:** how does the tool help run and test products with different stacks (launch commands, test scripts per product)?
7. **State scope:** per project is the default. If a cross-project view is added, does it need its own store?
8. **Milestones:** the current M0 to M3 plan was drawn before this scope. Which parts of the office model belong in which milestone?
