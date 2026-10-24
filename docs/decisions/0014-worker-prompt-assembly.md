# 0014 Worker prompt assembly and the context provider

Status: accepted. First written 2026-10-10 (spike DIPO-10). Rewritten 2026-10-24 for the simplified design. The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Decision in short

A worker gets a short prompt that code builds from structured data. It does not get a process manual to read and re-execute. Everything mechanical stays in code and never appears as an instruction. The prompt keeps Claude Code's default system prompt, appends a static contract and role that stay byte-identical across stories so they cache, and puts all story data in the first user message.

## 1. Layers

| Layer | Content | Delivered as | Lives in |
|---|---|---|---|
| L0 | Claude Code's default system prompt and tools | Default, with `--exclude-dynamic-system-prompt-sections` | Claude Code |
| L1 | The worker contract: what dipo does, what the worker sends back through the door (0008), and "facts are pre-fetched, do not re-fetch" | `--append-system-prompt-file`, first part | `engine/src/prompts/contract/<kind>.md` (`box`, `review`) |
| L2 | Role instructions | The same file, after L1 | `.dipo/roles/<name>.md` (M4); the built-in `developer` and `reviewer` until then |
| L3 | Project rules | Claude Code's own `CLAUDE.md` and `AGENTS.md` loading | The repository |
| L4 | The task message: story data, context, handoff, feedback | First user message | `engine/src/prompts/task/` |
| L5 | Later messages: feedback, answers, steers | New user messages | `engine/src/prompts/feedback/` |

- **Templates.** Templates are logic-free Markdown with named slots. Code decides whether a section appears, fills it, applies budgets and orders it.
- **Ownership.** L1 and the section templates are engine code; an office cannot override them, because they carry the boundary between code and AI. An office tunes roles, budgets and the context provider.
- **Golden files.** The rendered L1+L2 and a sample L4 per kind are golden files in tests.
- **Fixed headings.** Sections have fixed headings in XML-like tags (`<outcome>`, `<criteria>`), so the contract can name them.

## 2. What a prompt receives

**The developer's task message (L4).** Long reference material comes first, and the story contract and feedback come last:

1. `context`: the context pack (section 5).
2. `inputs`: F9 files pre-fetched within budget; URLs are listed only.
3. `dependencies`: title and outcome of each F7 dependency, one line each.
4. `background`: the free description text, within budget. A cut leaves a marker naming the task file.
5. `handoff`: section 4, for a session after the first.
6. `story`: id, title, type, tier.
7. `outcome`.
8. `criteria`: numbered as in Backlog.md.
9. `references`: F8, the planner's forecast of the files to touch, as context, not a fence.
10. `test_plan`: the automated entries to write, and the manual entries the maintainer will check.
11. `answers`: resolved unknowns, question and answer.
12. `instructions`: F17.
13. `feedback`: section 6, on a fix round.

**Precedence,** stated once in L1: the contract beats the story's instructions, the story's instructions beat the role's defaults, and project rules apply throughout. A conflict between project rules and the contract makes the worker report `blocked`.

**The report** (`--json-schema`, 0008) carries:
- status: `done` or `blocked`;
- each criterion met or not, with evidence;
- a summary;
- each test-plan entry: done, not done, or manual, with evidence;
- deviations from the story;
- an optional question;
- at most three proposals (0020) and three decision notes. dipo shows a decision note to the maintainer and never writes it into `docs/decisions/`;
- notes for a later session, at most 1,500 characters.

A missing or invalid report gets one correction turn (0008).

**The reviewer** receives what 0002 lists. It never gets the developer's handoff, notes, reasoning or transcript.

**Left out of every prompt:** process rules (gate, lifecycle, git), Backlog CLI usage, other stories beyond the dependency lines, labels, priority, park records except the maintainer's answer, office configuration, earlier transcripts, and anything code can answer.

## 3. What stays in code

These never appear as instructions:

- selection, the Ready and pickup checks, dependencies;
- the branch, the claim, the box;
- every Backlog.md write, every commit and push (0010);
- the part scan, the report gate, the conflict check;
- the PR, spawning the reviewer and judging its report, CI;
- caps, parks and resumes;
- the model, effort and tools per tier and role;
- context selection and usage capture.

L1 holds one sentence for the boundary: dipo handles git, the backlog, the PR and the review, and the worker reports instead. The box has no git, no `backlog` and no `gh`. The worker runs the office's verify itself before it reports done (0008).

## 4. Sizes, budgets and the handoff

