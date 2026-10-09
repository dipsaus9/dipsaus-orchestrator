# 0013 Repository scan and script standard

Status: Proposed (spike DIPO-9, 2026-10-09). Needs the maintainer's approval.

## Context

Decision 0011 item 8 and the vision ("How to run a product") say each repository is self-sufficient, the orchestrator learns how to run it by scanning, and stores that knowledge in the office's local database, not in a configuration file. A standard set of script names lets code understand a repository alone. AI only infers what a non-standard repository does, and the maintainer confirms.

This record defines that standard, what the scan detects and stores, when it rescans, and the AI fallback. Worktree mechanics (copying gitignored files, port allocation) belong to DIPO-7. The database schema belongs to DIPO-4. This record describes the data, not tables.

## Survey

Read-only survey of `~/Projects/Personal` on 2026-10-09. Env files are listed by name only. Their contents were not read.

| Repo | Package manager, lockfile | Workspaces | Start | Test | Lint, typecheck | `verify` script | Env files | Dev ports | `.claude/backlog-workflow.json` |
|---|---|---|---|---|---|---|---|---|---|
| couchcade | pnpm, `packageManager: pnpm@11.27.0`, `pnpm-lock.yaml`, `.node-version`, `engines.node >=24` | pnpm workspace: apps, games, packages, tooling, e2e. Root scripts delegate with `pnpm -r` / `--filter` | `dev`: `pnpm -r --parallel run dev` (3 Vite servers, one runs the Worker in workerd) | `test`: `pnpm -r run test`. Two packages run `playwright install` first. `e2e` separate | `lint` (oxlint), `check` = `oxfmt --check && oxlint && typecheck`. No root `typecheck` | none | `apps/server/.dev.vars` (gitignored, present), `.dev.vars.example`. README: copy example before `pnpm dev` | fixed 5173, 5174, 5175 in `packages/config/vite`, 5176 `strictPort` for a dev tool | verify `[]`, install `pnpm install --frozen-lockfile`, includeGitignored `apps/server/.dev.vars` |
| slaydoku | bun, `bun.lock` | none | `dev`: `vite` | `test`: `vitest run` (CI adds `--maxWorkers=1`), `test:slow`, `verify:phone` | `lint` (oxlint), `typecheck` | yes, but a puzzle checker: `bun tools/verify.ts <puzzle.json>`, exits 2 without an argument | none found | Vite default 5173 | verify `lint, typecheck, test`, install `bun install` |
| cadeauko | bun, `bun.lock` | none | `dev`: `vite`, `preview` 4173 | same as slaydoku | `lint` (oxlint), `typecheck` | same puzzle checker as slaydoku | none found | Vite default 5173 | verify `lint, typecheck, test`, install `bun install` |
| kompanen/borrel-35 | bun, `bun.lock` | none | `dev`: `next dev --turbopack`. `start` serves a production build | `test`: `vitest run`, `test:watch` | `lint` (eslint), `typecheck`. `format` writes, `format:check` checks | none | `.env*` gitignored, none present | Next default 3000 | verify `lint, typecheck` (no test), install `bun install` |
| tennis-booker | bun, `bun.lock` | none | none. CLI and scheduler (`book`, `slots`, `scheduler`) | `test`: `bun test` | `typecheck` only | none | `.env` + `.env.example`. Also gitignored `config.json`, `.token.json` with `config.example.json` | none | none |
| valentine-2026 | pnpm, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, no `packageManager` | single package | `dev`: `react-router dev`. `start` serves the build | none | `typecheck` | none | none | Vite default 5173 | none |
| kompanen/borrel-34 | npm, `package-lock.json` | none | `dev`: `next dev`, `predev` hook generates data | none | `lint` (`next lint`) | none | none | 3000 | none |
| romy-blij-maken | npm, `package-lock.json` | none | `dev`: `next dev --turbopack` | none | `lint` (eslint) | none | none | 3000 | none |
| blog | npm, `package-lock.json` | none | none (content repo) | none | `format` checks, `format:fix` writes | none | none | none | none |

Predecessor: `~/Projects/Divotion/dipsaus-ai/src/workflow/verify-detect.ts` derives verify from lockfile plus the scripts `lint, typecheck, test, build`, with fixed command lists for Python, Go and Rust, and returns `[]` when nothing matches. It is pure: a probe of filesystem facts goes in, commands come out. This record keeps that split.

