# 0015 Build our own, inspired by others, not dependent on them

Status: accepted (maintainer, 2026-10-10). Number 0014 is reserved for spike DIPO-10.

## Context

Before the stack decision the maintainer asked for research on comparable tools: agent-orchestrator (OrchestratorInc, formerly Untrivial-ai), agenttrail (sodiumsun) and hermes3d (iamlukethedev). The findings are in [docs/research/2026-10-comparable-tools.md](../research/2026-10-comparable-tools.md).

agent-orchestrator is the closest. It is large and active and shares much of our architecture (daemon, event stream, worktree per task, Claude adapter, reviewer agent). Its core model is the opposite of ours: an LLM session decides what to spawn, tasks are unprepared prompts or issues, cost is observed but never capped, and it assumes the user is watching.

Options considered:

- **A. Build our own.** Use the tools as design references.
- **B. Build on agent-orchestrator.** Faster start, but gates, budgets and the backlog would be added to a pre-1.0 system that was not designed for them and has no stable API promise.
- **C. Contribute upstream** and drop this project.

## Decision

1. **We build our own (option A).**
2. **Inspiration, not imitation.** We take ideas, patterns and lessons from these tools. We do not copy their code, naming, command syntax or concepts one to one. Every adopted idea is restated in our own terms and must fit our principles (vision, decisions 0001 to 0011).
3. **No runtime dependency** on any of these tools. A later optional integration (for example another tool acting as a client of our event stream) is allowed but never required.
4. **Our differentiator** is what none of them do: prepare first (Ready gate over a Backlog.md backlog), code decides what runs, budgets are enforced and stories park with a reason, unattended by design, roles hired and versioned in the repository.
5. **Adopted ideas are tracked as acceptance criteria** on the spike or milestone that owns them, so they cannot be dropped silently. The research document lists each idea with its owner.
6. **The research is a living reference**, in particular for a future GUI client and for context and token optimizations. New comparable tools are added to `docs/research/` in the same format.

## Consequences

- We keep full control over the model that makes this project different.
- We must build what agent-orchestrator already has (daemon, adapter, worktrees). The research shortens that work by naming the patterns that worked for them and the problems they hit.
- Licences: the three tools are MIT or Apache-2.0. Reading their code for ideas is fine. If code is ever reused, its licence and attribution must be honoured explicitly in that change.
