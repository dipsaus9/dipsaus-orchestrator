# Simplification audit

Date: 2026-10-24, from `main` at `c2ee7a2d`. Status: decided. The answers are in section 8, the accepted proposals in section 9 and the choices derived while rewriting the ADRs in section 10. Sources: `docs/vision.md`, all ADRs (0001 to 0021), `docs/research/2026-10-20-dipo-run-gaps.md`, and a read of `packages/*/src`. Line counts leave out tests unless a line says otherwise.

## 1. The numbers

| What | Today |
|---|---|
| Age of the project | 15 days (first commit 2026-10-09) |
| Stories Done | 285 of 300 |
| Source lines | about 137k, of which `engine` 112k (`run/` 25k in 64 files, `box/` 15k) |
| Test lines | about 130k (engine 113k) |
| Engine commands, reads, events | 28, 16, 25 (4 defined but never handled: `work.reassign`, `test.start`, `test.record`, `office.usage`) |
| CLI entries | 38, plus 15 TUI actions |
| Database | 53 migrations, about 62 domain tables, about 30 touched by one module only |
| Office configuration | about 150 keys in 17 sections, 13 schema versions in 15 days, 4 keys nothing reads |
| ADR amendments | up to 40 per ADR (0008); 0005, 0006 and 0007 have 20 to 30 each |

The vision's M0 was a walking skeleton: one Ready story, a worktree, a worker, verify, live output. The code today is about ten times what that needs, while M1 is not finished.

## 2. Why it drifted

1. **Fixes by addition.** Each gap from a live run became a new mechanism. The old one was rarely removed. Examples: the sandbox layers in 0008 (Keychain denies, `DIPO_TMP` hook, `gh help` exception, Safe-Chain wrapper, then the Safe-Chain proxy), the Ready gate phrase rules R27, R28 and R30, and the 28 park causes under 11 park reasons.
2. **Three isolation models in two weeks.** First Claude Code's Bash sandbox with hooks and a permission relay, then `srt` for engine steps, then the Apple `container` box (0021). The box replaced the others, but most of their code and vocabulary is still there.
3. **Built for futures that do not exist.** Browser listener security for a web client that does not exist, contract major/minor versioning when client and daemon ship as one binary, a 24-hour idempotency table with a crash-injection test per command, epoch and replay floor, five retention tiers, pricing catalogs checked against the CLI, backup and restore, the launchd/systemd supervisor, and machine-wide port slots for parallel runs (M2). The 0003 amendment of 2026-10-12 ("nothing planned for M0 is deferred") made this the rule.
4. **Complexity that copes with complexity.**
   - The merge slot existed for `strict`; `strict` is off, and the slot stays.
   - "No git in the box" led to CI as the verify, then to dipo checking tool calls to see that verify ran, then to catch-up copies and a `catch-up-failed` park.
   - A proxy that cannot see the network led to an in-box firewall, which root can undo, which led to a non-root user.
5. **Reversals inside days, kept as amendments.**
   - Scope as a write fence, then scope requests, then a forecast only.
   - `storyPr.open` false, then true.
   - `strict` on, then off.
   - Verify in the box, then CI as the verify, one day later.
   - "dipo does not check verify ran", reversed the same day.

   The ADR body still describes the first design, so reading an ADR no longer tells you what runs.

## 3. Same goal, many mechanisms