What the survey shows:

1. All nine repos are JavaScript or TypeScript with a `package.json`. Three package managers are in use (bun 4, npm 3, pnpm 2).
2. `dev` means "start for local testing" in every repo that has a server. `start` means "serve a production build" in four of them (borrel-35, valentine-2026, borrel-34, romy-blij-maken). The standard must use `dev`, not `start`.
3. `test` and `lint` mean the same thing everywhere they exist. `typecheck` exists at the root in five repos, plus in couchcade's packages.
4. Nobody has a `verify` that matches what the orchestrator needs. Two repos use `verify` for something else. The `backlog-workflow.json` files differ: slaydoku and cadeauko declare `lint`, `typecheck`, `test`; borrel-35 declares `lint`, `typecheck`; couchcade declares none.
5. `format` is ambiguous: it writes in two repos and checks in one.
6. Env files are rare but real (couchcade, tennis-booker), always gitignored, and paired with an `.example` file.
7. Ports are mostly framework defaults. Couchcade fixes three ports in code, so two worktrees running `dev` at once will clash.

## Decision

### 1. The standard scripts

The standard is a set of `package.json` scripts at the repository root, run with the detected package manager (`bun run X`, `pnpm run X`, `npm run X`). In a workspace repo the root scripts are the interface. They delegate to packages themselves, as couchcade already does.

Install is not a script. `install` is an npm lifecycle hook name, so the orchestrator derives install from the package manager instead (section 3).

| Script | Required | Behavior | Exit code |
|---|---|---|---|
| `setup` | optional | Preparation after install: generate data, download browsers, create local files from examples if missing. Idempotent, safe to run twice. Never overwrites an existing env file. The engine runs it after every install in a fresh checkout or worktree | 0 done, non-zero failed |
| `dev` | required if the product has something to start | Starts the product for the maintainer to test. Stays in the foreground until stopped. Prints the URL it serves; the engine takes the first `http://` or `https://` URL on stdout or stderr within the start timeout as the product URL. Should honour a `PORT` environment variable when one is set. Stops cleanly on SIGTERM | non-zero if it fails to start. Exit after SIGTERM is not judged |
| `test` | required | The fast automated suite. Runs once, never in watch mode. No prompts. Works without a TTY and with `CI=1` | 0 pass, non-zero fail |
| `lint` | recommended | Static checks. Read-only, never rewrites files | 0 clean, non-zero findings |
| `typecheck` | recommended | Type checking without emitting output | 0 clean, non-zero errors |
| `verify` | recommended | The full gate a worker must pass before review. No arguments. Typically `lint`, `typecheck` and `test` in sequence, stopping at the first failure | 0 ready for review, non-zero not ready |
| `build` | optional | Production build. Not part of verify by default | 0 built, non-zero failed |

Rules for all of them:

- Non-interactive. A script that waits for input is a defect. The orchestrator applies a timeout per script and treats a timeout as failure. Timeouts come from office configuration, with defaults per script (exact values are set when the engine is built).
- Any non-zero exit is a failure. The standard does not assign meaning to specific non-zero codes.
- Output goes to stdout and stderr. The orchestrator stores and shows it. It does not parse it, except for the `dev` URL.
- Extra scripts (`e2e`, `test:slow`, `verify:phone`, `format`) are allowed. The scan records them so the maintainer and roles can reference them, but the engine does not run them by default.

### 2. How strict

The standard is a convention, not a gate on opening an office. The scan rates each repository:

- **Conforming.** Lockfile present, `test` present, `dev` present (or the maintainer marked the product as having nothing to start), and verify resolves from code (a `verify` script or `lint`/`typecheck`/`test` to compose it). Code understands it fully.
- **Partial.** Some capabilities resolve from code, others need the AI fallback or the maintainer.
- **Non-standard.** No `package.json`, or nothing resolves.

`run` refuses to start stories in an office whose verify capability is not resolved or confirmed. The story test command (working name `test-story`; its final name is set in DIPO-2) refuses when install or `dev` is unresolved. Every other command works at any level. The scan lists each deviation from the standard as a plain finding, so the maintainer can fix the repo instead of confirming a workaround.

