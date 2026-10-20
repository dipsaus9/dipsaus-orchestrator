# What dipo's own runs teach us (research, 2026-10-20)

Research done on 2026-10-20 at the maintainer's request, after dipo had delivered about 100 M1 stories on this repository. The question: what are the gaps dipo's runs show, why do they exist, and how should a worker behave instead of how its contract describes it today. The goal is to learn and improve dipo before more M1 review stories are built.

Sources:
- the 86 story runs under `.git/dipo/runs/` (2026-10-16 to 2026-10-20), measured by script from each run's `events.ndjson` and the run tables of a test dipo home;
- the gap log kept beside the runs (gaps G1 to G46 and about 70 run entries);
- the independent reviews and hand fixes of each story;
- the worker contract L1 (`packages/engine/src/prompts/contract/implement.md`), the reviewer contract, the task templates, CLAUDE.md and the story standard.

The data covers the build phase only. dipo's own reviewer never started in this period (section 3.6), so every review was done outside dipo.

How to read this document: section 1 gives the numbers, section 2 the short answer, section 3 the gap classes with their causes, section 4 the worker's documented against observed behaviour, section 5 how a worker should behave, section 6 the ranked improvements and section 7 the decisions this needs from the maintainer.

## 1. The numbers

- **Runs:** 86. By tier and model: 52 tier S on Haiku, 30 tier M on Sonnet, 4 tier L on Opus.
- **Spend:** $85.68 in total.
  - Haiku: $2.12, about $0.04 a run.
  - Sonnet: $42.67, $1.42 a run on average.
  - Opus: $40.89, $10.22 a run.
  - The 12 runs that did not reach done or review cost $14.24, 17% of spend.
- **Outcomes:** 42 done, 32 in review, 6 blocked, 3 capped, and one each of verify-failing, stopped and scope violation.
- **dipo's own verify after a done report:** it passed first time in 74 of 76 runs. It passed in all 18 runs where the worker never ran verify itself. It also passed in all 7 runs where the worker saw red tests and blamed the sandbox, so those diagnoses were right.
- **Denied tool calls:** 100, in 46 runs.
  - By source: 81 automatic denials of an approval prompt, 12 deny-rule hits, 5 of the CLI's own `sleep` blocks, 1 dipo hook refusal, 1 sandbox network refusal.
  - By command shape: `sed -i` was refused in 72% of calls (38 of 53), a leading `cd` in 60% (30 of 50), git writes and `sleep` always.
  - Compound commands themselves are rarely the problem: 6% of 1,593. The denial follows the part inside them.
- **Scripted file edits:** python heredocs were the file editor in 35 runs (303 calls). That is 26 of 30 Sonnet runs and all 4 Opus runs, but only 5 of 52 Haiku runs. The only write outside a story's scope came through such a script.
- **Temp-variable overrides:** in 18 runs. That was 60% of the first contract version's runs, and 0 to 13% after the code guard (DIPO-194).
- **"Done" while the worker's own notes admit a gap:** 25 of 78 done reports, 12 of them clear-cut.
- **Turn caps:** 3 runs capped. One more (DIPO-183) ran 185 turns against a cap of 120, and its done report was still taken.
- **Trend:** denials per run fell from 2.0 in the first contract version to 0.6 on 2026-10-20. Most of the drop came after the engine started refusing things in code. Contract text alone moved less.

## 2. The short answer

dipo's workers build well. Every run reached a report, small stories cost cents, and the engine's verify almost never disagrees with a done report. What goes wrong is mostly in the frame around the worker. That frame has four parts, in order of weight:

1. **The contract is binary where the work is not.** A worker may write only the paths in its References, and it may not prove that a test fails without its fix. When either rule meets the work, the worker quietly works around it. It writes the caveat into free-text notes, and no code reads those notes.
2. **Plans are written ahead and go stale.** References, config versions and code paths in stories are often incomplete or wrong by the time a worker runs.
3. **Prose rules lose to model habit; code rules hold.** `cd`, `sed -i`, scripted edits and temp-variable overrides kept happening after the contract forbade them. Each one stopped, or fell sharply, only when code refused it with a reason.
4. **The environment is fragile, and dipo does not explain it.** PATH order, Safe-Chain wrappers, the Mac's maintenance sleep and port slots all broke runs, and the error text rarely named the cause.

