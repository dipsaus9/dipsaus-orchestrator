---
id: DIPO-15
title: Write the M0 implementation stories
status: To Do
assignee: []
created_date: '2026-10-11 18:43'
updated_date: '2026-10-12 09:52'
labels: []
milestone: m-0
dependencies: []
priority: high
type: docs
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every M0 implementation story exists in Backlog.md in milestone m-0, written from the accepted ADRs to the story standard, with dependencies, so M0 can be built and cut over.

Context: docs/plan.md step 2 (M0 implementation stories). Stories follow ADR 0012 (story standard and Ready gate) with the field storage of ADR 0010 section 3 (labels and the dipo field block). Sources are ADRs 0001 to 0017. Decisions the maintainer took on the breakdown (D1 to D9, 2026-10-11) are recorded as dated amendment lines in the affected ADRs. The M0 review decisions D11 to D16 (2026-10-12) and the story fixes from the buildability and tech reviews are in the notes; the ADR changes among them are 2026-10-12 amendment lines.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 All M0 stories exist in milestone m-0 following ADR 0012, with dependencies between them
- [x] #2 Decisions that change an ADR (D2, D4–D8 and D10) are recorded as dated amendment lines in 0003, 0004, 0010 and 0013; D1, D3 and D9 need no ADR change and are recorded in this story's notes.
- [ ] #3 A separate reviewer agent checked the stories and amendments and its findings are fixed
- [ ] #4 Maintainer approved the M0 stories
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Created 52 M0 stories, DIPO-16 to DIPO-67, in milestone m-0 with the Backlog CLI. Each follows ADR 0012 with ADR 0010 storage: Outcome line, context with ADR references, dipo field block (branch, unknowns, test_plan), tier label, scope as references, referenced ADRs as documentation, dependencies. Status stays To Do; the maintainer sets Ready. The test-before-merge label is not set anywhere.

Draft numbers to ids: S01 to S19 are DIPO-16 to DIPO-34; S19b is DIPO-35; S20 to S51 are DIPO-36 to DIPO-67. The draft number is in each story's notes.

Decisions on the breakdown (maintainer, 2026-10-11):
- D1: M0 delivery ends at In Review with the story branch pushed; the story PR and reviewer stay manual until M1 (DIPO-49).
- D2: caps (token budget, turns, time) and parks with a reason are in M0; the triage view and resume of parked stories stay M1 (DIPO-50, DIPO-51).
- D3: the maintainer sets Ready with the Backlog CLI; M0 adds read-only dipo gate <id>, and run refuses a story that fails the gate (DIPO-30, DIPO-48).
- D4: in M0 the engine opens the backlog-lane PR and auto-merges it after its structural check, as 0010 decided. New story DIPO-35 (S19b) split out of the backlog lane story DIPO-34; office init DIPO-36 depends on it.
- D5: private packages/testkit, devDependency only (DIPO-18).
- D6: cutover after DIPO-55; dipo delivers DIPO-56 to DIPO-67 (label after-cutover); v0.1.0 after DIPO-66 lands and the maintainer's live smoke run passes.
- D7: draft promotion moves to M3.
- D8: M0 scan is code only; run refuses an office whose verify is unresolved with a message naming the script to add; AI fallback and confirm command are M1 (DIPO-33).
- D9: office init does not write .dipo/office.yaml; built-in 0008 defaults apply; init still writes .dipo/.gitignore (DIPO-36).

Amendment lines dated 2026-10-11 added to ADRs 0003, 0004, 0010 and 0013. docs/plan.md step 4 names the cutover point.

Open unknown kept on purpose: DIPO-42 has one open unknown (report channel per turn) that the DIPO-41 live check answers; it blocks Ready until then.

Suggested test-before-merge (not set; maintainer decides): DIPO-23, DIPO-25, DIPO-27, DIPO-35, DIPO-36, DIPO-37, DIPO-41, DIPO-43, DIPO-48, DIPO-49, DIPO-50, DIPO-53, DIPO-54, DIPO-55, DIPO-57, DIPO-59, DIPO-63.

