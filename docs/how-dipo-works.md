# How dipo works

A plain-language map of the product for its maintainer. It describes what runs today, after M1. The decisions behind each part are in `docs/decisions/`, cited here by number. Words in bold the first time are defined in [concepts](concepts.md).

## What dipo does for you

You write a story in your project's backlog and say it is Ready. dipo takes it from there. It checks the story, makes a branch, starts a fresh Apple `container` **box** for it, and runs a Claude worker inside that box. The worker hands its work back in pieces, and dipo checks, commits and pushes them. It runs the project's own checks, opens a pull request, has a second Claude session review the change, waits for CI, and merges. When something needs you, the story stops with a reason and lands on your **desk**, and everything else keeps going. You plan, answer questions, test what you want to test, and decide the merges you asked to decide. Code does everything code can know (0001).

## A story's life, step by step

**1. You write the story.** Until M3 brings the planning commands, you write stories by hand with the Backlog CLI, as Refined. The heart of a story is its **Story line**: "As maintainer I want ... so that ...". Below it go the acceptance criteria, the files you expect it to touch, a test plan and a tier, S, M or L. The tier picks the model and the limits (0008, 0012). You see the story in the TUI's queue (key `2`), where a Refined row shows its first gate failure.

**2. The Ready gate checks it.** `dipo gate <id>` runs about thirty rules over the story's fields. It uses no model and reads no files, so the same story always gets the same answer. To make a story Ready, you set the status in a backlog-only pull request. CI runs the gate on every story that PR makes Ready, and dipo's structural check stands in for a reviewer, so the PR merges in minutes (0010, 0012). A failure prints the rule and what is wrong.

**3. dipo claims it and starts a box.** `dipo run` picks the first Ready story whose dependencies are Done, or the ones you name. It checks the story once more, creates the branch `<ID>/<slug>`, commits the status In Progress on it and pushes. Then it builds the box: a copy of the code at that commit with its own small git history, the office's packages installed through Safe-Chain, a firewall, and no route out except dipo's own proxies. Nothing of your Mac is inside, no keys and no home folder (0008). The TUI overview (key `1`) shows the story under RUNNING in phase `setup`, then `build`. `dipo run --dry-run` shows what would happen without doing it. Until M2, one developer works at a time.

**4. The worker builds.** Inside the box the worker may do anything: run commands, install packages, search the web. It cannot get out. It sends finished pieces, called **parts**, through a narrow door. dipo scans each part for secrets and for protected files such as CI workflows and the story's own task file, then commits and pushes it. A worker can also ask a question, report that it is blocked, or propose a follow-up story (0008). You see a live `now:` line, health (`busy`, `quiet`, `stuck`, `looping`, `lost`), criteria met, loops, and the share of the budget used. `dipo watch` shows the same in plain text. You can send a message with `dipo steer` or stop it with `dipo park`.

**5. dipo verifies.** When the worker reports done, code checks the report: every automated test-plan entry covered, no conflict markers left. Then dipo runs the project's `verify` script inside the box. Then it checks with git whether the branch still merges cleanly into the base. Any miss goes back to the same worker as one **fix round** (0002).

**6. A reviewer checks it.** dipo ticks the met criteria, sets the status In Review and opens the pull request. The PR's title and body are built from the story, with no model text. A separate reviewer session reads the change in a read-only box of its own. It never sees the developer's reasoning. It judges each criterion, and a finding blocks only when its evidence checks out against the actual changed lines. dipo posts the verdict as one PR comment (0002). A blocked review starts a fix round. The overview shows the story under IN REVIEW.

**7. CI runs.** GitHub runs the repository's required checks on the pushed head. dipo polls them. When a check fails, dipo reads the failing job's log, finds the file and line, and sends that to the worker as a fix round (0002).

**8. The merge gate decides.** Once the review approves, the merge gate opens. Usually it is decided by rule and dipo goes ahead at once. It waits for you when you asked for it: auto-merge off, the story flagged test-before-merge, a wait label on the PR, a criterion the reviewer left to you, a change to `docs/decisions/`, or a change to a path `CODEOWNERS` protects. Then it shows on your desk with `dipo approve` and `dipo reject` ready to type. `dipo test <id>` starts a test box with the story's code running and shows you the URL and the manual test steps. You record the result with `dipo test pass` or `dipo test fail` (0002).