- **Budgets.** Section budgets are counted in characters, so code needs no tokenizer. Every section has one, set per project size class (S under 150 tracked files, M under 500, L under 5,000, XL above):

  | Section | S | M | L | XL |
  |---|---|---|---|---|
  | `context` | 12,000 | 18,000 | 24,000 | 32,000 |
  | `inputs` | 8,000 | 12,000 | 16,000 | 20,000 |
  | `dependencies` | 1,500 | 1,500 | 2,000 | 2,000 |
  | `background` | 2,000 | 2,000 | 3,000 | 3,000 |
  | `handoff` | 6,000 | 6,000 | 6,000 | 6,000 |
  | `feedback`, per item / total | 3,000 / 8,000 | same | same | same |
  | Review `diff` | 40,000 | 60,000 | 80,000 | 80,000 |

  A file is at most 4,000 characters per item. A log keeps at most 60 lines.
- **Cuts.** A cut is deterministic, on a line boundary (a log keeps its tail, everything else its head), and leaves a marker naming the file and line where the rest is.
- **The story contract is never cut.** Title, outcome, criteria, references, test plan, answers and instructions are capped together at `prompt.contractMax` (12,000), which the Ready gate checks as R26 (0012).
- **The whole task message** is capped at 40,000, 50,000, 60,000 or 70,000 characters by size class. Over the cap, sections drop in this order, each with a marker: dependencies, background, the tail of the context, then the content of inputs (the list stays).
- **Caching.** L1+L2 hold no ids, dates, paths or counts, and their hash is stored per run. Rendering is deterministic: the same story and commit give the same bytes. New information within a session arrives as user messages, never by changing L1+L2.
- **The handoff.** Every developer session after the first is a new session in the story's box with a handoff (0008). Code assembles it from:
  - the parts delivered since the start commit;
  - the criteria of the last report;
  - the open feedback;
  - the newest worker notes, the only model-written part;
  - the budget line: turns, minutes and tokens used and left.

  A handoff never includes a transcript.
- **Wrap-up.** At about 80% of any cap, L1 tells the worker to stop new work, finish, and report done or blocked with what is left.

## 5. The context provider

The context provider decides which code a worker sees. The interface is `gather(request, budget) -> ContextPack`. A provider returns items (path, range, text, reason), never prose; the engine renders them. For the same inputs the output is the same.

The default provider uses no external tool and no model:

1. **References.** An existing file appears in full under the per-item cap, otherwise its head with a marker. A directory, and the parent of a new path, appear as a summary: the file count and at most 15 files, the ones changed most recently on the base. Directories of decisions or recordings are listed only when the story names a file in them.
2. **Inputs.** Pre-fetched into `inputs`.
3. **Tests.** Test files next to the referenced files, matched by name, are listed, not inlined.

The pack is built again whenever a task message is built. Nothing about it is stored except its size.

## 6. Feedback carries the evidence

Every feedback item is built by code from the failing fact and sent through the one feedback path (0002):

| Source | Evidence in the item |
|---|---|
| Report gate | What is missing: the test-plan entries not done, the conflict markers left |
| CI | Check name, job, failing steps, the log tail, `file:line` locations |
| Reviewer | Criterion and evidence, or a finding with its kind, `file:line` and the quoted line |
| Conflict | The conflicted paths and hunks, within budget |
| Maintainer | The reject or test note, or a steer, verbatim inside a template |

Maintainer text is always wrapped in a template and never starts a message, so it can never begin with `/`.

## Replaced

- Native `--resume`, chosen when context use was under 60% and a re-read cost at most three times a handoff (2026-10-10). Replaced by a handoff in the kept box for every later session (0008, 2026-10-22).
- Nudges through `PostToolUse` and `SessionStart` hooks: out-of-scope writes, a stale context pack, input changes, 80% of budget (2026-10-10). Removed (2026-10-24): the developer has no hooks, and the budget line plus L1's wrap-up rule cover the budget.
- The scope contract "you may write only these paths", the no-git and no-`cd` rules, scope requests and lockfile pairing (2026-10-10, 2026-10-16). Replaced by references as a forecast and parts (0008, 2026-10-21).
- Verify and commit by dipo at In Review, inside `srt` (2026-10-10). Replaced by the worker's own verify and CI (0002).
- A `base_verify` section with the base commit's known failures, and a run of new tests against the base commit (2026-10-20). Never fed or never built. Removed (2026-10-24); a run against the base is M2 work if it returns.
- The optional codegraph backend, the comparison of backends, and stale-index detection (2026-10-10). Moved to Later (0003). The comparison stays in `docs/research/2026-10-comparable-tools.md`.
- Stored context pack records with blob ids, used to rebuild packs after a restart (2026-10-16). Removed (2026-10-24): the default pack is cheap to build again.
- The four-arm measurement harness against the `dipsaus-ai` baseline: 96 runs, rating rules and decision thresholds (2026-10-10). It was never built. Removed from this ADR (2026-10-24); it gets a story of its own when the maintainer wants the measurement. The design is in git history.
- `commitSubject` and `needsPermission` in the report. Parts carry the worker's messages, and a box worker has every permission (0008).