Review fixes (PR #16): cutover needs DIPO-16 to DIPO-55 Done; DIPO-55 now also depends on DIPO-49 (verify and commit) and DIPO-51 (worker outcomes) so the end-to-end loop is in place before cutover. ADR 0016 needed no amendment for D6: cutting v0.1.0 after DIPO-66 and the live smoke run is stricter than, and consistent with, 0016's 'v0.1.0 when the skeleton delivers a story end to end'. The Clock and IdSource interfaces live in packages/contract (DIPO-18). DIPO-66's one-time maintainer steps go into docs/release.md. DIPO-50 parks needs-permission for calls denied by the launch plan until DIPO-59 adds the PermissionRequest hook.

D10 (maintainer, 2026-10-12): DIPO-59's allow-once flow with work.answer and dipo answer stays in M0 as an explicit exception to D2. It resumes only a story parked needs-permission; every other resume of a parked story stays M1. Recorded as a 2026-10-12 amendment line in 0003. DIPO-50's context and DIPO-59's ACs, dependencies (now also DIPO-50) and test plan were aligned with 0008 sections 5 and 8 and the 0005 work.answer decision amendment.

Test-before-merge (maintainer, 2026-10-12): DIPO-25, DIPO-35, DIPO-37, DIPO-49, DIPO-53 and DIPO-55 carry the test-before-merge label. Each has at least one manual test entry with steps and an expected result (0012 R20, R21); the manual steps of DIPO-35, DIPO-49 and DIPO-55 were made concrete. The other stories in the earlier suggestion list stay unflagged.

M0 review decisions (maintainer, 2026-10-12). Each one that changes an ADR is a 2026-10-12 amendment line attributed "M0 review (maintainer)".
- D11, technical corrections approved as one package:
  - Sandbox execution: `srt` (pinned 0.0.79) is a Node CLI whose library form is a process-wide singleton with the network proxy in the wrapping process; dipo bundles it and runs each step through the hidden `runDaemon` form `dipo daemon sandbox-exec --policy <file> -- <cmd>`, one process per step; `rg` is probed on macOS and Linux (0004, 0006, 0008; DIPO-37, DIPO-17).
  - `Tier`, `ParkReason` and `SkipReason` are open enums with known values; the engine validates tiers against the office tier set; `Lifecycle` stays closed (0005; DIPO-20, DIPO-30).
  - `office.init` and `office.purge` (`confirm`, `irreversible`) are contract commands; `restore`, `daemon install` and `daemon logs` are named offline maintenance (0005, 0006; DIPO-19, DIPO-20, DIPO-36, DIPO-76).
  - A command defined but not built is provisional until it ships with a `since`; renaming it is not major (0005 section 11; DIPO-19, DIPO-20).
  - `commands.describe` also describes reads (0005 minor; DIPO-19, DIPO-24).
  - Client split: runtime-free core plus `OfficeStore`, lint-enforced; `client/node` holds the Unix transport and `lifecycle` (0004, 0006; DIPO-25, DIPO-53, DIPO-70).
  - Software-level config in `<state>/config.yaml` (`daemon.autostart`, `daemon.autoRestartOnUpgrade`, later `web.enabled`), zod-validated and versioned (0006, 0017; new home story DIPO-69).
  - Every added config key bumps the file's `version` (0017; DIPO-26, DIPO-69).
  - `run_outcomes`, one permanent row per ended run (0007; DIPO-49).
  - `dipo hook` is a `runDaemon` form with a versioned handshake (0004, 0006; DIPO-59).
  - 0008 section 10 fixed to match 0007: forget keeps everything, only purge removes `<git-common-dir>/dipo/`.
  - Claude hook formats and `additionalContext` are mapped in the adapter; neutral `nudge` op in `encode`; `engine/src/hooks` adapter-neutral; tier models per adapter is a later note (0008; DIPO-59, DIPO-60).
  - Backlog CLI stays 1.53.x, excluded from Renovate automerge (0016; DIPO-67); DIPO-28's refusal names `bun add -g backlog.md@1.53.0`; DIPO-16 lists the global prerequisite.
- D12, model sessions outside story runs: second adapter run kind `session` (no worktree or branch) for the M1 scan fallback, M3 interviews and M5 conversation. M0 builds only the space: `WorkerSpec.kind` open string (DIPO-40), `runs.kind` `story | session` and nullable `runs.key` (DIPO-48), usage outside stories recorded under the office (0007, 0008).
- D13, everything stays in M0: pricing (DIPO-62), nudges (DIPO-60), restore and purge (DIPO-76), autostart (DIPO-63); too-big stories are split instead (0003).
- D14, reconcile (DIPO-56) and re-attach (DIPO-57) move before cutover; `after-cutover` label removed, priority high. Cutover needs DIPO-16 to DIPO-57 Done plus the pre-cutover splits DIPO-68 to DIPO-74 (0003 amendment, docs/plan.md). The dependency on them is carried by the cutover note, not by an extra dependency of DIPO-55.
- D15, Backlog CLI: covered by D11; the maintainer's machine runs 1.53.0.
- D16, the technical corrections package is D11 above.

M0 review story fixes (buildability and tech reviews, no decision needed):
- Splits, old to new: DIPO-23 -> DIPO-23 (lock, runtime dir, logs, PID identity, prototype) + DIPO-68 (lifecycle states, drain, safe mode); DIPO-25 -> DIPO-25 (client core, `client/node` transport) + DIPO-70 (daemon lifecycle CLI, autostart, tool paths); DIPO-30 -> DIPO-30 (pure `evaluateGate`) + DIPO-71 (decision storage, `story.gate`, `dipo gate`); DIPO-33 -> DIPO-33 (pure detection) + DIPO-72 (stored profiles, rescan, `verifyResolved`); DIPO-35 -> DIPO-35 (open and check the backlog PR) + DIPO-73 (merge slot); DIPO-48 -> DIPO-48 (pick, refusals, re-check, claim) + DIPO-74 (setup, launch checks, prompt, host, ingestion wiring); DIPO-59 -> DIPO-59 (hook relay, presence ask, `questions`, `dipo answer`) + DIPO-75 (needs-permission answer and resume); DIPO-65 -> DIPO-65 (retention, backups, `dipo stats`) + DIPO-76 (restore, purge). New home story: DIPO-69 (software-level config).
- Registration seam: DIPO-22 (commands and reads, `register(registry)` listed in `packages/engine/src/features.ts`) and DIPO-27 (office load steps); DIPO-28 now depends on DIPO-27.
- Predicates instead of untestable ACs: `configBlocksRuns` (DIPO-27), `pendingLaneOp` (DIPO-34), `backlogCheckBlocked` (DIPO-35), `officeStatusesReady` (DIPO-36), `adapterHeld` (DIPO-43), `prompt.contractTooLarge` (DIPO-47), `verifyResolved` (DIPO-72), all consumed by DIPO-48; `ingest.fileChanged` (DIPO-45) parked by DIPO-57.
- Story views: minimal `deriveStoryView` and `OfficeSummary` in DIPO-32, extended by DIPO-52.
- The adapter hold is owned by DIPO-43; DIPO-51 reuses it.
- Retiered: DIPO-17 S to M (self-check), DIPO-37 M to L (sandbox-exec form, smoke step, self-verify test).
- DIPO-42's open unknown is resolved through the Backlog CLI when DIPO-41 lands.
- Test-before-merge now also on DIPO-70 and DIPO-73 (carried over from the split DIPO-25 and DIPO-35), DIPO-59 and DIPO-75 (live recordings are maintainer steps).

Decisions taken during the fix-up that the maintainer may want to revisit:
- DIPO-17's self-check only initialises the bundled `srt` library; the real `dipo daemon sandbox-exec` run joins the four smoke jobs in DIPO-37, which builds the form.
- `maxMinutes` counts wall-clock time including sleep, rechecked on a 1-minute tick (DIPO-50).
- An adapter hold is lifted when an explicit `work.run` repeats the launch checks and they pass (DIPO-43).
- Free-disk floor is a 2 GB constant, checked before the claim (DIPO-38) and before install (DIPO-39).
- `dipo stats` reads a new contract read `office.stats` (DIPO-65); `restore` is a `runDaemon` form (DIPO-76).
- New office config key names fixed in DIPO-26: `story.*` thresholds, `sandbox.*`, `polling.prStateSeconds` (60), `polling.fetchSeconds` (300), `timeouts.scriptMinutes.*`, `retention.shortDays`, `retention.stateDays`.
- Each sandboxed step gets a short temp root passed as `TMPDIR` and `DIPO_TMP`; testkit creates its directories under `DIPO_TMP` when set (DIPO-18, DIPO-37).
- `web.enabled` is not in version 1 of `config.yaml`; it joins with the browser listener and bumps the version.

Final review round (2026-10-12):
- D17 (maintainer, 2026-10-12): no automatic NDJSON fallback. If the `ws+unix://` prototype fails in the compiled binary, work on DIPO-23, DIPO-24 and DIPO-25 stops (the story parks or is blocked) and the maintainer chooses the transport. ADR 0006 is unchanged; no amendment.
- Cutover gate: DIPO-37's self-verify check (this repository's verify inside the sandbox) is re-run green before cutover (docs/plan.md step 4).
- Accepted gap until DIPO-61: a run held by a plan limit has no M0 way out except `work.stop`, which parks it `stopped`.
- Scope fixes: package entry files (`packages/engine/src/index.ts`, `packages/tui/src/index.ts`, `packages/testkit/src/index.ts`, `packages/client/src/index.ts`, `packages/client/src/node/index.ts`) added where a story adds a public export; `packages/contract/` replaces contract file paths in DIPO-18, 61, 63, 65, 69, 71, 76; DIPO-69 also scopes `packages/daemon/src/`; DIPO-63 scopes `packages/daemon/src/` and implements `wait-pid`.
- Dependencies: DIPO-57 on DIPO-51; DIPO-59 on DIPO-52.
- DIPO-43 flagged test-before-merge (live safety captures); `worktree.maxSlots` (20) added to DIPO-26; `work.resume` provisional until DIPO-61; `office.purge` idempotency kept in memory (DIPO-76, 0005 line); DIPO-64 log reader in `client/node`; DIPO-67 devDependency import ban is a test script, not an oxlint rule; every story inherits "tests create temp files and sockets only under `DIPO_TMP`"; DIPO-23 has a `DIPO_RUNTIME_DIR` test override; stories after cutover cite D14 instead of D6.
<!-- SECTION:NOTES:END -->
