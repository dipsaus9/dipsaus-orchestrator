# Audit of the security and architecture reviews of 2026-10-21

Status: historical review. The current status of every finding is in `milestone-review-2026-11-02.md` (section A.0, the earlier-findings table).

Audit of `security-audit-2026-10-21.md` and `architecture-review-2026-10-21.md`, both at `main` `992a78f7`.

**Method**
- Four independent verifiers checked each claim against the code, read-only.
- One verifier ran live tests, limited to a throwaway Backlog.md project under `/private/tmp`. They wrote only harmless marker files.
- The N-1 result was then re-run by hand.

**Verdicts:** CONFIRMED, PARTLY (the claim needs a correction) or WRONG.

## 1. Headline

Both reviews hold up. No finding is wrong. Several are understated, and two need a different fix from the one proposed.

N-1 (the Backlog CLI ran unsandboxed in a worker-writable folder) was confirmed live and rated the worst finding; it is closed since M1 (see `milestone-review-2026-11-02.md`, A.0). Residue: open, low: M1-7, risk accepted by the maintainer on 2026-11-03.

## 2. Security review: verdict per finding

| ID | Verdict | Severity (review → audit) | Correction or addition |
|---|---|---|---|
| V-1 Backlog `on_status_change` | CONFIRMED live | High → High (Critical arguable) | (a) A root `backlog.config.yml` overrides `backlog/config.yml`. It is outside the worker deny list and the backstop, so the worker can write it directly, with no verify trick. `.backlog/` and `config.yaml` are also read. (b) Parks run `task edit --status Parked` in the worktree too (`run/park.ts:174`), so the proposed "re-run backstop, then park scope-violation" fires the callback itself. (c) A hook in task frontmatter is committed, pushed and fires again on re-claim (`claim.ts:521`) and, after merge, in the `_backlog` lane (`lane/ops.ts:102`). Backlog.md has no switch to turn callbacks off. The runner line is `runner.ts:296`, not `:147`. |
| N-1 Bun configuration loaded by the Backlog CLI | CONFIRMED live | "needs investigation" → **High, worst finding** | See section 1. A neutral cwd plus a minimal env fixes N-1 but not V-1. |
| V-2 Post-turn verify has no read fence | CONFIRMED | High → High | Truncating the feedback to 3,000 characters protects nothing: verify can write the secret into a worktree file and the next turn reads it whole. The worker's own protection of `~/.config/gcloud` and similar rests only on Claude Code's `blockReadsOutsideWorkingDirectories`. dipo writes no home-wide `denyRead` (`plan.ts:518-537`). Setup's install and setup steps have no fence either (`setup.ts:416`). |
| V-3 Allow-once for writes outside the worktree | CONFIRMED | Medium → Medium (high end) | Also missed: the **live** permission question (`permissions.ask: when-present`) lets a write outside the worktree through on `allow`. It shows the path, never the content. The false sentence "cannot lift a sandbox block" is also in ADR 0008 line 208. The architecture doc `flows/sandbox.md` §5 repeats it. Worth a live check: does `Edit(//<workdir>/**)` match a symlink in the worktree that points outside it? |
| V-4 Web gate secret set | PARTLY | Medium → Medium (gate part Low) | `cat .env` *is* denied: the Read rule covers recognised Bash file commands. A script still reads the file. More important: the gate matches only raw and percent-encoded values, so base64, hex or a split value passes without emptying any file. The gate is a guard against accidental leaks only. The open-domain part is already **DIPO-169**. |
| V-5 `dipo watch` prints escape codes | CONFIRMED | Medium → Medium | Also missed: `inputSummary` cuts at 200 characters, and a live `allow` approves the full call. A command padded past 199 characters hides its tail in the TUI too. |
| V-6 Run temp dir follows a planted symlink | CONFIRMED | Low → Low (needs a second OS user), bigger impact | srt resolves `allowWrite` paths. A `/tmp/dipo-run-<id>` symlink to `$HOME` becomes a write grant on the whole home. `plan.ts` passes `TMPDIR` through; it does not set it. The realpath check belongs in `prepareRunTempDir`, not in the pure `plan()`. |
| N-2 Socket symlink | PARTLY | 3–4 → keep listed | The code facts are right. Whether Seatbelt checks the raw path or the resolved path needs the live test. Impact if it connects: High. |
| N-3 Install writes the global bun cache | CONFIRMED | accepted risk | Accepted in the ADR 0008 amendment of 2026-10-12. |
| H-1 Backlog CLI unsandboxed | CONFIRMED | M → **root cause of V-1 and N-1** | |
| H-2 Two protected-path lists | CONFIRMED | | Neither list has `.mcp.json`, `backlog.config.yml`, `.backlog/`, or Bun configuration and environment files. |
| H-3 No socket auth | CONFIRMED, by design | | Fix item 7 is flawed: a peer-uid check does nothing, because the worker runs as the same uid. The engine token cannot gate `hook`. Only a secret the sandbox cannot read helps. |
| H-4 No worker denyRead of dipo dirs | CONFIRMED | Low | The macOS runtime dir is `$TMPDIR/dipo`, outside home, so the home deny may not cover it. |
| H-5 No web allowlist | CONFIRMED | accepted risk | Tracked as DIPO-169. |
| H-6 Secret-name list | CONFIRMED | Medium | The content scan before push belongs in `verify-commit.ts` / `story-git.ts`, not in `context/secrets.ts` (that module only feeds prompts). |
| H-8 `storeCommandBodies` default | CONFIRMED | Low | The header of `ingest/output.ts` is stale. |
| H-9 Backstop only before verify | CONFIRMED | | Re-running the backstop is not enough while parks call the CLI in the worktree. |
| H-10 tmpRoot in `/tmp` | CONFIRMED | Low | The step files themselves are safe (`mkdtemp`, `wx`). |

