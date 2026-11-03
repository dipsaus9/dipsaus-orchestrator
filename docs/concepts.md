# Concepts

Shared vocabulary, matching the ADRs in `docs/decisions/` (checked 2026-11-03). One term per concept: where a word was used for more than one thing, the row says which meaning is meant and what the others are called. The ADR that defines each term is named at the end of its row.

| Term | Meaning |
|---|---|
| **Office** | One project as seen in the orchestrator: its backlog, roster, running work and state. Offices are isolated from each other (0001) |
| **Project** | A git repository with a Backlog.md backlog in which an office is initialised |
| **Office list** | The software-level list of known offices that the maintainer switches between. Holds no work state (0001, 0007) |
| **Maintainer** | The human: visionary, manager, tester. Decides direction and approves gates |
| **Orchestrator** | The code-driven core, plus the AI-assisted help that sets things up for the maintainer. Code first, AI to fill gaps |
| **Engine** | The headless part of the orchestrator: state, gates, scheduling, workers, git. Commands in, events out (0005) |
| **Client** | A UI on top of the engine: the TUI first, later maybe a web or desktop app (0009) |
| **Daemon** | The engine running detached, so work survives closing a client. One per user, for all offices. Its states are `starting`, `recovering`, `running` and `draining` (0005) |
| **Worker host** | A detached process per session that runs the worker and writes its output to a file, so a daemon restart never kills a session (0005) |
| **Agent** | An AI worker created from a role to do one job, such as the developer or the reviewer of a story (0001). Not the same as a launchd agent (macOS autostart, 0005), or the builder and reviewer agents that build this repository (0002) |
| **Session** | One run of the model CLI for an agent: a developer, reviewer or scan session. Its id has the prefix `agt_` (0005, 0008) |
| **Role** | A stored, versioned definition of a kind of agent inside an office: purpose, instructions, allowed tools, default model and effort (0001, M4) |
| **Hiring** | Adding a role to an office's roster |
| **Roster** | The roles available in one office |
| **Worker adapter** | The interface through which the engine runs an agent's sessions. The Claude Code CLI is the first adapter (0008) |
| **Box** | The Apple `container` VM a developer runs in, one per story, from claim to merge, with its own local git repository. The box is the isolation boundary (0008) |
| **Part** | A piece of work the worker hands over from its box. dipo scans it, commits it on the story branch and pushes it (0008) |
| **Test box** | A short-lived box that runs a story's pushed head for the maintainer's test (0002) |
| **Context provider** | The part of the engine that decides which code a worker sees, from the story's references and inputs (0014) |
| **Story** | A unit of work in Backlog.md with a Story line, acceptance criteria, dependencies, references, test plan and status (0012) |
| **Story line** | The `Story:` line of a story: who wants what, and why ("As maintainer I want ... so that ..."; a spike: "We need to decide ... so that ..."). Done-when goes in the criteria (0012) |
| **References** | The planner's forecast of the files a story will touch. Used for scheduling and context, not a write fence (0012) |
| **Milestone** | A group of stories in Backlog.md, used in place of epics (0003) |
| **Spike** | A story that ends in a decision record rather than product code (0012) |
| **Ready** | A story that passed the Ready gate: its unknowns are resolved and it meets the story standard. Only Ready stories run (0012) |
| **Unknown** | An open question about a story that must be resolved before it is Ready |
| **Tier** | A story's difficulty (S, M, L), set at refine time and confirmed by the maintainer. It chooses the model and caps (0008) |
| **Caps** | The limits of a run: tokens, turns, minutes, loops, review rounds, CI and conflict attempts. Fixed at run start; only a recorded grant raises one (0020) |
| **Phase** | Step of a run: `setup`, `build`, `review`, `test`, `merge`. Parked is a status, not a phase (0009) |
| **Park** | Stopping a story that needs a human, with one of eight reasons, while other work continues. Parked is the only waiting state for a story (0001, 0020) |
| **Resume** | Lifting a park: `dipo resume`, or dipo by itself for the parks a plan limit caused, once starts paused lifts. The next session is always a new one with a handoff, never a continued CLI session (0008, 0020). Lifting starts paused is not a resume |
| **Starts paused** | The office state for problems that are not a story's: a plan limit, or a failed adapter check such as a broken CLI or box token. No new session starts until it lifts, by itself or with `dipo daemon resume-starts`; a box-token pause lifts only with a new `dipo login box` (0020). The daemon's `draining` state, in which no new work starts either (error `daemon.draining`), is a different thing (0005) |
| **Wait label** | A PR label from `merge.waitLabels` that makes a story's merge gate wait for the maintainer (0002). Hold is not a story state: a set-aside story is Parked `by-maintainer` (0020) |
| **Fix round** | One round of feedback to the same worker in its box, for every source: report gate, conflict, review, CI, reject (0002) |
| **Reviewer** | A separate agent that checks each pushed head against the story's Story line and criteria, in a read-only box of its own. Never sees the developer's reasoning (0002) |
| **Gate** | A decision point with a recorded result: the Ready gate (`dipo gate`), the report gate, the review, the test gate and the merge gate (0002, 0012). Verify, CI's required checks and the maintainer's release approvals are checks, not gates |
| **Merge gate** | The decision to merge a PR whose review approved. By rule, and then GitHub merges once the checks pass on the close-out head; or it waits for the maintainer, and then it opens only once the checks are green (0002) |
| **Required checks** | The checks GitHub's branch protection requires on the base. They come last: GitHub's auto-merge waits for them (0002, 0016) |
| **Acceptance test** | The maintainer testing the behaviour of a story with `dipo test` (0002) |
| **Cutover** | The point from which dipo delivered its own stories (DIPO-115, M0). The prune cutover gate (DIPO-351, passed 2026-10-29) is a separate, later event (0003) |
| **State database** | The one local SQLite file with the run detail and dipo's own state of every office, keyed by office, outside every repository. Never the only copy of a story fact (0007) |
| **Your desk** | Everything waiting on the maintainer, in one ordered list: starts paused, questions, merge gates, parked stories, hand actions, proposals (0020) |
| **Proposal** | A follow-up, spike or tool a worker suggests. Nothing happens until the maintainer accepts it (0020) |
| **Health** | The engine-derived state of a running session: `lost`, `looping`, `stuck`, `quiet`, `busy` (0009) |
| **Evidence label** | How a value the engine sends is known: `checked` (engine measured it), `claimed` (worker, CLI or reviewer said so), `estimated` (computed by a rule), `none` (no fact). The TUI does not show it (0009) |
| **ADR** | Architecture decision record in `docs/decisions/`. Describes what runs; each decision lives in one ADR, and a changed decision rewrites the body (0003) |
