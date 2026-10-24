# 0013 Repository scan and script standard

Status: accepted. First written 2026-10-10 (spike DIPO-9). Rewritten 2026-10-24 for the simplified design. The research behind the rewrite is in `docs/research/2026-10-24-simplification-audit.md`.

## Decision in short

Each repository is self-sufficient. dipo learns how to install, start and check it by **scanning**, with pure code over a probe of files, and stores the result as a **run profile** in its database, not in a config file. A standard set of script names lets code understand a repository alone. A model is asked only when the maintainer runs `dipo office infer`, only for what code left unresolved, and its proposals do nothing until the maintainer confirms them.

## 1. The standard scripts

The standard is a set of root `package.json` scripts, run with the detected package manager (`bun run X`, `pnpm run X`, `npm run X`). In a workspace the root scripts are the interface and delegate to packages themselves. Install is not a script: dipo derives it from the package manager (section 3).

| Script | Required | Behaviour |
|---|---|---|
| `setup` | Optional | Preparation after install: generate data, download browsers, create local files from examples if they are missing. Idempotent. Never overwrites an existing env file |
| `dev` | Required if there is something to start | Starts the product for testing, in the foreground until SIGTERM. Prints the URL it serves |
| `test` | Required | The fast suite. Runs once, never in watch mode, with no prompts, and works with `CI=1` |
| `lint` | Recommended | Static checks. Never rewrites files |
| `typecheck` | Recommended | Type checking without output files |
| `verify` | Recommended | The full gate a worker passes before it reports done: typically `lint`, `typecheck` and `test`, stopping at the first failure |
| `build` | Optional | A production build. Never part of a composed verify |
| `format` | Optional | A formatting check only; `format:fix` writes |

All of them are non-interactive and have a timeout from the office config. Any non-zero exit is a failure. Other scripts (`e2e`, `test:slow`) are recorded by name for reference and are not run by default.

## 2. Conformance

The scan rates a repository **conforming** (lockfile, `test`, `dev` or marked as having nothing to start, and verify resolves from code), **partial** (some capabilities need inference or the maintainer) or **non-standard** (no `package.json`, or nothing resolves). Each deviation from the standard is listed as a plain finding, so the maintainer can fix the repository instead of confirming a workaround.

- `work.run` refuses an office whose verify capability is neither resolved nor confirmed. The refusal names the script to add, or `dipo office infer`.
- `dipo test` refuses when install or `dev` is unresolved.
- Every other command works at any level.

## 3. Detection

Each capability resolves from the first source that yields a result. Every resolved capability records its source and a confidence.

| Capability | Sources, in order |
|---|---|
| Package manager | The `packageManager` field; the lockfile; otherwise npm |
| Install | A declared install in `.claude/backlog-workflow.json`; the frozen install of the package manager (`bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `npm ci`) |
| Runtime version | `.node-version`, `.nvmrc`, `engines.node` |
| `setup`, `dev`, `test`, `lint`, `typecheck`, `build` | The standard script of that name |
| `verify` | The `verify` script; a declared verify list in `.claude/backlog-workflow.json`; composed from `lint`, `typecheck` and `test` |
| Dev port | An explicit port in the dev server config or the script; the framework default (Vite 5173, Next 3000, wrangler 8787) |
| Anything else | Unresolved, until `dipo office infer` (section 6) |

- **Conflicts are findings,** never resolved silently: two lockfiles, a `packageManager` that disagrees with the lockfile, or a `verify` script next to a different declared list.
- **Pure detection.** Detection runs no repository script. Only repositories with a root `package.json` get code detection.
- **The old bridge.** `.claude/backlog-workflow.json` is read as evidence the maintainer already wrote, never written. Relying on it is reported as a deviation.

## 4. The run profile

Stored per office in the database (0007):

- the scan time, the commit and the fingerprint (section 5);
- the toolchain: package manager and version, runtime version, workspace layout;
- each capability's command list, working directory, source, confidence and whether it is confirmed;
- extra scripts by name;
- env files by path only: each example file, its expected real file, and whether git ignores it. The scan never reads env contents or hashes them;
- the dev port and where it came from;
- the conformance level and its deviations, plus the previous profile so a rescan can show a diff.

The profile also gives dipo the default box image for the office (0008): the toolchain and runtime the image needs. The maintainer can override it in the office config.

## 5. When to rescan

- **The fingerprint** is a hash over the inputs the profile depends on:
  - the root and workspace `package.json` fields (`scripts`, `packageManager`, `workspaces`, `engines`);
  - the workspace manifest's package list;
  - which lockfile exists, by name only;
  - `.node-version` and `.nvmrc`;
  - the dev server and runtime config files and the local modules they import;
  - the set of env example files;
  - `.claude/backlog-workflow.json`.
- **Not lockfile contents.** A dependency change means "install again", not "rescan".
- **When it is checked.** dipo computes the fingerprint on the base at office load, before each `work.run` and before `dipo test`. On a change it redoes the code part of the scan and records the diff.
- **Inferred and confirmed capabilities** are never refreshed silently. They are marked stale and keep working until the maintainer confirms them again.
- **A story branch that changes `test`, `lint`, `typecheck` or `verify`** has the changed commands reported to the reviewer, so a worker cannot quietly weaken the gate it is judged by. The office profile changes only once the branch merges.
- **`dipo office rescan`** does the same at any time and shows the diff.

## 6. Inference and confirmation

1. **The maintainer asks.** `dipo office infer` runs the inference. It never runs by itself.
2. **Code builds the evidence.** The file tree to depth 2, the manifests, a `Makefile` or `justfile`, the install and run sections of README and `CLAUDE.md`, CI `run:` steps, and env file names. It never includes env contents.
3. **One scan session asks.** The session runs on the Mac with every tool off (0008), using the office's `scan` block: model, effort, budget and minutes. It asks for each unresolved or conflicting capability: a command, a working directory, the evidence it relied on, and a confidence. Code validates the answer against a schema and checks that the scripts and files it names exist.
4. **Proposals do nothing yet.** They are stored as pending, and a pending command never runs. The desk lists them.
5. **The maintainer decides.** `dipo office confirm accept|edit|reject|set|pick|keep <capability>`:
   - an accepted proposal becomes confirmed with source `inferred`;
   - an edited or set one gets source `maintainer`;
   - `keep` confirms a stale one again.

   Confirm acts only on capabilities code leaves unresolved or in conflict, and a proposal made at another fingerprint cannot be accepted.
6. **The way out.** dipo names the deviations the maintainer could remove by adding a standard script, so the repository can conform and drop the workaround.

## Replaced

- `PORT` required for `dev`, and fixed dev ports rated partial, so parallel worktrees would not clash (2026-10-10). Removed (2026-10-24): each box and test box has its own network (0008), so a fixed port no longer collides. The scan still records the port, for the test box's forwarder.
- Install, `setup` and verify run by dipo in a Mac worktree, and the base profile's verify run next to a branch's changed verify (2026-10-10). Replaced by install and `setup` in the box, the worker's own verify, and CI as the gate (0008, 0002).
- An inference that ran by itself when a capability was unresolved (2026-10-10). Replaced by `dipo office infer` only (2026-10-22).
- The survey of the maintainer's repositories and the fit table of 2026-10-09. They are in git history; the scan reports each repository's level itself.
