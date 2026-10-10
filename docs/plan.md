# Plan

How the vision in [vision.md](vision.md) becomes software. Milestones are defined in [decision 0003](decisions/0003-milestones-and-quality-bar.md), the scope in [decision 0011](decisions/0011-office-model.md).

## Steps

1. **Architecture spikes for M0** (DIPO-1 to DIPO-10). DIPO-10 (prompt assembly) follows DIPO-8. DIPO-1 (language, runtime, structure), DIPO-8 (story standard) and DIPO-9 (repo scanning) can start right away. The other spikes depend on DIPO-1 and then run in parallel, with research done by agents. Each spike ends in an ADR in `docs/decisions/` that the maintainer approves.
2. **M0 implementation stories.** Written from the approved ADRs, with real acceptance criteria and declared scopes, following the story standard (DIPO-8).
3. **Build M0** on `<ID>/<slug>` branches. One agent implements, a separate agent reviews against the story goal, feedback is fixed, then the PR is merged.
4. **Cutover.** Once the orchestrator can deliver one story end to end, it delivers its own next stories. From then on the project is built with itself.
5. **Later milestones just in time.** Spikes and stories for M1 to M5 are written when each milestone starts, so they build on what earlier milestones taught us rather than on guesses.

## How the vision maps to the work

| Vision | Where |
|---|---|
| Engine boundary: commands in, events out, every client uses the same commands | DIPO-2 |
| Daemon, overnight runs, office list and switching | DIPO-3 |
| Local state: runs, usage and cost per story, role and tier, run knowledge | DIPO-4 |
| Claude CLI worker, caps, tiers mapped to model and budget | DIPO-5 |
| Manager overview: who works on what, health, queue, cost; stepping into running work | DIPO-6 |
| Backlog.md and git contract, worktrees, environment files, ports | DIPO-7 |
| Story standard and deterministic Ready gate | DIPO-8 |
| Repository scanning, script standard, rescan | DIPO-9 |
| Worker prompts from templates plus story data, measured token savings, context provider (default plus optional codegraph backend) | DIPO-10 (design), M0 (interface and default), M1 (codegraph backend and measurement) |
| Ideas adopted from comparable tools (`docs/research/`), each tracked as a criterion | DIPO-2 to DIPO-7, DIPO-10, M0, M1, M2 |
| Review, parking, triage, tiers, test command | M1 |
| Parallel runs | M2 |
| Plan, refine, ready, estimate with AI interviews; retro and insights | M3 |
| Roles and hiring | M4 |
| Conversation layer | M5 |

## Working rules

- Code drives, AI fills the gaps. A spike or story that asks a model to do something code can know is wrong.
- Decisions are made before code and recorded as ADRs. The maintainer approves each one.
- The maintainer does not review code. A reviewer agent does. The maintainer tests behavior when a story is flagged.
- Bootstrap work goes directly to `main`. From step 3 on, all work goes through branches and PRs.