| Goal | Mechanisms today | One mechanism could be |
|---|---|---|
| A story stops and waits | park (11 reasons, 28 causes), `on-hold` park and `on-hold` label, pause (closes stdin after 10 min), stop, discard, drop, plan-limit hold, adapter hold, box-token hold, merge-slot `held`, live question wait | `Parked` with a reason, plus `drop`. Everything waits in one triage list |
| How a run ended | park reason, park cause, `endKind` (untyped string, 13 values), worker outcome (9) | One end vocabulary |
| Is it running well | 8 health states, 7 watchdog signals, 6 phases, 9 queue columns, evidence labels | Phase + one health value |
| Send feedback to the worker | report gate feedback turn, conflict feedback, collision messages, fix rounds (review, CI, reject, conflict), review rounds, resume with note, steer, nudges; two reopen functions; 7 resume files (3.9k lines) | "Send a message to the worker in its box" with a source tag, one reopen |
| May this go on | Ready gate + pickup re-check, R26, report gate, review gate, merge gate, override gate, CODEOWNERS hand merge, hold labels, `autorelease` guard, adapter `gateLaunch`, backlog-PR structural check | Ready gate before, review + CI after, maintainer gate when flagged |
| Is the story Done | Done poll, done-on-base reconcile, done-elsewhere, story-PR poll, merge-slot hand-merge detection | "PR merged" read from GitHub, one place |
| Recover after a crash | reconcile, host reattach, worker_hosts, processed offsets, ingest cursors, `launch.json` claim protocol, lane-b journal replay, idempotency waiting path, `run_intents`, backups with new epoch, temp sweeps | Reconcile from git + backlog + box state at start |
| Write to git | 7 commit paths (claim, parts, collisions, lane, merge-slot, reused branch, adopt), push from 8 sites, two `story-git.ts` | One git writer |
| A copy of the code | Mac worktree (files stale), box `/work`, reviewer `git archive` copy | Box for the developer, archive for the reviewer, no Mac worktree files |
| Configuration | `office.yaml`, `office.local.yaml`, `<state>/config.yaml`, Backlog `config.yml`, labels, field block, `components.yaml`, scan results in the DB, run config snapshot | Fewer keys, fewer files |
| Keep secrets out | env names scan, comment redaction, web-value gate, per-part scan, token proxy, recording scrubber, `worktree.files` and `box.files` lists | Box holds no real secrets, plus one part scan |
| Worker output stored | `events.ndjson`, `output_chunks`, `run_summaries`, `run_outcomes`, change-log rows | events file + one summary |

## 4. Leftovers on no live path (delete without a design decision)

These were found by reading call sites; each needs a check before it goes.

- `srt` runtime: `sandbox/`, `platform/sandbox*.ts`, `mktemp-shim.ts`, `daemon/src/sandbox-exec.ts` (about 1k lines). Its only caller is the Safe-Chain gate.
- The Mac developer launch plan in `workers/claude-cli/plan.ts` (949 lines; it refuses `implement` at line 807). Only the reviewer and the scan session use the rest.
- Developer nudges (`hooks/nudges.ts` 580). The developer has no hooks, yet nudge sources are written for every session.
- The `implement` Mac prompt contract (`prompts/templates.ts`), `run/backstop.ts` except `readBackstop`, `storeBaseVerify` (`base_verifies` read, never written), `insertVerifyResult` (`verify_results` never written, so `open-feedback.ts` waits for a green verify that never comes).
- `needs-permission` from a box worker that runs with all permissions.
- Contract surface with no handler: `work.reassign`, `test.start`, `test.record`, `office.usage`, events `test.started` and `test.recorded`, and the TUI key `t`.
- Config keys nothing reads: `prompt.budgets.inputsFile`, `sandbox.installCachePaths`, `sandbox.registryHosts`, `timeouts.permissionWaitSeconds`.
- Write-only tables: `pricing_checks`, `scans`.

## 5. Built ahead of need (needs a decision)

| Feature | Lines | On the `dipo run` path |
|---|---|---|
| Safe-Chain proxy behind the box web proxy (two filtering proxies in a row) | about 1.1k + `srt` | Yes |
| In-box firewall + non-root user + build box | part of `box/` | Yes |
| Merge slot with `strict` off | 4.1k | Yes |
| Pricing catalogs, drift checks | 788, 3 tables | On ingest, not for decisions |
| Retention tiers | 901 | Daemon timer |
| Backup and restore | about 800 | No |
| launchd/systemd supervisor | 357 + foreground logic | No |
| Browser listener security, contract versioning, capability flags | in daemon + contract | No |
| Port slots (M2) | about 450, 1 table | Yes |
| Proposals (M3-like) | about 640, 2 commands, 2 events | Yes |
| Scan AI fallback + capability tables | `scan/` 4.5k, 5 tables | At init / rescan |
| Plan-limit waits and holds | 509, 1 table, skip reason, signal | Yes |
| Context packs | 1.7k | Yes |

## 6. Where the code works against the vision

- **Engine separate from UI.** A question is asked live only while a TUI is connected, and the digest counts from the last TUI disconnect, so a client's presence steers the engine. The TUI cannot even answer a question; it shows a `dipo answer` hint.
- **Code drives.** "Verify ran" is now the worker's claim checked by reading its tool calls, and an office without CI relies on the worker's own verify.
- **Prepare, don't repair.** References became a forecast, and collisions are repaired afterwards with catch-up merges and fix rounds.
- **Budgets are never raised silently.** The review allowance grows the budget per round, and `verify-failing/capped` gives an implicit +50%.
- **Backlog is the source of truth.** Park state lives in the task file, in `parks` and in `backlog_mirror`, and reconcile arbitrates. Story identity lives only in the DB.
- **Mismatches warn, never fix silently (0001).** Reconcile now closes parks, renumbers and removes keys with only a notice.
- **Model-agnostic at the edge.** Claude names sit in the contract and the office config (cache split, plugins, tier aliases, `--json-schema` reports).
- **Platform.** The box needs macOS 26 with Apple `container`, while releases ship Linux binaries that cannot run a developer.

