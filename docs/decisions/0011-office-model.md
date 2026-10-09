# 0011 The office model

Status: accepted as direction, details open (grill session, 2026-10-09). Numbers 0004 to 0010 are reserved for the architecture spikes DIPO-1 to DIPO-7.

## Context

After decisions 0001 to 0003 the maintainer clarified that the product is larger than a story delivery tool. It is an orchestration product in which the maintainer and a model together run **all** of the maintainer's software products, like an office or development team.

## Decisions

1. **Scope is the office.** The product covers planning, refinement, agent hiring, execution, review and product testing for all of the maintainer's products, in one environment.
2. **Code drives, AI fills the gaps.** What code can know (backlog structure, ids, branches, state, dependencies, gates) is never delegated to a model. AI drafts content (stories, milestones, acceptance criteria, test scripts), interviews the maintainer, and does the work of agents. Planning content is written by the maintainer and AI together.
3. **An orchestrator helper** assists with setup: planning new items, creating and hiring agents, and starting runs. It combines software and AI.
4. **A roster of roles.** Agents are created from roles with their own instructions, tools, default model and default effort. Roles can be code and non-code.
5. **Effort follows difficulty.** Model and token budget are chosen per job by its size and difficulty, proposed by the orchestrator, overridable by the maintainer, always capped.
6. **The maintainer visions and micromanages.** Full visibility and control over direction, plans, roles, budgets and gates. Prepared work may execute without the maintainer present.

## Effects on earlier decisions

- **0001, "local database is per project":** under review. Cross-product state suggests a workspace-level store, possibly with per-product detail. Resolved in the state database spike (DIPO-4). Until then, treat the per-project statement as provisional.
- **0001, ritual commands and lifecycle:** still valid. They become the first capabilities of the office, not the whole product.
- **0001, worker adapter:** still valid, and the roster of roles sits on top of it.
- **0002, review and testing:** still valid. The reviewer is one role in the roster.
- **0003, milestones M0 to M3:** the order stands (execution engine first), but the scope of each milestone must be revisited against the open questions in `docs/vision.md`.

## Consequences

- New architecture questions beyond DIPO-1 to DIPO-7: the product and workspace model, the role and roster model, the effort policy, and the orchestrator helper interaction. These become new spikes once the maintainer confirms the open questions.
- The vision is the reference document. Disagreements are resolved by editing `docs/vision.md`, then recording the change here.