**Also found by the audit**
- The default `toolchainReadPaths` opens all of `~/.cache`.
- ADR 0008:156 ("the value cannot leave the machine except through the model API") is stale since the web tools.
- The worker's Bash credential boundary (layer A) is not probed live. `safety-gh-token` and `credential-check.ts` prove dipo's *own* srt step policy (layer B), not Claude Code's sandbox (`flows/sandbox.md` §10).

## 3. Architecture review: verdict per finding

| ID | Verdict | Correction |
|---|---|---|
| A-1 No subprocess timeouts | CONFIRMED, High | Git is bounded more widely than stated (`build-commit.ts` caps every step at 10 s). Plain local git steps elsewhere still have none. |
| A-4 Budget fails open on stream drift | PARTLY, Medium-High | Usage does not read zero for good: each turn's result `modelUsage` replaces the live numbers. The real gap is mid-turn blindness. The minutes cap is independent of the stream. `interpretLogged` exists but production does not use it. |
| A-7 Unpushed In Review story | CONFIRMED, Medium | The proposed fix uses the wrong condition. After the claim push `pushed_at` is not null, so the condition must be `pushed_at is null or pushed_at < ended_at`. `park.ts:197,271` also push without updating `pushed_at`. |
| A-2 No run state machine | CONFIRMED, High | The three "end agent" copies have already drifted: step order, `finalizeAgentUsage`, and whether `worker_hosts` is ended. `agents` has 8 writers, not 7. |
| A-3 Engine layering | CONFIRMED | The cycle is at directory level, not file level. |
| A-6 Test isolation | CONFIRMED, **High for the test env** | Missed: a rejected `DIPO_RUNTIME_DIR` (for example over 100 bytes) silently falls through to the live daemon's `$TMPDIR/dipo`. This is the mechanism behind an earlier incident in which a test run with a long `DIPO_TMP` deleted the live daemon's socket. A rejected override must refuse, not fall through. |
| A-13 Merge slot in memory | CONFIRMED, Medium | |
| A-15 No macOS test lane | CONFIRMED, Medium | CI already uses `macos-26`, not `macos-15`. |
| A-18 `stopWorkers` | CONFIRMED, Low | |
| A-24 CI guard | CONFIRMED, Low | |
| §4.2 Only `"review"` rounds start | CONFIRMED | |

## 4. How the findings relate to an isolated-worker design

The maintainer proposes a whole worker in its own isolated environment, free inside it. Read against that design, the findings fall into four groups.

**Disappear** (the cause is that only Bash is sandboxed, and the host is shared):
- V-2: verify would run inside the worker's environment.
- V-3: the file tools would be inside the box too.
- V-6, H-10: temp dirs would be inside the box.
- N-2: no host socket reachable, if the hook channel is designed for it.
- The whole gh-guard and temp-guard line: DIPO-195, 241, 242, 243, 261 and 262.

**Remain whatever the sandbox** (the engine handles worker output on the host):
- **V-1, N-1, H-1, H-9.** The principle these break: the engine never runs a tool in, or reads config from, a directory the worker can write, outside a sandbox. This needed fixing first.
- V-4 / H-5: depend on the box's egress policy.
- V-5: a UI concern.
- H-6, H-8: secrets in data.

**Orthogonal:**
- A-1, A-4, A-7, A-2, A-6, A-13.
- A-6's fall-through is the most urgent of these for day-to-day safety.

**Becomes a design point:**
- The hook relay. Hooks run inside the worker's box and must reach the engine without exposing `dipo.sock` (N-2, H-3).