**9. Done.** dipo commits the final summary and the status Done on the branch, pushes, and asks GitHub to merge once the checks pass. When the PR merges, the story is Done, and dipo deletes the box and the branch (0002, 0020).

### Where it can stop, and what lands on your desk

A story that cannot go on is **Parked** with one of eight reasons, keeps its branch and its box, and waits. Other stories continue (0001, 0020).

| Reason | When | What you do |
|---|---|---|
| `ambiguous-spec` | The worker asked a question or reported it is blocked | `dipo answer` or `dipo resume --note` |
| `budget-exceeded` | A token, turn or time limit was reached | `dipo resume --budget ... --note ...` |
| `verify-failing` | Verify or CI stayed red after the allowed rounds | `dipo resume`, maybe with a note |
| `conflict` | The worker could not resolve a merge conflict | `dipo resume`, maybe with a note |
| `review-blocked` | The reviewer blocked it in three rounds | `dipo resume --note`, or overrule with `dipo approve --note` |
| `scope-violation` | A part touched a protected file or held a secret | Not resumable: `dipo discard`, then a new run |
| `worker-failed` | The worker, its box or its host failed | `dipo resume` |
| `by-maintainer` | You parked it | `dipo resume` |

A problem that is not one story's, such as the subscription's plan limit or a broken login, pauses new starts for the whole office ("starts paused"). It lifts by itself when the cause clears, or with `dipo daemon resume-starts`; a pause for the box token lifts only with a new `dipo login box`. A session that hits the plan limit parks `worker-failed` and resumes by itself once the pause lifts (0020).

Your desk is one ordered list of everything that waits on you: starts paused, open questions, merge gates, parked stories, things only you can do by hand, and the worker's proposals. Each item comes with the exact command to type. You see it with `dipo desk`, or with key `3` in the TUI, and the Mac posts a notification when a new item arrives (0009, 0020). To give up on a story, `dipo discard` throws its work away and sends it back to Refined. `dipo drop` removes it from the backlog.

## The parts of the app

The code is a Bun workspace of seven packages, about 132,000 lines without tests. Lint rules hold the boundaries between them (0004). Sizes below are source lines without test files, measured on 2026-11-03.

**`contract`, about 4,100 lines.** The shared language: every command, read, event and config shape, with its validation. It has no I/O. It is separate because both the engine and every client need it, and clients may never import the engine. Without it, the TUI would have to reach into the engine to know what a message looks like (0004, 0005).

**`engine`, about 110,000 lines.** The brain. It decides everything: what runs, gates, parks, reviews, merges. It knows nothing about sockets or processes, so tests run it without starting anything. It is separate so that no screen can depend on its insides, and so that a new client never changes how work runs (0001, 0005). It is five sixths of all source lines, and nearly a fifth of its own lines are comments.

**`daemon`, about 1,900 lines.** The body. It is the long-running process: it holds the lock, serves the socket the clients talk to, and starts worker hosts. It wires the engine to the outside world and holds no decisions of its own. It is a separate package so the engine stays free of process code, and so the command-line tool loads it only for its daemon-side commands (0005). Honestly, it is small enough that the separation is a boundary, not a matter of size.

**`client`, about 4,100 lines.** How a screen talks to the daemon: the message protocol, a store that keeps the latest view of an office, and, in its Mac half, starting, stopping and installing the daemon. The TUI and the command-line tool both use it. A future web client would reuse the protocol half, and that is why that half uses no Bun or Node calls (0004, 0009). Until such a client exists, that split buys nothing yet.

**`tui`, about 5,800 lines.** The terminal screen, built with Ink and React. It only shows views the engine computed and sends commands. It is separate so React and Ink load only when you open the TUI, and so it cannot import the engine (0009).

**`cli`, about 4,800 lines.** The `dipo` binary itself. It reads your command line, sends the command through `client`, and prints the result. It loads `daemon` and `tui` only for the commands that need them (0004).

**`testkit`, about 1,100 lines.** Helpers for tests only: a fake clock, temporary repositories, a fake process, and the guard that keeps tests away from your real dipo folders. It is never shipped (0017).

### Inside the engine

The engine's folders fall into nine groups. The lint rules put them in six bands, so a lower layer never reaches into a higher one (0004).