## 7. Candidate principles for the simplification

To agree on before any plan:

1. **One boundary.** The box is the isolation. Anything that guarded the Mac worker goes.
2. **One waiting state.** A story that cannot go on is Parked with a reason and shows on the desk. No holds beside parks.
3. **One loop.** Every kind of feedback is a message to the worker in its box. One counter per source, one cap rule.
4. **One source per fact.** Story facts in Backlog.md, code facts in git and GitHub, run detail in the DB. No fact kept in two places for reconcile to arbitrate.
5. **Build at the milestone, not before.** Code for M2 to M5, and infrastructure no current flow needs, is removed or not started.
6. **Delete before adding.** A fix for a gap must say what it replaces.
7. **ADRs describe what runs.** A reversed decision is rewritten in the body, not stacked as an amendment.

## 8. Open questions for the maintainer

Asked one at a time; answers are recorded here.

1. Approach: prune the current code in place, or write a small target architecture from the vision and treat today's code as a parts bin?
   **Answer (2026-10-24): target first, then prune toward it.** A short target architecture from the vision comes first, then a plan of deletions and merges in the current code, step by step, with dipo able to deliver throughout. No rewrite.
2. Platform: are developer runs macOS-only (Apple `container`) from now on?
   **Answer (2026-10-24): macOS on Apple silicon only.** The target assumes Apple `container`. Release, smoke and the supervisor shrink to darwin-arm64 and launchd; systemd, systemd-run, systemd-inhibit and bwrap go. Linux stays only as a CI host for tests that need no box. The box keeps its backend interface, so a Linux backend can come later.
3. Waiting states: which of park, hold, pause, stop, discard and drop do you use, and which can merge?
   **Answer (2026-10-24): one park, plus drop and discard.**
   - `dipo park ID --note` replaces stop, hold and pause. Every story that stops is Parked with a reason, and `dipo resume` is the only way back.
   - `drop` (remove the story) and `discard` (throw the work away, back to Refined) stay.
   - The plan-limit and adapter holds become one office-level state, "starts paused: reason", shown on the desk.
4. Isolation depth: is the box alone enough, or do Safe-Chain, the in-box firewall and the non-root user stay?
   **Answer (2026-10-24): Safe-Chain stays, in a box.**
   - Safe-Chain runs in a box instead of under `srt`, so `srt` and its code go and the box is the only sandbox technology.
   - The host-only network, the model proxy, the web proxy with its registry alias and TLS rules, the in-box firewall and the non-root user all stay.
5. Merging: keep the merge slot, or let GitHub merge (`gh pr merge --auto`) once review and CI pass?
   **Answer (2026-10-24): GitHub auto-merge.**
   - When the merge gate approves, dipo pushes one close-out commit (summary plus status Done) and runs `gh pr merge --auto --squash --match-head-commit`.
   - The PR poll reads the result: merged means Done and teardown; a conflict or red checks means one fix round.
   - The merge slot, its sync step, its re-check loop and its refusal cap go. The gate rules stay.
   - The maintainer switches on the repository setting "Allow auto-merge" by hand.
   - Maintainer's note: merging during dipo's own development may differ from later use, and **the goal is parallel runs**. The per-story box is what makes parallel runs possible, because each box has its own network. (Port slots were first kept here as well; question 9 removes them.) If merge order matters once stories run in parallel, GitHub's merge queue is the next step, not a slot of dipo's own.
6. Questions: should a worker's question always park the story (answered at the desk), or wait a fixed time, instead of depending on a connected TUI?
   **Answer (2026-10-24), as Claude read it; the maintainer may correct it:**
   - **Future:** questions are asked live while the maintainer is "online". That is a presence state the maintainer declares (the TUI may set it), not a TUI connection the engine looks for.
   - **Now, during development:** the orchestrating Claude session answers questions through `dipo answer`. Presence is not built now. A question with nobody online parks, and the orchestrating Claude answers and resumes it.
