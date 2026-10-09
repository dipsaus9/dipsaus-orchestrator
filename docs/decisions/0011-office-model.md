# 0011 The office model

Status: accepted as direction, details open (grill session, 2026-10-09). Numbers 0004 to 0010 are reserved for the architecture spikes DIPO-1 to DIPO-7.

## Context

After decisions 0001 to 0003 the maintainer clarified that the product is larger than a story delivery tool. It is an orchestration product in which the maintainer and a model together run the maintainer's software products, like an office or development team.

## Decisions

1. **Scope is the office.** The product covers planning, refinement, agent hiring, execution, review and product testing.
2. **One office per project, isolated.** Every project is a development project with Backlog.md. Agents run per project. Planning, refinement and state never cross projects, and projects do not know about each other.
3. **The software sits above the offices.** It knows all offices, lets the maintainer open a new repository as an office, view any office's status, and switch between offices like navigating folders. It holds only the list of offices, not their work state.
4. **Code drives, AI fills the gaps.** What code can know (backlog structure, ids, branches, state, dependencies, gates) is never delegated to a model. AI drafts content (stories, milestones, acceptance criteria, test scripts), interviews the maintainer, and does the work of agents. Planning content is written by the maintainer and AI together.
5. **An orchestrator helper** assists with setup: planning new items, creating and hiring agents, and starting runs. It combines software and AI. Commands are the only way to act on the engine. A conversation layer on top maps the maintainer's words to commands and asks for confirmation, and can never do what no command can. CLI, conversation, TUI and future UIs all trigger the same commands. Commands come first, the conversation layer after.
6. **A roster of roles.** Agents are created from roles with their own instructions, tools, default model and default effort. Roles can be code and non-code. A role is a stored, versioned file in the office's repository, and hiring adds it to that office's roster. Code chooses the role per story without a model call. A story may add instructions on top of its role. A cross-office role library is open. Every role works through the same flow: all work is a story and all output lives in the repository, on a branch, reviewed against the story's own acceptance criteria, and merged. Non-code output (flows, specs, mockups) goes under a project folder such as `docs/design/<story-id>/`.
7. **Effort follows difficulty.** Difficulty is a tier (S, M, L to start) set at refine time: AI proposes with a reason, the maintainer confirms, and it is stored on the story. Office configuration maps each tier to a model, budget and loop cap. Roles may override. Exceeding the budget parks the story with `budget-exceeded`. Budget units (tokens, turns or time) depend on the Claude CLI (DIPO-5).
8. **The maintainer visions and micromanages.** Full visibility and control over direction, plans, roles, budgets and gates. Prepared work may execute without the maintainer present.

## Effects on earlier decisions

- **0001, "local database is per project":** still valid. Each office has its own state. The office list is the only software-level data.
- **0001, "daemon from the start":** still valid, but whether one engine serves all offices or each office runs its own is open (DIPO-3).
- **0001, ritual commands and lifecycle:** still valid. They become the first capabilities of the office, not the whole product.
- **0001, worker adapter:** still valid, and the roster of roles sits on top of it.
- **0002, review and testing:** still valid. The reviewer is one role in the roster.
- **0003, milestones M0 to M3:** the order stands (execution engine first), but the scope of each milestone must be revisited against the open questions in `docs/vision.md`.

## Consequences

- New architecture questions beyond DIPO-1 to DIPO-7: the role and roster model, the effort policy, and the orchestrator helper interaction. These become new spikes once the maintainer confirms the open questions.
- The vision is the reference document. Disagreements are resolved by editing `docs/vision.md`, then recording the change here.