- **Running a story, about 32,000 lines** (`run`, `run-state`, `worktree`, `stories`, `ingest`, `host`). Claiming, starting sessions, reading the worker's output, fix rounds, park and resume, starts paused, reviews and tests, the Done check and teardown. This is the largest group, and `run` alone has 49 files. The folder `worktree` holds claims and teardown, although stories have had no worktree since the box replaced it. The name is left over.
- **The box, about 19,700 lines** (`box`). The VM itself, its image and package cache, the web proxy, Safe-Chain, the model proxy that adds your login and counts every token, the firewall, the door, parts, and the test box. Most of it is the security boundary of 0008 and earns its size. One file, the overlap and catch-up logic for two stories that change the same files, is about 2,000 lines on its own. It mostly serves the parallel runs of M2, although a parked or in-review story can already overlap with a running one today.
- **The backlog, git and the Ready gate, about 14,000 lines** (`backlog`, `story-store`, `git`, `gate`, `gate-decisions`). Running the Backlog CLI safely, the story lane and the planning lane, backlog PRs and their structural check, the one module that writes git, and the gate's rules (0010, 0012).
- **State and recovery, about 10,400 lines** (`db`, `records`, `changelog`, `views`, `reconcile`, `retention`, `backup`). The database with about 55 tables, the stored facts, the change log that feeds events, the views derived from facts, and reconcile at start, which corrects dipo's copy from Backlog.md and git (0005, 0007).
- **Wiring and the Mac, about 9,900 lines** (`create`, `platform`, `keepawake`, `log`, `wiring`). The composition root that builds the engine in one order, and the only code that touches Bun and macOS (0004, 0005).
- **The worker and its prompt, about 8,500 lines** (`workers`, `prompts`, `context`). The Claude CLI adapter, the prompt templates, and the context provider that picks the code a worker sees. The context provider has a slot for a second, smarter backend that is Later work (0003, 0008, 0014).
- **Offices, scan and config, about 6,600 lines** (`office`, `scan`, `config`). Opening an office, learning how to install, start and verify a repository, and the office configuration (0013, 0017).
- **Reviews and merging, about 5,800 lines** (`review`, `merge`, `story-pr`). The reviewer's verdict, the merge gate, close-out and auto-merge, and the story PR (0002).
- **What you see and do, about 3,700 lines** (`overview`, `commands`, `reads`, `questions`, `software-stream`). The desk, the overview, the "since you left" digest, and the command registry (0005, 0009, 0020).

Where it is large for what it does today: `run` and `box` together are about 42,000 lines, two fifths of the engine. A few single files pass 1,500 lines, among them the overlap logic, the story's park and resume, and the Backlog CLI runner. The overlap logic is the part most tied to M2 and the first to look at when M2 is planned.

## Where things live

- **Your stories** live in the project's `backlog/` folder, managed by Backlog.md. They are the one source for every story fact. A running story's status changes travel on its own branch and reach the base when its PR merges. Planning changes, such as a park of a story that is not running or an accepted proposal, travel in one backlog-only PR per office (0010).
- **Code** lives in git and on GitHub: one branch `<ID>/<slug>` per story, one PR per story, CI, merges. dipo does its git work in its own copies of your repository, never in your checkout and never in a box (0008, 0010).
- **dipo's database** is one SQLite file, `~/Library/Application Support/dipo/dipo.db`, for all offices. It holds run detail and dipo's own state: runs, costs, verdicts, gate decisions, questions, proposals. It never holds the only copy of a story fact, so losing it loses history, not work (0001, 0007). This release squashed its schema: a database from an earlier dipo is refused with a message that says to move it away and start fresh, then `dipo office open` each repository again.
- **Configuration.** `.dipo/office.yaml` in each repository is the office's committed configuration: box packages, review models, merge rules, limits. `.dipo/office.local.yaml` is the same for this machine only and stays out of git. `config.yaml` next to the database holds the settings for dipo as a whole: autostart, spend alerts and desk notifications (0005, 0017). `dipo office reload-config` reads the office file again.
- **The box** is an Apple `container` VM per story, alive from the claim until the merge, drop or discard, and stopped while the story waits. Its box login token sits in the Keychain, set with `dipo login box` (0008).
- **Raw worker output** for each run is in the repository's `.git/dipo/runs/` folder, which git never tracks. **Logs** are in `~/Library/Logs/dipo`, readable with `dipo daemon logs` (0005, 0007).

## Words you will see

Every term on this page, and the rest, is in [concepts](concepts.md), one meaning per word.

## What is next

The milestones, M2 parallel runs first, are in [0003](decisions/0003-milestones-and-quality-bar.md).