### 3. Detection order and confidence

Each capability resolves from the first source that yields a result. Every resolved capability records its source and a confidence.

| Capability | Sources, in order | Confidence |
|---|---|---|
| Package manager | `packageManager` field; lockfile (`bun.lock`/`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`); none means npm | high, high, low |
| Install | declared `worktree.install` in `.claude/backlog-workflow.json`; derived frozen install (`bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `npm ci`) | high, high |
| Runtime version | `.node-version`, `.nvmrc`, `engines.node` | high, high, medium |
| setup, dev, test, lint, typecheck, build | the standard script of that name | high |
| verify | standard `verify` script; declared non-empty `verify` list in `.claude/backlog-workflow.json`; composed from `lint`, `typecheck`, `test` in that order, using those present | high, high, medium |
| Dev ports | explicit port in dev server config (`server.port` in `vite.config.*`, values imported from a config module, `--port` in the script); framework default (Vite 5173, Next 3000, wrangler 8787) | medium, low |
| Anything still unresolved | AI fallback (section 6) | low until confirmed |

Conflicts are never resolved silently. Two lockfiles, a `packageManager` field that disagrees with the lockfile, or a `verify` script next to a different declared verify list all become findings that need the maintainer. Slaydoku and cadeauko hit the last case today.

`.claude/backlog-workflow.json` is read as evidence the maintainer already wrote, not as orchestrator configuration. The orchestrator never writes it.

Detection is pure code over a probe of filesystem facts, as in the predecessor. It runs no repository script. Only Node-family repos (a root `package.json`) get code detection in this version. Other stacks go to the AI fallback until a real project needs more.

### 4. What the scan stores

One run profile per office, in the office's local database (DIPO-4). It holds:

- When it was scanned, the commit it scanned, and the fingerprint (section 5).
- Toolchain: package manager and version, runtime version, workspace layout and package names.
- Each capability (install, setup, dev, test, lint, typecheck, verify, build): the command or ordered command list, working directory, source (standard, declared, composed, default, inferred, maintainer), confidence, and whether the maintainer confirmed it.
- Extra scripts by name and command, for reference.
- Env files, by path only. An example file is any file whose name contains `.example` (for example `.env.example`, `.dev.vars.example`, `config.example.json`). Its expected real file is the same path with `.example` removed. For each: the example file, its expected real file, whether the real file is present in the main checkout, and whether git ignores it. Paths listed in `includeGitignored` are recorded the same way. The scan reads no env file contents and stores no hash of them.
- Dev ports: each port, where it came from, and whether it is fixed in code or can be overridden by `PORT`.
- Conformance level and the list of deviations.
- The previous confirmed profile, so a rescan can show a diff.

The profile is machine knowledge. If the database is lost, a rescan rebuilds the code-derived part. Only the maintainer's confirmations of AI proposals need redoing.

### 5. When to rescan

The fingerprint is a hash over the inputs the profile depends on:

- `scripts`, `packageManager`, `workspaces` and `engines` of the root `package.json` and of each workspace package.
- The `packages` key of the workspace manifest (`pnpm-workspace.yaml`). Other keys, such as a dependency `catalog`, are left out because they are dependency changes.
- Which lockfile exists (its name, not its contents).
- `.node-version`, `.nvmrc`.
- Dev server and runtime config files: `vite.config.*`, `next.config.*`, `react-router.config.*`, `wrangler.*`, `playwright.config.*`.
- The set of env example files and `includeGitignored` paths (names only).
- `.claude/backlog-workflow.json`.

Lockfile contents are left out on purpose. A dependency change means "install again", not "rescan". DIPO-7 owns reinstalling in a worktree when the lockfile hash changes.

The engine computes the fingerprint on the base branch at daemon start, before each `run` batch and before `test-story`. That is cheap and needs no model. On a mismatch it redoes the code part of the scan automatically and records the diff. Capabilities that came from AI or the maintainer are not refreshed silently. They are marked stale and listed for the maintainer to confirm again.

A story branch can change scripts. When a worktree's fingerprint differs from the base profile, the engine runs a code-only scan of that worktree for that run and does not store it. If that scan needs AI, the run uses the base profile and reports the mismatch to the reviewer. Whenever a branch changes a gate capability (`test`, `lint`, `typecheck`, `verify`), the changed commands are always reported to the reviewer, and the base profile's verify also runs, so a worker cannot weaken the gate it is judged by. The office profile changes only after the branch merges and the base fingerprint changes.

`rescan` is a command the maintainer can run at any time. It does the same work and shows the diff.

### 6. AI fallback and confirmation

The fallback runs only for capabilities that code leaves unresolved or in conflict, never for the whole repo.

1. Code builds an evidence bundle: the file tree to depth 2 (excluding `node_modules`, build output and worktrees), manifests, `Makefile` or `justfile` if present, README and `CLAUDE.md` sections about installing and running, CI workflow `run:` steps, `.claude/backlog-workflow.json`, and env file names. Env file contents are never included.
2. The model gets one structured request: for each unresolved capability, propose a command, working directory, the evidence it relied on, and a confidence. Code validates the response against a schema and checks that referenced scripts and files exist.
3. The proposals are stored as pending, with confidence low. Pending commands are never executed.
4. The maintainer reviews them through a command available in every client: accept, edit, or reject each one. Accepted proposals become confirmed with source `inferred`. Edited ones get source `maintainer`.
5. The maintainer may set a capability by hand with the same command, without the AI step. This also resolves conflicts such as the slaydoku `verify` case.
6. The engine reports which deviations the maintainer could remove by renaming or adding a standard script, so the repo can conform and drop the confirmed workaround.

### 7. Env files and ports, as far as scanning goes

The orchestrator does not manage secrets or setup. The scan only records facts DIPO-7 needs: which gitignored files a fresh worktree will lack, which of them exist in the main checkout, and which ports are fixed. A missing real env file next to its example is a deviation ("`apps/server/.dev.vars` absent, `.dev.vars.example` present"), not something the orchestrator creates. It is not a deviation when the repo has a `setup` script, because `setup` may create it from the example. Fixed ports are flagged because parallel worktrees running `dev` will collide. Couchcade is the current example. DIPO-7 decides copying and port allocation.

## Fit of the surveyed repos

| Repo | Level | Change to conform |
|---|---|---|
| couchcade | Conforming, with deviations | Composed verify (`lint`, `test`) misses the package typechecks and format check: add root `verify` (`pnpm run check && pnpm run test`). Fixed ports are a deviation: let `PORT` or an offset override them |
| slaydoku, cadeauko | Partial (verify conflict) | Rename the puzzle checker to `verify:puzzle`, add `verify` that runs lint, typecheck, test |
| kompanen/borrel-35 | Conforming | Declared verify lacks `test`. Composing would include it. Maintainer to choose |
| tennis-booker | Partial until marked as having nothing to start | Maintainer marks it as having nothing to start (a CLI), then it is Conforming. Add `lint` if wanted |
| valentine-2026, borrel-34, romy-blij-maken | Partial | Add `test` |
| blog | Not a product | Not an office candidate |

## Consequences

- A conforming repo is understood with no model call, in line with decision 0011 item 4.
- The engine needs a small pure detector (probe in, profile out) plus a fingerprint function. Both are testable without a repository on disk.
- The maintainer gets a short to-do list per repo (table above). Nothing breaks if they do not act on it, but those repos need confirmation instead.
- Honouring `.claude/backlog-workflow.json` keeps today's repos working. It ranks below the repo's own standard `verify` script, so the standard comes first. Two sources can still describe verify, which the conflict rule has to catch.
- Storing env file names, never contents or hashes, keeps the database free of secret material.
- Non-Node stacks need the AI fallback until code detection is added for them.

## Open questions for the maintainer

1. Should `verify` be required instead of recommended, given that every surveyed repo composes it from `lint`, `typecheck`, `test` anyway?
2. Should `build` be part of composed verify? The predecessor includes it, the repos' CI does not.
3. Rename the puzzle checker in slaydoku and cadeauko to free the name `verify`? Or pick a different standard name, for example `check`, which couchcade uses with a similar meaning?
4. Keep reading `.claude/backlog-workflow.json` long term, or only until the repos conform?
5. Should `dev` be required to honour `PORT`? Vite and wrangler do not read it by default, so most repos would need a small config change. This depends on DIPO-7's port rule.
6. Should `format` be standardised as "check only", given that it writes in two repos and checks in one?
