# M1 close-out review, 2026-11-02

An independent review of milestone M1 on `origin/main` at `01f38a19`. The reviewer built none of this code. Paths are relative to the repository root. Unless a finding says otherwise, line numbers are at `01f38a19`.

**Method.** I read the milestone, the vision, the concepts and every ADR. Three read-only agents gathered facts across the code, and I re-checked every claim in this report that carries weight. I ran these tests and probes:

- `packages/engine/test/backlog/status-command.test.ts`: 35 pass. Its last test runs the pinned Backlog CLI.
- `packages/engine/test/engine/review-loop.ci.test.ts` with `DIPO_TEST_CI=1`: 12 pass. It uses real git and an in-memory code host.
- Three probes in a scratch folder:
  - Bun 1.4.2 `bun:sqlite` with several statements in one call.
  - The Backlog CLI with planted Bun configuration (M1-7).
  - `readCompleteLines` on a file that shrank between stat and read.

I did not run `bun run verify`, the whole suite or any box test.

## TL;DR

- **M1 is done in scope.** All 275 `m-1` stories are Done, and every M1 promise is in the code. Real-path proof of the whole loop rests on hand runs: no automated test reaches GitHub, and box tests run only by hand.
- **N-1 and V-1 are closed** for every path a worker can reach. The residue is low and maintainer-side (M1-7).
- **Finding 1 (high):** any process in a developer or reviewer box can use the model proxy, which adds the maintainer's subscription token. That usage is outside every cap and every spend alert (M1-1).
- **Finding 2 (high until PR #544 merges):** on Bun 1.4.2, a migration statement that fails at run time is skipped without an error, and the step is still recorded as applied. I reproduced this (M1-2).
- **Finding 3 (medium):** the engine changes how it handles a worker's question depending on whether a TUI is connected. That breaks 0001 principle 3 and 0020 (M1-4).
- **Blocked M2 at the time of this review:** M1-1 had to be fixed first, because N boxes share one unmetered proxy. Also needed: merging PR #544, and lifting the serial points per office (the git queue, the worker place, the PR poll, the single web route).

## A.0 Earlier findings (2026-10-21)

Status: **closed** (fixed on main), **open** (the weakness still exists), **moot** (the code is gone and nothing replaced it with the same weakness).

| Id | Status | Evidence |
|---|---|---|
| **N-1** | **closed** | The worker can no longer write any folder dipo runs the Backlog CLI in. Story calls run in a fresh folder that holds only `backlog/config.yml` and the task file, both read from git objects (`packages/engine/src/backlog/story-copy.ts:1-12`). The box's files never reach that folder. Every call gets only `PATH` and `HOME` (`backlog/runner.ts:77-92`, `:473`), and has a 60 s deadline (`:26-30`). A part that adds Bun configuration or environment files (`story-store/protected.ts:82`, `context/secrets.ts:12`, `box/parts.ts:500`) parks the story. Tests: `test/backlog/runner.test.ts:169-181`, `test/backlog/clean-folder.ci.test.ts:150`. Residue: see M1-7. |
| **V-1** | **closed** | Before every status change, `runBacklog` scans every config place and task file the CLI reads. It refuses when one sets `onStatusChange` or `on_status_change`, or cannot be checked (`backlog/runner.ts:449-461`, `:536-620`). `backlog.config.yml`, the story folders, `.backlog/` and `.mcp.json` are protected in parts (`story-store/protected.ts:58-87`). The CLI never runs in the box's files. Test: `test/backlog/status-command.test.ts`, whose last test shows that the pinned CLI does run such a command and dipo's call does not. I ran it: 35 pass. |
| V-2 | moot | Verify runs in the box as the box user, with no host mount (`box/verify.ts:1-6`, `box/apple-args.ts:4-6`). |
| V-3 | moot | Allow-once, park questions and hooks are gone. The worker runs `bypassPermissions` inside its box (`workers/claude-cli/box-plan.ts:72`). |
| V-4 | moot (gate part) | The web gate is gone. The `box.files` secret set is read from the main checkout on the Mac, so the worker cannot empty it (`records/env-secrets.ts:196-216`). Open web is H-5. |
| V-5 | closed | Every `dipo watch` line goes through `cleanText` (`cli/src/daemon-commands.ts:77-85`, `contract/src/clean-text.ts:11-43`). Test: `cli/src/watch-command.test.ts:643`. |
| V-6 | open (much reduced) | `prepareRunTempDir` still has no lstat, uid or realpath check (`run/temp-dirs.ts:122-128`, `platform/paths.ts:376-379`). Its only user is the Mac scan session, which has every tool off and a fresh ULID. See M1-8. |
| N-2 | moot | A box has no socket mount, and its firewall allows only loopback and dipo's proxy ports (`box/firewall.ts:9-12`). |
| N-3 | moot | Each office has one cache, filled in a box and mounted read-only. Nothing writes the global `~/.bun` cache (`box/cache.ts:1-30`). |
| N-4 | closed | The release build downloads Bun and checks a pinned SHA-256, without setup-bun (`.github/workflows/release.yml:142-190`). Test: `scripts/release-path.test.ts:150`. |
| N-5 | closed | `lockFileMaintenance.automerge: false` (`renovate.json:17-21`). |
| N-6 | open (by design) | A gate decided by rule merges on the reviewer's verdict plus the required checks (`merge/stories.ts:8-12`). See M1-6 for a base with no required checks. |
| N-7 | closed | The TUI prompt pane, the output pane and `dipo run --dry` use `cleanText`, which also strips C1 (`tui/src/detail.tsx:122`, `tui/src/output.ts:55-67`, `cli/src/run-command.ts:271`). |
| H-1 | closed | As N-1. |
| H-2 | closed | One list, `protectedKind` (`story-store/protected.ts:47-87`), used by parts, collisions and the pickup gate. |
| H-3 | open (by design, 0005) | No socket auth. `origin` is still a client claim (`contract/src/envelope.ts:33-34`). No box reaches the socket, so only same-uid processes on the Mac can. |
| H-4 | moot | The worker is in a VM with no host mount. |
| H-5 | open (accepted, 0008) | The web proxy lets traffic reach any public address (`box/web-proxy.ts:16-21`). |
| H-6 | closed, small gap | Paths, content and commit subject are scanned for secrets before each commit (`box/parts.ts:1722-1739`). Gap: `.yarnrc.yml` is missing from `SECRET_NAMES` (`context/secrets.ts:11-34`). |
| H-7 | closed | One shared `cleanText` (`contract/src/clean-text.ts`). |
| H-8 | closed (default unchanged) | Stored command bodies are scrubbed for token shapes and credentialed URLs (`ingest/output.ts:54-67`). `storeCommandBodies` is still on by default, as 0007 says. |
| H-9 | moot | There is no post-turn verify on the Mac. Every part is scanned before its commit. |
| H-10 | open (reduced) | tmpRoot is `DIPO_TMP`, else `/tmp` (`daemon/src/foreground.ts:406`). Only the scan session's temp folders live there. |
| H-11 | closed | `.github/CODEOWNERS`. `pr-title.yml` checks out the base SHA. Whether it takes effect depends on the GitHub setting, which I could not see. |
| H-12 | closed | actionlint in CI (`.github/workflows/ci.yml:286-310`). |
| H-13 | closed | `install.sh` stops without `gh` and pins the source ref, the signer workflow and the digest (`install.sh:76-160`). |
| H-14 | closed | `.gitignore` has `.env*`, `*.pem`, `*.key`, `.npmrc` and `.yarnrc*`. |
| H-15 | moot | The Bash hooks are gone, and the box holds no `gh` token. |
| A-1 | closed | Every Backlog, gh and git call has a deadline (`platform/deadline.ts`, `backlog/runner.ts:26-30`, `git/runner.ts:237-241`). |
| A-2 | closed | `nextRunState` is a pure function (`records/lifecycle.ts`). `parks`, `worker_hosts` and `agents` each have one writer module. |
| A-3 | closed, residue | Layering is enforced by the `dipo/engine-layers` lint rule (`.oxlintrc.json:480-486`). The gh adapter is still in `platform/host.ts`. |
| A-4 | closed | Stream drift parks `worker-failed` (`run/control.ts:37-40`). The stream-side gap is closed; M1-1 is a new budget gap outside the stream. |
| A-5 | closed | `createEngine` exists (`create/create-engine.ts`), and the engine barrel is 28 lines. |
| A-6 | closed | The test preload sets the state folders (`bunfig.toml:7`). A rejected override refuses instead of falling through (`platform/paths.ts:124,258,329-338`). DIPO-423 keeps `container` away from tests. |
| A-7 | closed | `pushed_at is null or pushed_at < ended_at` (`records/story-prs.ts:318-328`). The review waits for the push (`run/review-rounds.ts:134`). |
| A-8 | window 1 moot, window 2 open | There are no Mac worktrees any more. A crash between the claim commit and `updateClaim` (`worktree/claim.ts:388-394`) still leaves the branch tip for a human, with a `claim.leftover` notice (`:489-492`). See M1-11. |
| A-9 | closed, residue | Hooks are gone. `no-claude-cli-import` is in `.oxlintrc.json:474-477`. The model aliases `haiku`, `sonnet` and `opus` are still default config values (`config/schema.ts:571-611`). |
| A-10 | closed | Reads run concurrently, at most 32 per connection, with a 90 s deadline (`daemon/src/server.ts:53-58`). |
| A-11 | closed | `contract/src/runtime-layout.ts`. |
| A-12 | closed | `watch` is built on `OfficeStore`. The TUI reads `definition.confirm` (`tui/src/actions.ts:215`). |
| A-13 | moot | The merge slot was dropped (migration 0062). There is one PR poll per office. |
| A-14 | closed | The serialized pickup step ends once the claim row is written (`run/work-run.ts:28-32`). |
| A-15 | closed | The `verify-macos` job (`.github/workflows/ci.yml:179-191`). |
| A-16 | closed | `commands/request-log.ts:36-63`. |
| A-17 | moot | One binary and one version (`reads/hello.ts`). |
| A-18 | closed | `stopWorkers` is wired (`create/drain.ts:6,23`). |
| A-19 | moot | Every hook is removed. |
| A-20 | closed | The fakes moved out of production source. |
| A-21 | `NO_COLOR` closed, god component open | `tui/src/app.tsx` is 1,267 lines with 21 `useState` calls. |
| A-22 | closed | Lazy `import()` (`cli/src/index.ts:302,334`). |
| A-23 | closed | `PACKAGE_IMPORTS` in the custom plugin. Contract purity is still a regex test. |
| A-24 | closed | `dipo/ci-test-guard` (`.oxlintrc.json:699-703`). |

## Findings

### M1-1 [FACT] high: any process in a box can spend the subscription, outside every cap

- **Evidence.**
  - The model proxy has no client admission and no usage accounting. Its own comment says it "does not keep the Mac's own programs out" (`packages/engine/src/box/model-proxy.ts:1-16`, `:205-212`).
  - Every developer and reviewer box gets `ANTHROPIC_BASE_URL` (the proxy) and a placeholder `ANTHROPIC_API_KEY` in its environment (`model-proxy.ts:287-295`, `box/workers.ts:1007-1008`, `:1119-1120`). Its firewall opens the proxy port (`workers.ts:1000-1003`, `:1110-1113`).
  - Caps and spend alerts count only the usage events in Claude Code's own stream (`run/control.ts:1-12`, 0008 section 7).
- **Failure.**
  - A product whose tests use the Anthropic SDK reads `ANTHROPIC_BASE_URL` from the environment. That covers the worker's own test runs and dipo's verify in the box. Such tests reach the model with the maintainer's subscription token, and dipo sees none of it.
  - A prompt-injected worker can loop `curl` against the proxy the same way.
  - The tier's token cap, the daily and monthly spend alerts and the per-story numbers all read low. The plan limit then trips for every office, and running sessions park `worker-failed`. The vision's promise that budgets are enforced does not hold for this path. Arbitrary code also uses a subscription login meant for Claude Code.
- **Smallest fix.**
  - Give each session a random per-run proxy key, passed to Claude Code only, never in the shell environment of the tools. The proxy accepts only live keys.
  - Count the `usage` of each proxied response against that run's caps, so traffic outside the stream is either refused or counted.

### M1-2 [FACT] high (until Bun 1.4.4 merges): a migration can fail silently and is never run again

- **Evidence.**
  - Probe on Bun 1.4.2: in one `db.run` with several statements, a NOT NULL, UNIQUE-index or foreign-key failure in any statement but the last is skipped. The call does not throw, and the later statements run. A syntax error, or an error in the last statement, does throw. A surrounding `db.transaction` does not change this.
  - `SqliteConnection.exec` is `db.run(sql)` (`packages/engine/src/platform/sqlite.ts:299-301`). Every SQL migration step runs through it (`db/migrations.ts:197`). That is migration 1 and every step from 0002 to 0072 except 0061 and 0063.
  - After the step, only `pragma foreign_key_check` runs. Then the step is recorded with its checksum and `user_version` moves (`migrations.ts:199-214`), so a skipped statement is never retried.
  - About 19 test files under `packages/engine/test/db/` seed data with multi-statement `exec`. PR #544's own fixture fix (`41cd5846`) shows that such a seed already failed silently on 1.4.2.
- **Failure.** A table rebuild (create new, insert select, drop old, rename) whose insert hits a constraint on real data drops the rows without error, then drops the old table. The daemon starts as if all is well. The pre-migration backup is the only copy, and nothing says it is needed. On the maintainer's database, steps that ran on 1.4.2 may already have skipped a statement. Nothing could have shown it.
- **Smallest fix.** Merge PR #544 (Bun 1.4.4). Then:
  - Run each migration statement as its own prepared statement, splitting the step's SQL, so any failure throws on any Bun.
  - After the last step, compare the live schema to the schema built from all steps (`sqlite_schema` dump), and refuse to start on a difference.
  - Run the same check once against the maintainer's current database.

### M1-3 [FACT] medium: the event-file reader can spin forever and freeze the daemon

- **Evidence.**
  - Look at `readCompleteLines` (`packages/engine/src/ingest/event-file.ts:48-62`). When the file holds fewer bytes than the `size` stat reported, and those bytes contain no newline, the loop sets `length = size - from`, which it already was. It then loops again with no await.
  - I ran it on a 3-byte file with `size` 100. It did not return in 8 s, and the alarm killed it.
  - The caller stats the file, then reopens it by path (`ingest/ingestor.ts:412-419`).
- **Failure.** If an event file is truncated or replaced between the stat and the read, the daemon's event loop is stuck at full CPU. That stops every office, the socket and keep-awake, until someone kills the daemon. This is the DIPO-422 class on the daemon side. The trigger window is small [RISK], but the impact is total.
- **Smallest fix.** When a read returns fewer bytes than asked (`n === 0` before `length`), return `[]`. The next pass's `#changeOf` then reports the changed file.

### M1-4 [FACT] medium: the engine handles a question differently when a TUI is connected

- **Evidence.**
  - `questionRoute` returns `live` only while a TUI is connected (`packages/engine/src/records/live-question.ts:34-35`). The daemon feeds TUI presence into the engine (`packages/daemon/src/foreground.ts:579`).
  - A live question keeps the worker waiting on stdin, holding the office's single worker place, for up to `timeouts.questionWaitMinutes` (15). That wait is left out of the minute cap (`questions/permissions.ts:9-25`, `run/control.ts:19-24`, `records/caps.ts:26,142`, `config/schema.ts:692`).
- **Failure.**
  - The same report parks at once with no TUI, but waits 15 minutes with a TUI left open overnight. In that time no other story starts in the office, and the box keeps running.
  - The difference also breaks 0001 principle 3 ("The engine never changes its behaviour based on which client is connected"). It breaks 0020 section 4 too, which says a question parks at once now. Its Replaced list removed "a question wait that depended on a TUI being connected".
- **Smallest fix.** Delete the live route, `TuiPresence` and `questionWaitMinutes`, and park at once, as 0020 says. If the maintainer wants the wait, rewrite 0020 and 0001 first.

### M1-5 [FACT] medium: no automated test exercises the loop against GitHub or a real box

- **Evidence.**
  - Every `gh` test injects a scripted `Spawn` (`test/platform/host.test.ts`). The end-to-end loop test uses an in-memory code host (`test/engine/review-loop.ci.test.ts`, `loop-host.ts`).
  - Box tests (`*.box.test.ts`) run only with `DIPO_TEST_BOX=1`, by hand, never in CI.
  - So the merge gate, auto-merge, `gh pr checks` parsing, CI log fetch, the reviewer box and the test box are proven on the real path only by hand runs: the cutover gate DIPO-351/366 and today's hand test.
- **Failure.** A `gh` output change, a GitHub API change or a new Apple `container` version breaks the unattended loop. The first sign is a stuck or wrongly parked overnight run.
- **Smallest fix.**
  - Add one opt-in scheduled job, or a documented hand script, that runs one tier-S story end to end against a scratch GitHub repository and a real box.
  - Add a freshness check for the recorded `gh` outputs, like the Claude recordings.

### M1-6 [RISK] medium: with no required checks, a gate decided by rule merges with no CI at all

- **Evidence.** `requiredCheckNames` returns an empty list when the base requires none (`packages/engine/src/platform/host.ts:111,143`). I found no refusal for that case. A gate decided by rule then enables auto-merge (`merge/stories.ts:8-12`), and GitHub merges a PR with no requirements at once.
- **Failure.** In an office whose base has no branch protection, a story merges on the reviewer's verdict alone. 0002 calls CI "the final gate", and here the gate does not exist.
- **Smallest fix.** Treat an empty required-check list as a reason the gate waits for the maintainer. Also show a notice at office load.

### M1-7 [FACT] low: the Backlog CLI loads Bun configuration from the folder it runs in

Open, low: M1-7 (the Backlog CLI loads Bun configuration from the folder it runs in; reachable only through a file merged into an office's base), risk accepted by the maintainer on 2026-11-03.

### M1-8 [FACT] low: `prepareRunTempDir` follows a planted symlink (V-6 residue)

- **Evidence.** `packages/engine/src/run/temp-dirs.ts:122-128` with `platform/paths.ts:376-379`. Its sibling `prepareShortTempDir` (`temp-dirs.ts:136-161`) has the checks. The default root is `/tmp` (`daemon/src/foreground.ts:406`).
- **Failure.** A second local user plants `/tmp/dipo-run-<id>` pointing at a folder the maintainer owns. The folder gets chmodded to 0700 and gains an owner file. Only the scan session uses this, and its id is fresh.
- **Smallest fix.** Reuse the lstat, not-a-link and uid checks of `prepareShortTempDir`.

### M1-9 [FACT] low: two more sweeps not scoped to their own state folder

These are the same class as DIPO-419 and DIPO-423.

- **Evidence.**
  - `sweepBranchReads` removes every `_branch-read-*` folder under the repository's worktree root that is older than this daemon's start (`packages/engine/src/worktree/sweep.ts:43-66`). The root is per repository, not per state folder (`config/schema.ts:683`).
  - The `dipo-out-*` sweep checks only uid and age (`platform/output-files.ts:157-182`), in a temp root that every daemon on the Mac shares.
- **Failure.** Two daemons open the same repository, for example a second state folder in a test or a hand check. One removes the other's in-progress branch read, and that read fails.
- **Smallest fix.** Write an owner file (the state-folder hash, as `run/temp-dirs.ts:13-16` does), and sweep only matching folders.

### M1-10 [RISK] low: client reload loop with no backoff

- **Evidence.** On `stream.resetRequired`, the office store reloads and resubscribes at once (`packages/client/src/store/office-store.ts:592-600`, `:643-654`). There is no backoff or cap.
- **Failure.** If the daemon keeps answering `resetRequired`, for example because of a cursor bug, the TUI loops on round trips at full speed. That is the DIPO-422 class on the client side. I did not show that this loop can be reached.
- **Smallest fix.** Use the existing retry backoff (`#scheduleRetry`) for a second reset within a short window.

### M1-11 [FACT] low: one crash window in the claim still needs a human (A-8 residue)

- **Evidence.** `packages/engine/src/worktree/claim.ts:388-394`, `:489-492`, `:543-555`.
- **Failure.** The daemon dies between the claim commit and `updateClaim`. The branch keeps the claim commit, and the story is held out until the maintainer clears it.
- **Smallest fix.** Treat a tip whose only commit past `startSha` is dipo's own claim commit as made by this claim, and reset it.

### M1-12 [FACT] low: code comments break 0003's citation rules and have gone stale

- **Evidence.**
  - Code cites ADR sections 1,116 times (pattern `0NNN section N`). It cites the merged ADRs 0006, 0011, 0015, 0019 and 0021 536 times, and "amendment of" 65 times. 0003 rules 4 and 5 forbid all three.
  - Stale comments:
    - `run/fix-rounds.ts:6-7` says `gate.reject` does not exist yet; it is wired.
    - `run-state/places.ts:16` names "the merge slot".
    - `run/review-boxes.ts:3` names a test file that does not exist.
- **Failure.** Readers and agents follow dead references into merged ADRs. Each ADR rewrite leaves more of them.
- **Smallest fix.** A lint rule that refuses `0NNN section` and the merged ADR numbers in comments, plus one mechanical sweep.

### M1-13 [FACT] low: small secret-scan gaps

- **Evidence.**
  - `.yarnrc.yml`, which can hold `npmAuthToken`, is missing from `SECRET_NAMES` (`packages/engine/src/context/secrets.ts:11-34`).
  - Stored tool lines are scrubbed by pattern only, not against `box.files` values (`ingest/output.ts:54-67`). Web-call lines are checked against those values (`run/web-calls.ts:112-124`).
- **Failure.** A Yarn token that matches no content pattern is committed and pushed.
- **Smallest fix.** Add `.yarnrc.yml` to the list.

### M1-14 [FACT] low: `App` is still a god component (A-21 residue)

- **Evidence.** `packages/tui/src/app.tsx` is 1,267 lines with 21 `useState` calls.
- **Failure.** Each M2 view adds to one key handler.
- **Smallest fix.** Split it into one component per mode, with a mode reducer.

**Count:** 2 high, 4 medium, 8 low.

## M1 promises

| Promise | Status | Evidence |
|---|---|---|
| The engine opens the story PR: finds it before creating it, title and body from facts, review comment redacted | delivered | `story-pr/prs.ts:740-759`, `story-pr/title.ts:51`, `story-pr/body.ts:237`, `review/comment.ts:148`. Tests: `test/story-pr/*.test.ts`, `review-loop.ci.test.ts` (real git, in-memory host; I ran it, 12 pass). Not proven against GitHub (M1-5) |
| Reviewer session in a read-only box | delivered | `git archive` copy, no `box.files` (`box/review-box.ts:1-16,142`). Tools Read, Glob, Grep and web only (`workers/claude-cli/tools.ts:20`). Own caps (`config/schema.ts:596-604`). Verdict by code (`review/verdict.ts:47`). Round cap parks `review-blocked` (`run/reviews.ts:566-584`). Crash handling (`:774-800`). Real box only in an opt-in test. The box gets the shared model proxy (M1-1) |
| One feedback path: review, red verify, red CI, conflict, reject, test fail | delivered | `run/feedback.ts:133`, `run/fix-rounds.ts` (one round per head, send once). Caps: loops parks `verify-failing` (`run/verify-commit.ts:443-455`), CI attempts 2 (`story-pr/prs.ts:1103-1124`), review rounds 3, conflict hand-offs 2 (`run/conflicts.ts:1058`) |
| Verify in the box with a deadline | delivered | `box/verify.ts:232,502`, `box/workers.ts:1536-1551`, 20 min by default |
| Conflicts: `git merge-tree`, hand-off with markers, protected paths park | delivered | `box/collisions.ts:866`, `run/conflicts.ts:24-48`, `box/collisions.ts:1583-1595`. Tests on real git (`conflicts.ci.test.ts`) |
| Merge gate, by rule or waiting for the maintainer, then auto-merge | delivered | `run-state/gates.ts:118-133` (all eight wait reasons, `autorelease: pending` at `:67`, `merge/adr-path.ts`). `merge/stories.ts` handles close-out, `--auto --squash --match-head-commit` and auto-merge off on red, conflict, hold or a foreign head. The one Done check is in `worktree/done-check.ts:51`. Gap for a base with no checks (M1-6) |
| Park with eight reasons, one resume path, starts paused | delivered | `contract/src/work.ts:48-56`, `run/park.ts:486`, `run/park-resume.ts:474`, `records/resume-policy.ts`, `run/starts-paused.ts`. Tests with real git and the real CLI (`park.ci.test.ts`, `starts-paused.ci.test.ts`) |
| Commands park, resume, drop, discard, steer, answer, approve, reject | delivered | Contract `contract/src/office.ts:87-238`, CLI `cli/src/index.ts:410-446`. Answer handling drifts from its ADR (M1-4) |
| `dipo desk` with a notification | delivered | `overview/desk.ts`, `overview/desk-notify.ts`, wired at `create/create-engine.ts:91`, posted by `osascript` (`platform/notify.ts`) |
| M1b: triage view in the TUI | delivered | `tui/src/desk.tsx` ("Your desk", key 3). Tested with a fake session only |
| M1b: `dipo test` in a test box | delivered | `run/tests.ts`, `box/test-box.ts`. Real box only in an opt-in test. DIPO-419 and DIPO-420 fixed today |
| M1b: scan AI fallback and confirm | delivered | `scan/fallback.ts`, `scan/confirm-command.ts`. No test reaches a model (scripted runner) |
| M1b: daily and monthly spend alerts | partly | `run/usage-alerts.ts`, test `test/views/usage.test.ts:205-256`. They count only stream usage, so proxy use outside the stream escapes them (M1-1) |

The backlog: 275 `m-1` stories, all Done. Eight earlier m1a stories sit archived at Refined (DIPO-151, 156, 157, 162, 165, 167, 168, 169). The behaviour of 151, 156, 157, 162 and 167 appears to have landed under other ids. 165 (extra write paths) and 169 (worker research access) were made moot by the box.

## Risks for M2

These are risks in today's code, not a design.

1. **Unmetered shared model proxy.** N boxes share one proxy that has no per-run admission or accounting (M1-1). With parallel runs, nobody can tell which box spent what, and one box can drain the plan limit for all.
2. **One worker place per office.** `work.run` refuses `maxAgents > 1` "until M2" (`run/work-run.ts:357-362`). Places are one worker and one reviewer per office (`run-state/places.ts:1-4,146-186`). The pickup reservation lives in memory and holds one pickup (`places.ts:304-308`). With several developers, the single reviewer place becomes the queue.
3. **The office git queue serializes everything.** Every claim, part commit, push, fetch and lane flush of an office is one queue (`git/office.ts:101,141-149`), with steps capped at 60 or 120 s (`git/runner.ts:235-241`). One slow push delays every story's next part.
4. **The PR poll is serial per office and skips overlapping rounds** (`story-pr/pr-state.ts:1-19`, `story-pr/prs.ts:1290-1294`). With many PRs, a round can outlast `prStateSeconds`. Rounds are then skipped, and merge or CI reactions slow down. `gh` rate use grows with the number of PRs, plus a log fetch for each red check.
5. **One web route and one Safe-Chain box per daemon,** with 512 connections in total and 128 per box (`box/web-proxy.ts:95-102`, `box/workers.ts:538-548`). Parallel installs compete for it.
6. **Box finishing is serial:** every `finishEnded` pass chains on one promise and waits per run (`box/workers.ts:1683-1729`).
7. **One SQLite connection with synchronous writes on the event loop** (`platform/sqlite.ts:35,302`). N live streams plus flushes every 250 ms all block the loop. M1-3 shows that one stuck synchronous call freezes everything.
8. **No CPU, memory or disk limit per box** (0008). N VMs on one Mac can exhaust memory. Nothing caps the number of boxes by host resources.
9. **Merge order.** "Require branches up to date" is off and there is no merge queue. Two PRs that each pass can merge into a main that fails. Only the second one to hit a textual conflict gets a hand-off (0002, 0008).
10. **Shared resources across daemons.** The network name `dipo-boxes` is fixed (`box/apple-args.ts:49`), and image tags are shared by content hash (`box/build-box.ts:323` deletes and re-commits a tag). A second state folder on the same Mac shares both.
11. **Office-wide pauses.** One token hold file per state folder pauses every office (`box/token-hold.ts`, `run/starts-paused.ts:17-24`). A plan limit parks every running session `worker-failed` at once, and with N sessions that is N parks.
12. **The question wait holds the worker place** while a TUI is connected (M1-4). With parallel runs, that blocks one of N places instead of the only one, but still for 15 minutes each time.

## ADR drift

| Sentence | ADR | What the code does |
|---|---|---|
| "The engine never changes its behaviour based on which client is connected." | 0001 (principle 3) | A worker's question waits up to 15 min live while a TUI is connected, and parks at once otherwise (`records/live-question.ts:34-35`, `daemon/src/foreground.ts:579`). |
| "Now: the story parks `ambiguous-spec` at once." The Replaced list also removes "a question wait that depended on a TUI being connected". | 0020 (section 4) | The same live wait, with `timeouts.questionWaitMinutes` and a minute cap that leaves the wait out (`questions/permissions.ts:9-25`, `records/caps.ts:26`). |
| "The engine checks the totals after every usage and turn event and stops the session at 100% of a cap." | 0008 (section 8) | True only for usage in Claude Code's stream. Model calls by any other process in the box go through the same proxy and are never counted (M1-1). |
| "CI is the final gate. The required checks must pass on the head that merges." | 0002 (section 4) | A base with no required checks gets auto-merge with nothing to wait for (M1-6). |
| "Each step runs in its own transaction." "A failed step rolls back." | 0007 (section 10) | On Bun 1.4.2, a statement that fails at run time inside a step does not fail the step. The step is recorded as applied (M1-2). |
| "Code cites ADRs by number only, never by section." "There is no amendment log." | 0003 (rules 4, 5) | 1,116 section citations, 536 citations of merged ADR numbers and 65 "amendment of" citations in package code. |
| "A claim is a branch, and a story has no Mac worktree." | 0010 | True for new claims. The code still keeps `worktree.root` and `worktree.rebuildable`, including `.claude/.cc-writes/` (`config/schema.ts:683-686`), and a leftover-worktree sweep with desk rows (`worktree/leftovers.ts`) for earlier binaries. No ADR states the sweep. |
| Code with no ADR | none | A live question route and `TuiPresence` (`create/notify.ts:23-45`). An unscoped `_branch-read-*` sweep (`worktree/sweep.ts`). Neither is in any ADR. |