7. Infrastructure ahead of need (section 5): which pieces stay?
   **Answer (2026-10-24): all four groups are cut to their minimal form.**
   - **Cost:** dipo stores the cost the Claude CLI reports per session. The pricing catalogs, rate tables and drift check go. (Clarified by Claude while rewriting: budgets and spend alerts keep counting tokens, as before; the reported cost is shown next to them.)
   - **Data care:** one retention rule plus the pre-migration backup. The retention tiers, daily backups, restore and purge go.
   - **Clients:** Unix socket only, one contract version per binary, idempotency only for commands that start or change a run, and a plain replay from the cursor. The browser listener security, the capability flags, the 24-hour idempotency table with crash injection, and the epoch and replay floor go.
   - **Daemon:** a plain PID lock, reconcile at start, then re-attach or park each live host. Safe mode, crash markers, the stale-break protocol and the follow-only host rules go.
   - Keep-awake and launchd autostart stay.
9. Mac worktree: does a story still need one now that the code lives in the box?
   **Answer (2026-10-24): no Mac worktree per story.**
   - A claim is the story branch plus a claims row.
   - The reviewer's reads and checks come from git objects in the main repository (`git diff base..head`, `git archive`).
   - Manual testing is one on-demand command, `dipo test ID`. Correction by Claude, same day: following the design DIPO-309 already has (0021 amendment of 2026-10-22), it runs the PR head in a **test box** with a port forwarder to the Mac, not in a Mac checkout.
   - So port slots go entirely; the forwarder takes any free local port. This replaces the port-slot line under question 5.
8. ADRs: rewrite each ADR as the current design (history moved to an appendix), or write one new ADR that supersedes the drifted parts?
   **Answer (2026-10-24): rewrite in place, and merge where the contents overlap.**
   - Each ADR body becomes the current decision, with no amendment list. Git keeps the history, plus at most a short "Replaced" list per ADR, one line per earlier decision and why it went.
   - The rewritten ADRs are the target architecture; there is no separate target doc.
   - ADRs that overlap merge into the one that fits best. That number stays, and the absorbed file becomes a one-line "merged into NNNN" pointer.
   - Code cites ADRs by number only, never by section.

   Mapping (confirmed 2026-10-24, with 0005 and 0006 merged as well):

   | Surviving ADR | Absorbs | Why |
   |---|---|---|
   | 0001 Foundation | 0011 office model, 0015 build own | 0011 repeats the vision and 0001; 0015 is one rule |
   | 0002 Review, testing and merge | 0019 review loop, the merge slot parts of 0010 and 0016 | One loop from PR to merge |
   | 0003 Milestones and quality bar | - | Gains "build at the milestone, delete before adding" |
   | 0004 Language and runtime | - | macOS arm64 only |
   | 0005 Engine interface and process | 0006 daemon and IPC | Commands, events, transport, daemon and worker hosts in one place; drops versioning and the browser listener |
   | 0007 State database | - | One source per fact |
   | 0008 Worker and box | 0021 worker isolation | The box is how a worker runs |
   | 0009 TUI | - | |
   | 0010 Backlog and git | - | One git writer |
   | 0012 Story standard | - | |
   | 0013 Repo scan | - | |
   | 0014 Prompt assembly | - | |
   | 0016 CI and release | - | Keeps only CI and release |
   | 0017 Testing and configuration | - | |
   | 0020 Park and resume | - | One park, drop, discard |

   20 ADRs become 15, plus 5 pointer files (0006, 0011, 0015, 0019, 0021).

## 9. Target in short

The decisions above, plus Claude's proposals for the smaller points, marked (P). **The maintainer accepted all 14 proposals on 2026-10-24 and approved the ADR rewrite.** Once agreed, this section is written out as the rewritten ADRs (question 8), and the prune plan follows from the difference with today's code.

### Decided

| Area | Target |
|---|---|
| Approach | Target first, then prune toward it. No rewrite; dipo keeps delivering |
| Platform | macOS on Apple silicon; Apple `container` behind the box interface |
| Isolation | The box is the only sandbox technology. Host-only network, model proxy, web proxy with registry rules, in-box firewall, non-root user. Safe-Chain runs in a box. `srt` goes |
| Code copies | The box holds the developer's code. The reviewer reads git objects. No Mac worktree per story and no port slots. `dipo test ID` runs the PR head in a test box with a port forwarder |
| Waiting | One state: Parked with a reason. `dipo park` replaces stop, hold and pause. `drop` and `discard` stay. Plan-limit and adapter problems are one office-level "starts paused: reason" |
| Questions | Now: a question with nobody online parks, and the orchestrating Claude answers with `dipo answer`. Later: a declared "online" presence, not a TUI connection |
| Merging | Gate approves, then one close-out commit and `gh pr merge --auto`. GitHub merges when green. The merge slot goes. Merge queue later, if parallel runs need ordering |
| Parallel | Stays the goal (M2). Per-story boxes already make workers independent |
| Infrastructure | CLI-reported cost with budgets and alerts on top; one retention rule plus a pre-migration backup; Unix socket only, one contract version, idempotency for run commands only; plain PID lock, reconcile at start, re-attach or park each host |
| ADRs | Rewritten in place, 20 become 15 (0006 into 0005, 0011 and 0015 into 0001, 0019 into 0002, 0021 into 0008). Code cites ADR numbers only |

