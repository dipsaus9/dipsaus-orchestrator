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
- **Each project is its own office.** Every project is a development project with its own Backlog.md. Agents, planning, refinement and state belong to one project, and projects do not know about each other.
- **The software sits above the offices.** It knows all the maintainer's projects. The maintainer can open a new repository as a new office, see the status of any office, and switch between offices the way they would navigate to a folder.

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

### 1. Offices per project, one software above them
Each project is initialized as an office with its own backlog, configuration and local state. Offices are isolated: work, agents and planning never cross between projects. The software above them keeps a list of known offices, lets the maintainer open a new one, see each one's status, and switch between them.

### 2. An orchestrator that helps set things up
The orchestrator is the helper the maintainer talks to. It sets up planning, new items, new agents and runs. It combines software and AI: it uses code for everything it can know or do directly, and AI to draft and discuss.

Interaction has two layers. **Commands** are the deterministic core and the only way to act on the engine. A **conversation layer** sits on top: the maintainer says what they want, the orchestrator maps it to commands and asks for confirmation. The conversation can never do something no command can. The CLI, the conversation, the TUI and any future web or desktop UI all trigger the same commands. Commands are built first, and the conversation layer follows.

### 3. Team-lead rituals
Plan, refine, find unknowns, estimate, mark Ready, run, review, retro. Each is a physical command connected to Backlog.md and to interview sessions with the model. The engine refuses to run a story that is not Ready. Work flows continuously with no sprints.

### 4. A roster of agents with roles
The maintainer can "hire" an agent for a specific job and give it specific instructions. A role is a stored, versioned definition inside the office's repository: purpose, instructions, allowed tools, default model and default effort. Hiring adds a role to the office's roster. When work is picked up, code chooses the role for each story (from a story label or type, or the maintainer's choice) without asking a model. A story may add extra instructions on top of its role. Tuning a role once improves every later job, and its history lives in git. Roles can include developer, tester, reviewer, UX designer and visual designer.

Every role works through the same flow: **all work is a story, and all output lives in the repository.** A design story produces files in the project (for example `docs/design/<story-id>/` with flows, specs, and SVG or HTML mockups) on a branch, is reviewed against its own acceptance criteria, and is merged like code. Stories that build on it depend on it and reference those files in their scope, so the engine knows the order without a model. External design tools may later be given to a role as a tool, without changing this flow.

### 5. Effort and model chosen by difficulty
Each job's size and difficulty decide how much may be spent on it and which model does it. Easy jobs get a cheaper model and a small budget. Hard jobs get a stronger model and a larger budget. This also keeps shared subscription limits from being exhausted by one job.

- Difficulty is a **tier set at refine time**, as part of the estimate. The AI proposes a tier with a reason, the maintainer confirms or changes it, and it is stored on the story. At run time code reads the tier, with no model call.
- Three tiers to start, each mapping to a model, a budget and a loop cap. The mapping lives in office configuration and can be tuned per project:

  | Tier | Typical job | Model | Budget | Loops |
  |---|---|---|---|---|
  | S | Small change, clear spec | fast, cheap model | small | 3 |
  | M | Normal feature | standard model | medium | 5 |
  | L | Cross-cutting or risky | strongest model | large | 8 |

- A role can override the tier default, for example a reviewer that always uses a strong model.
- Running out of budget parks the story with `budget-exceeded`. Budgets are never raised silently.
- Whether budgets are expressed in tokens, turns or time depends on what the Claude CLI supports (DIPO-5).

### 6. Unattended execution and parking
The maintainer drives planning. Execution can run unattended, including overnight. When a worker needs a human it parks its story with a structured reason (`ambiguous-spec`, `verify-failing`, `conflict`, `scope-violation`, `review-blocked`, `budget-exceeded`) and the rest continues. The morning view is a triage list.

### 7. Review and testing
A reviewer agent checks every PR against the story goal. The maintainer reviews by **testing behavior**, only for stories they choose to flag, and not by reading code except by exception. The product makes testing cheap by showing what to test and providing a runnable checkout.

How to run a product:

- **Each repository is self-sufficient.** It contains what it needs to install, start and test itself, including environment files. The orchestrator does not manage a project's secrets or setup.
- **The orchestrator learns how to run a product from context.** It scans the repository for install, start and test scripts and stores the result in its local database, not in a configuration file.
- **Standards first, AI for gaps.** A standard set of script names is defined for the maintainer's projects. A repository that follows it is understood by code alone. AI only infers what a non-standard repository does, and the maintainer confirms.
- **Rescan on change.** When scripts change, a rescan command refreshes the stored knowledge.
- **Testing a story is a command.** Code checks out the story branch in its worktree, installs, starts the product, and shows the story's manual test script. The maintainer records pass, or fail with a note. A failure sends the story back, and the note becomes structured input for the next worker.
- Open for DIPO-7: git worktrees contain only tracked files, so gitignored environment files present in the main checkout are absent in a fresh worktree. Port clashes between parallel worktrees also need a rule.

### 8. A manager's overview and feedback loop
The maintainer is a manager who is present along the way, not only at planning time. At any moment the overview answers:

- **Who is working on what:** which agent, in which role, on which story, in which phase (implementing, verifying, in review, parked).
- **How it is going:** progress against acceptance criteria, loop count, verify results, reviewer verdicts, time running, and signs of trouble such as repeated failures or a stalled agent.
- **What needs to be done:** the queue by lifecycle state, what is Ready, what is blocked and why, and what is waiting for the maintainer.
- **Whether it is cost efficient:** usage per story, per role and per tier compared to its budget, and trends over time, so the maintainer can see which kinds of work, roles or preparation are worth it.

The manager helps along the way. While work runs, the maintainer can answer an agent's question, give direction, pause, resume, reassign or stop a story, without waiting for it to park. These are commands like any other, so every client can offer them.

The headless engine runs as a daemon so work survives closing the UI. A TUI is the first client. A local web UI or desktop app can follow. Clients only send commands and read events.

## The maintainer's role

The maintainer visions the whole plan and micromanages it, like a good manager: they plan, and they also help along the way. Micromanaging means full visibility and control over direction, plans, roles, budgets and gates, and the ability to step into running work at any time. Prepared work can also run without the maintainer present, for example overnight. The most important work is preparing jobs well, because fixing afterwards is expensive. Agents do the hard work. The maintainer is the mastermind.

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

1. **Office switching:** how are offices registered (explicit `open`, or discovered on first use), and does one engine process serve all offices or does each office run its own? Part of the daemon spike (DIPO-3).
2. **Role library:** roles are stored per office (decided). Should there also be a personal library of tuned roles to copy into a new office as a starting template?
3. **Script standard:** which script names and behaviors form the standard (for example install, setup, dev, test, verify), and how strict is it?
4. **State scope:** all work state is per office. The software above only needs a small list of known offices. Where that list lives is decided with question 1.