So the fix is mostly not "plan more". Give the worker structured ways to say what it needs and what it skipped, turn the rules that matter into code, and make dipo's own review loop run.

## 3. The gap classes, with their causes

Each class names its root cause: planning, contract text, engine code, environment or model behaviour.

### 3.1 Scope: References narrower than the work (about 12 stories)

- Three runs parked on scope: DIPO-139, 147 and 164.
- One skipped a test-plan item, the daemon wiring test of DIPO-227.
- Several bent the design to stay in scope:
  - DIPO-231 made a field optional so an out-of-scope tool still compiled;
  - DIPO-209 duplicated a helper;
  - DIPO-183 used a narrower config hash and a weaker retention tier.
- Eight stories had their References widened at close.

**Cause:** planning, made worse by the contract. A planner cannot see every barrel file, registry, fixture and integration test ahead of time. The contract gives the worker two options: write inside scope, or report blocked. A blocked report costs a park and a hand finish, so the worker usually takes the silent workaround.

### 3.2 Test-plan items skipped or weakly met (about 10 stories)

- A path given up: DIPO-201 and DIPO-227.
- Tests that pass without the fix: DIPO-229, 143, 177 and 134.
- Missing table rows: DIPO-237.
- A missing replay test: DIPO-164.

**Cause:** contract text and engine code. Done means "every criterion is met", and the test plan has no slot of its own in the report. No code checks that a new test fails without the fix. The worker cannot check it either, because git writes are refused; DIPO-181 tried `git stash` and was denied.

### 3.3 Done reports that are not quite true (25 of 78)

The worker usually wrote the caveat down: "not exercised", "was not added because ... outside the scope list", "follow up if the maintainer wants". But the report's single done status counted the story as met.

Examples: an ADR note claimed but missing, a line count estimated instead of measured, and a done taken after a turn-cap overrun.

**Cause:** a report schema that cannot say "met, with a deviation" or "met only against a fake", plus model behaviour under a single yes or no.

### 3.4 Approval-needing and refused tool calls (46 runs)

The Claude CLI asks approval for some calls, and nobody answers in a run, so the call is denied. One denial can poison later calls.

The worst case found: **an allowed `cd` changes the session's directory for good.** In one run the shell stayed in a subdirectory, and the next file write outside it raised an approval prompt that was denied. That is why the planned test of that story was never written.

Read-only intents were refused too: `git branch --show-current`, `git stash list`, `gh --version`, and a `sleep; tail` used to poll a background task.

**Cause:** model habit from interactive use, a CLI policy dipo cannot change, and deny rules that are wider than their purpose. The DIPO-232 contract text cut the rate; DIPO-183 had no denial in 185 turns. It did not reach zero.

### 3.5 Real defects found only by review

These were security, robustness and latency problems:
- the web gate failed open (DIPO-164);
- `timeout` and `stdbuf`, and then a quoted `<`, bypassed the gh refusal (DIPO-195);
- a status read waited on git for up to 60 s (DIPO-198);
- an upgrade would have opened PRs for old stories (DIPO-144);
- a drop could remove a worktree under a live host (DIPO-160);
- a resume race on the host socket (DIPO-231).

**Cause:** test design and planning. The worker's tests use fakes that never fail the way the real path fails, criteria list examples rather than attacks, and when a rule replaces an older barrier nobody lists what the old barrier caught.

### 3.6 Environment and operations

On 2026-10-20 this was the largest single cost, and none of it was code:
- **Setup and Safe-Chain:** setup's `bun install` failed with a bare "listen EPERM 127.0.0.1" whenever a Safe-Chain wrapper came first on the daemon's PATH.
- **dipo's reviewer could not start.** A reviewer gets no Safe-Chain context, so its sandbox takes the PATH from the login shell. There, `bun` links to a wrapper script outside the sandbox's read paths. Each review start's self-test failed, dipo retried every 70 s with no cap, and 49 short self-test sessions were spent before the retries were stopped.
- **One failure holds every office.** A single transient failure, such as one flaky self-test or a proxy timeout, holds the Claude adapter in every office.
- **Machine sleep:** maintenance sleep stretched single tests to 300 to 800 s and failed verifies on timeouts.
- **Ports and start-up:** port slots ran out, and one run took 3.5 minutes before its claim with no output.