### Proposed (P)

1. **Park reasons: 8, no causes.** `ambiguous-spec`, `verify-failing`, `conflict`, `scope-violation` (protected files), `review-blocked`, `budget-exceeded`, `by-maintainer` (replaces `stopped` and `on-hold`), `worker-failed` (absorbs `interrupted`). `needs-permission` goes, because a box worker has all permissions. The 28 causes become a free-text detail. Resume is always the same: a new session in the box with the note. The reason only decides what resume requires: a note for `ambiguous-spec` and `review-blocked`, a top-up for `budget-exceeded`.
2. **One end vocabulary.** A run ends `done`, `parked` (with its reason) or `dropped`. `endKind` strings, worker outcomes and park causes collapse into it.
3. **Health from signals.** Keep the phase and one health value. The watchdog signals become the evidence behind health, not a second public vocabulary.
4. **One feedback path.** Every source (report gate, conflict, review, CI, reject, resume note, steer) goes through one "send to the worker in its box" function with a source tag. One reopen function, one counter per source, one cap rule. The 7 resume files and 2 reopen functions merge.
5. **No silent budget raises.** The per-round review allowance and the implicit +50% go. The reviewer gets its own budget instead of growing the story's.
6. **CI is the one verify.** The worker runs verify in its box as part of its work, but dipo no longer reads tool calls to check that it ran. The required checks on the PR are the gate.
7. **One "Done" decision.** The PR poll decides merged means Done, in one place. Reconcile's done-on-base becomes a case of the same function.
8. **One git writer.** All commits and pushes go through one module; the 7 commit paths and the two `story-git.ts` files merge into it.
9. **One source per fact.** Story status and the park reason live in Backlog.md, and dipo writes them. The `parks` table keeps run detail only. On a mismatch, Backlog.md wins and reconcile shows a notice; it never decides between copies.
10. **Ready gate: structure, not phrases.** Keep the structural rules. R30 (security stories) stays because CLAUDE.md requires it. The phrase-list rules R27 and R28 go; that judgement belongs to refine (M3) and the reviewer.
11. **Config reset.** A new config version that keeps only the keys code reads and has a default for the rest, with one migration from v13. From then on, a new key with a default needs no version bump.
12. **Contract cleanup.** Remove `work.reassign` and `office.usage`; build `test.start` and `test.record` as `dipo test` (question 9) instead of leaving them unhandled.
13. **Hooks for the reviewer only.** The hook relay stays only for the reviewer's web gate. Developer nudges and `needs-permission` relay code go.
14. **Workflow rule (0003).** A fix for a gap names what it replaces, and an ADR change rewrites the body instead of adding an amendment.

## 10. Decisions made during the ADR rewrite

- 2026-10-24, plan limit: a session running when the plan limit hits parks `worker-failed` ("plan limit until <time>"). When the office's starts paused lifts, dipo resumes exactly those parks by itself. It is the one resume that needs no command, because no cap grows and nothing is decided (0020).
- 2026-10-24, required checks (Claude, follows from GitHub auto-merge; the maintainer may veto): the required checks are only what GitHub's branch protection or ruleset requires. The office list `mergeSlot.requiredChecks` goes, because auto-merge waits for GitHub's list only (0002).
- 2026-10-24, from the 0008 rewrite (Claude; each follows from "the box is the boundary", and the maintainer may veto any of them):
  - `scope-violation` stays not resumable, as the maintainer decided on 2026-10-23: a part with a protected file or a secret means the box is no longer trusted, so the way on is discard (0008, 0020).
  - The developer gets no project-settings check: settings inside the box are harmless. The reviewer and the scan session load no settings from the repository copy.
  - The reviewer's web gate decides in its own process from a values file, so `dipo hook` no longer relays to the worker host socket.
  - Transcript tailing for usage after a crash goes; the usage the stream showed counts.
  - A worker's `blocked` report parks `ambiguous-spec`; no valid report after one correction turn parks `worker-failed`.