**Cause:** environment, plus engine code that turns one transient failure into a global hold and gives a bare error text.

### 3.7 Stale or wrong plans

Stories named an old config version (DIPO-139, 164), described code from before a merge (DIPO-196, and DIPO-148 again on 2026-10-20), or claimed code paths that are not so (DIPO-205, 207, 208 and 239). The backlog-PR reviews caught each one, at the cost of a review round.

**Cause:** planning from memory instead of from the code at filing time.

### 3.8 Smaller classes

- **Flaky and slow tests** under the load of parallel runs (DIPO-136, 229 and 233); local verify takes 96 to 190 s against a 60 s target (DIPO-225).
- **Criteria a worker can never meet in its session:** CI runs, live sessions and maintainer steps. These caused 4 of the 7 blocked reports.
- **Workers run the full verify two or three times per run,** although the engine runs it anyway and almost always agrees.

## 4. Documented against observed

| Rule today | What workers did | Why | Verdict |
|---|---|---|---|
| Run every command from the worktree root; never `cd` | About 418 `cd`-prefixed commands; still seen after DIPO-232 | Habit; the CLI sometimes allows it, which rewards the habit | Clear but unenforced; needs code |
| Change files only with the edit tools (DIPO-232) | Before: `sed -i` and python heredoc edits in most Sonnet and Opus runs. After: far fewer | A script feels faster for edits over many lines | Works when present; back it with code, because scripted writes also skip the scope check |
| One command per shell call | Chains to save turns; verify output written to a file, then read | Turn economy | Fine; give a cheap way to read long output |
| Never set DIPO_TMP or TMPDIR | Broken until the code guard; obeyed since | CLAUDE.md said "fallback /tmp" | Fixed in code |
| Write only the paths in scope, or be rejected | Complied, then parked (good) or bent the design (bad) | No third option, and a park is expensive | Silent on what to do when a needed path is missing |
| Done when every criterion is met | Done with a test-plan entry unmet, the caveat in notes | The test plan has no slot in the report | Ambiguous; make the test plan part of done, as data |
| Notes: what is left and what you learned | Hold the most important facts of the run | It is the only free field | Right idea, wrong shape; split into structured fields |
| No git commands that write | Tried `git stash` to prove a test fails without the fix | No allowed way to do it | Silent on how to prove a test discriminates |
| The engine runs verify when you report done | Ran the full verify 2 to 3 times anyway | No cheaper way to be confident | Say what to run instead: the touched packages' tests |
| (silent) the turn budget | Overran caps by 5 to 65 turns | The worker never sees its budget | Show the remaining budget |
| (silent) adversarial cases for a guard | Happy-path tests; the review found the bypasses | Tests mirror the criteria | A planning and story-standard issue |
| (silent) where follow-ups go | "Follow up if the maintainer wants" in notes | No channel | Structured proposals (DIPO-166) |

## 5. How a worker should behave

Each item says where it belongs: **code** the engine enforces (CLAUDE.md: anything deterministic is code), **contract** text in L1, or **planning**. L1 stays tool-neutral, with no Claude tool names.

1. **Ask for a path instead of working around scope.** A structured request with a reason, granted by code when it is inside the story's own packages and not in `docs/decisions/`, `.dipo/`, `backlog/` or another live story's References. The grant is recorded and shown to the reviewer; anything else parks with the path as the question. Never weaken a design to stay in scope. *Code and contract; DIPO-165.*
2. **Report every test-plan entry,** with a status (done, not done, manual) and evidence. Done requires every automated entry done. *Code and contract; a new story, touching the report schema of 0014.*
3. **Name deviations as data:** where the change differs from a criterion or the context, and why. The reviewer judges each one. *Code and contract; a new story, paired with DIPO-186.*
4. **Prove each new test fails without the fix.** Best done by the engine: after verify, run the new and changed tests against the base tree and flag any that pass there. *Code; a new story.*
5. **For a guard or security change, test the bypasses.** List what the old barrier caught and test each form; test fail-closed against the real path, not a fake. *Planning (a story-standard rule for security-sensitive stories) and one contract sentence.*
6. **One command per call, no `cd`, edits only with the edit tools,** and refused by code early with a reason that names the right way. That covers a leading `cd`, `sed -i`, a redirect into a worktree file and a scripted file write, before the CLI's own approval logic poisons the session. *Code, extending the DIPO-194 and DIPO-237 guard.*
7. **Run the narrow tests and let the engine run verify:** the touched packages' tests, plus format, lint and typecheck once at the end. *Contract.*
8. **Know the budget.** Feedback and the handoff show the turns and tokens left; at about 80% of the turn cap, wrap up and report what is done and what is left. *Code and contract; a new story.*
9. **Put follow-ups where code can act on them,** as structured proposals, not notes. *Code and contract; DIPO-166.*
10. **Say "met" only from a run or a file.** Measurable criteria are measured by the engine. *Contract, plus code for measurable criteria.*
11. **Flag stale facts instead of guessing,** as a deviation that gives the real name. *Contract.*