- 2026-10-24, from the 0005 rewrite (Claude; each follows from the infrastructure cuts of question 7, and the maintainer may veto any of them):
  - Story identity is no longer matched after a database loss by frozen branch and created date. An id that vanishes outside the engine is `Removed`, and a new id is a new story.
  - With no epoch, a cursor beyond the stream's last seq asks for a reset, which also covers a recreated database.
  - A worker host whose socket does not answer, or that speaks another host protocol, gets one verified SIGTERM and its story parks `worker-failed`. This replaces follow-only mode, also after an upgrade.
  - `daemon.autoRestartOnUpgrade` and the `office.switch` alias go.
- 2026-10-24, from the 0007 rewrite (Claude; the maintainer may veto either):
  - The one retention rule deletes everything about a run that ended more than `retention.days` ago. The default is **30 days**, a new number between the old 7-day short tier and the 1-year state tier. Outcome rows and the daily usage rollup are kept.
  - Recovery from a damaged database is by hand: stop the daemon, move `dipo.db` away or copy the pre-migration backup in, then start. There is no `dipo restore`.
- 2026-10-24, from the 0010 rewrite (Claude; the maintainer may veto any of these):
  - A claim is the branch ref, created atomically with `git update-ref <ref> <start> ""`, plus the claims row. No Mac worktree.
  - Backlog PRs also merge with `gh pr merge --auto` after the structural check.
  - Draft promotion, `amend` and the component map leave the ADR until their milestones (M3, M2).
- 2026-10-24, from the 0013 rewrite (Claude; the maintainer may veto): `PORT` is no longer required for `dev`, and a fixed dev port is no longer rated partial. Every box has its own network, so ports do not collide. The scan still records the port for the test box.
- 2026-10-24, from the review of PR #398 (Claude): a run ends `done`, `parked` or `dropped` (proposal 2), now stated in 0020.
- 2026-10-24, from the 0014 rewrite (Claude; the maintainer may veto any of these):
  - The measurement harness (four arms, 96 runs) was never built. It leaves the ADR and gets a story when wanted.
  - Context pack records go, because the pack is rebuilt every time.
  - The never-fed `base_verify` section goes.
- 2026-10-24, from the 0009 rewrite (Claude; the maintainer may veto any of these):
  - Health becomes five states (`lost`, `looping`, `stuck`, `quiet`, `busy`).
  - The phase `verify` and the `held` column go.
  - The digest's "since you left" time is kept by the TUI and passed as `since`, instead of the engine storing the last TUI disconnect. That follows principle 3: no engine behaviour depends on which clients are connected.
- 2026-10-24, from the 0017 rewrite (Claude; the maintainer may veto): the config reset is **version 14**, with one migration from versions 1 to 13. Retired keys are dropped with a warning. Office sections become `tiers`, `review`, `caps`, `merge`, `box`, `scan`, `story`, `prompt`, `base`, `worktree` (its root only), `scripts`, `timeouts` and `polling`. After version 14 a new key with a default needs no bump.

## 11. ADR rewrite progress

| ADR | State |
|---|---|
| 0001 Foundation (absorbs 0011, 0015) | Rewritten 2026-10-24, accepted |
| 0003 Milestones and quality bar | Rewritten 2026-10-24, accepted |
| 0004 Language and runtime | Rewritten 2026-10-24, approved |
| 0020 Park and resume | Rewritten 2026-10-24, approved |
| 0002 Review, testing and merge (absorbs 0019) | Rewritten 2026-10-24 |
| 0008 The worker and its box (absorbs 0021) | Rewritten 2026-10-24 |
| 0005 Engine interface and process (absorbs 0006) | Rewritten 2026-10-24 |
| 0007 State database | Rewritten 2026-10-24 |
| 0010 Backlog.md and git | Rewritten 2026-10-24 |
| 0012 Story standard | Rewritten 2026-10-24 |
| 0013 Repository scan | Rewritten 2026-10-24 |
| 0014 Prompt assembly | Rewritten 2026-10-24 |
| 0009 TUI | Rewritten 2026-10-24 |
| 0016 CI and release | Rewritten 2026-10-24 |
| 0017 Testing and configuration | Rewritten 2026-10-24 |
| vision.md, concepts.md, CLAUDE.md | Updated 2026-10-24 |