For planning:
- The Ready gate checks that every file a test-plan entry names is inside the References (DIPO-251).
- The planner reads the code a story names at filing time.
- A story that adds a module or template lists its barrel and registry files.
- Stories hold no maintainer-only steps as criteria.

## 6. Ranked improvements

| # | Improvement | Why first | Size | Story |
|---|---|---|---|---|
| 1 | Make dipo's reviewer start, and cap and back off a failing review start | Nothing in M1a runs unattended without it; 49 sessions wasted | M | DIPO-250 (reshape after review) |
| 2 | Bounded scope requests with code grants | Largest gap class | M | DIPO-165 (its dependencies need a decision) |
| 3 | Structured test-plan statuses and deviations, done checked by code | Removes the "done but" class | M | New |
| 4 | Engine check that new tests fail on the base tree | Catches tests that prove nothing | M | New |
| 5 | Early code refusal of `cd`, `sed -i`, redirects and scripted file writes | The remaining denials, and the only scope leak | S | New, extends DIPO-194 and DIPO-243 |
| 6 | One transient failure no longer holds every office | Repeated global stops | S | New |
| 7 | Gate rule: test-plan files inside the References | Catches the DIPO-227 kind before a run | S | DIPO-251 |
| 8 | Budget shown to the worker, wrap-up at 80% | Cap overruns | S | New |
| 9 | Worker proposals for follow-ups | Captures what notes lose today | M | DIPO-166 |
| 10 | Review and CI feedback back to the worker | Turns hand fixes into worker fixes | L | DIPO-148 (after its context is fixed) |
| 11 | Environment checks that name the cause | The day's biggest time sink | S each | DIPO-240, 241, 245, 249 |
| 12 | Security-sensitive story standard | Two to four blocking review rounds each on DIPO-164 and DIPO-195 | S | Planning standard |
| 13 | Planner verifies code claims at filing | Saves a review round per batch | S | Planning process |

## 7. Decisions for the maintainer

These change ADRs or the story standard. They are asked one at a time, each with its cause and evidence; an answered question is the approval for the dated ADR note.

1. Code refusal of `cd`, `sed -i`, redirects into worktree files and scripted file writes in the worker's Bash check (0008 section 2).
2. Structured `testPlan` and `deviations` fields in the worker report, with done checked by code (0014).
3. An engine check that new and changed tests fail on the base tree (0014 or 0019).
4. Showing the remaining budget to the worker and asking it to wrap up at about 80% of its turn cap (0020).
5. One transient launch-check failure holds only what failed, not every office.
6. DIPO-165 and DIPO-166 depend on DIPO-158 and DIPO-159: build those first, or split the scope-request part out so it can go first.
7. DIPO-251's rule R29, with its limits (bare test file names, manual entries).
8. A story-standard rule for security-sensitive stories (the standard lives in the planning skill, outside this repository).

## 8. What this says about dipo's design

- **The worker is honest; the report shape hides it.** The caveats were almost always written down, in a free-text field that no code reads.
- **Binary rules invite quiet workarounds.** Scope (write or park) and git (no writes) are clean for safety, and both push the worker toward silently weakening the design. A narrow, code-checked third option keeps the safety and removes the incentive.
- **Text is for intent; code is for limits.** Every limit only written down leaked, and every limit coded held. The reviews then found the edge cases in the code, which is the better place to find them.
- **Running dipo on itself finds the environment bugs.** PATH, Safe-Chain, sleep, slots and the pending-review cascade would never show in unit tests. Keep the live checks.
