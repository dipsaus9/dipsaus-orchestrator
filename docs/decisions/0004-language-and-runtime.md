# 0004 Language, runtime and project structure

Status: accepted. First written 2026-10-10 (spike DIPO-1). Rewritten 2026-10-24 for the simplified design.

## Decision

dipo is TypeScript on Bun, in a Bun workspace monorepo, compiled to one executable named `dipo` with `bun build --compile`. It runs on **macOS on Apple silicon** (`darwin-arm64`) only, because every worker runs in an Apple `container` box (0008).

Why:

1. **One language end to end.** The engine, the contract and every client share zod schemas. Types and runtime validation of every command and event come from one definition, with no second schema language and no code generation.
2. **The hard runtime pieces are built in.** `bun:sqlite`, Unix sockets, subprocess streaming with backpressure and the single-binary build come with Bun. There is no native addon to ship.
3. **It fits the worker and the maintainer.** Claude Code itself ships as a Bun executable, and the maintainer already works in TypeScript on Bun.

The maintainer accepted the costs: Bun is young and owned by one company, which also owns the worker CLI and the subscription terms. Runtime-specific code stays in the platform module, and Claude stays behind the worker adapter, so both remain swappable.

## Platform

- **Product:** macOS on Apple silicon, with Apple `container` for boxes. The box keeps a backend interface (0008), so a Linux backend can be added when there is a real need.
- **Autostart:** launchd. There are no systemd units, no `systemd-run` scopes, no `systemd-inhibit` and no `bwrap`.
- **CI:** Linux runners run the tests that need no box; a macOS job runs the rest (0016). Linux is a test host, not a product platform.
- **Windows:** out of scope.

## Repository layout

Bun workspaces. Every package is TypeScript ESM, scoped `@dipsaus-orchestrator/*`, with an `exports` map that exposes only its public entry; the engine also exposes its platform entry for the daemon (0005).

| Package | Holds | May import |
|---|---|---|
| `contract` | Commands, reads, events and shared types. zod schemas only, no I/O | zod |
| `engine` | The headless core: offices, stories, runs, gates, git, backlog, the database, the box | `contract` |
| `daemon` | The composition root. Wires the engine to the socket server. Exports only `runDaemon` | `contract`, `engine` |
| `client` | Main entry: the runtime-free protocol core and `OfficeStore`. `client/node`: the Unix-socket transport and daemon lifecycle | `contract` |
| `tui` | The first client | `contract`, `client` |
| `cli` | The binary. `dipo daemon` forms call `runDaemon`; everything else goes through `client` | `contract`, `client`, `tui`, `daemon` |
| `testkit` | Private test helpers: clock, ids, temporary repositories, fake process | Used by tests only |

The daemon-side forms of the binary are `dipo daemon --foreground` and `dipo daemon worker-host <run>`. Both call `runDaemon(argv)`.

## Boundaries enforced in code

These are lint rules in `.oxlintrc.json` and `tools/lint/`, proven by `test/lint-boundaries/`. `bun run verify` fails on any of them.

- Each package imports only the packages the table above allows, and `testkit` only from tests. The bans hold for every import form: static, type-only, a dynamic `import()`, `require` and `import.meta.require`. One rule holds the list.
- `tui`, `client` and `cli` never import `engine`. `cli` reaches the daemon only through `runDaemon`, and loads `daemon` and `tui` only in the subcommands that use them.
- No file imports a package's internals by package specifier (`@dipsaus-orchestrator/*/src/*`), and no package reaches another package's files by relative path. Outside the packages, only the cross-package tests in `test/`, the tools in `tools/` and the CI scripts in `scripts/` read package files by relative path; none of them is shipped.
- `contract` imports nothing but zod, in every source file.
- `engine` never imports `daemon`, `client`, `tui` or `cli`, and finds no file of theirs by path.
- Inside `engine`, the directories form no import cycle, and no directory imports a value from a directory in a higher band or a higher layer of the plugin's order (see Engine layers). Types may cross.
- Inside `engine` and `daemon`, only `engine/src/platform/**` touches `bun`, `bun:*` (except `bun:test`) or the global `Bun`.
- Inside `engine`, only `workers/claude-cli/**` imports the Claude adapter. No other source file of any package names Claude's tools or model aliases, in code or in prose; the office configuration's model defaults are the one exception.
- `daemon` imports from `engine` only `createEngine`, types and the engine's platform entry (0005).
- `client`'s main entry uses no Bun or Node API.
- No runtime import cycles (`import/no-cycle`, type-only cycles allowed).
- Function size caps: at most 100 lines, complexity 20 and 5 parameters per function.

## Engine layers

The engine's directories sit in six bands, lowest first. Two rules hold:

- **No directory cycles.** No chain of value imports leads from a directory back to itself.
- **Nothing imports upward.** No directory imports a value from a directory in a higher band.

Type-only imports may cross both rules. Inside a band, one directory may import another as long as the import closes no cycle; such an import needs no change to this ADR.

| Band | Directories | Why there |
|---|---|---|
| 1. Base | `platform`, `changelog`, `config`, `context`, `git`, `host`, `keepawake`, `log`, `software-stream`, `story-store`, `wiring`, `workers` | They need nothing but each other: the Bun seam (above), the change log, configuration, the one git module, the worker host's socket client, logging, the StoryStore seam (0010) and the WorkerPort with its types. The Claude adapter is not here. |
| 2. Checks and texts | `gate`, `scan/detect`, `prompts` | Pure functions over stories and repositories: the Ready gate's rules and content hash, repository detection, and the prompt templates, which quote the gate's text limits. |
| 3. Facts and boxes | `db`, `records`, `box` | What every service reads or runs in. `records` holds the stored facts that are read and written without a change-log entry: runs, agents, worker hosts, signals, caps, park state, usage, story keys and story PR rows. `db` holds the schema and migrations; two migrations render prompt texts. `box` is the box backend, which reads detection and renders conflict texts. |
| 4. Views and writers | `views`, `commands`, `review`, `reads`, `ingest`, `office`, `scan`, `run-state`, `workers/claude-cli`, `worktree`, `stories` | Views are derived from the facts (0005), and every writer stores a fact with its change-log entry and the derived view, so the views sit first. Then come ingest of worker output with its phase markers, offices, the repository profile, the run-state writes shared by the run, claims, merges and reconcile (phases, places, parks, questions, merge gates), the Claude adapter, claims and the story index. |
| 5. Run and services | `run`, `gate-decisions`, `retention`, `backup`, `merge`, `overview`, `questions`, `reconcile`, `story-pr`, `backlog` | They act through the writers. `run` drives a story's run with park, resume, discard and tests. Around it sit stored gate decisions, retention and backups, the merge slot, `work.answer`, the story PR, reconcile at start, the Backlog.md implementation of the StoryStore, and `overview`, the reads the maintainer sees (snapshot, desk, digest, summary). |
| 6. Composition | `features.ts`, `create`, `index.ts`, `platform-entry.ts` | The feature list, the composition root with the run's wiring, and the engine's two entries. |

**The fine order.** The lint plugin holds one list, a finer order of layers inside the bands. `dipo/engine-layers` refuses a value import into a higher layer of that list. Directory cycles are found by `bun scripts/engine-graph.ts --check`, which `bun run verify` runs.

- When a new import inside a band goes against that order, the fine order changes in the plugin; this ADR does not.
- An entry of the list is a directory, a file at the top of `packages/engine/src`, or a listed subdirectory such as `workers/claude-cli`, which then counts apart from its parent.
- Until DIPO-395, the plugin holds the coarse layers (the base, one domain layer and the composition root), and verify runs no cycle check yet. The target order waits in `scripts/engine-layers-target.json`, a temporary file that DIPO-395 moves into the plugin and deletes.

## Tooling

| Concern | Tool |
|---|---|
| Runtime and package manager | Bun, exact version in `.bun-version` (1.4.2), `bun.lock` committed |
| Language | TypeScript 7, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` |
| Typecheck | `tsc -b` over project references |
| Lint | oxlint 1.x, `--deny-warnings` |
| Format | oxfmt, pinned |
| Test | `bun test`, using only `describe`, `it` and `expect` |
| Build | `bun build --compile --target=bun-darwin-arm64` |

Pinned versions are listed in `CLAUDE.md`.

One command checks everything, locally, in workers and in CI:

```sh
bun run verify   # format:check, lint, typecheck, test; stops at the first failure
```

## Consequences

- A contract change is a type error in every package at once.
- A release is one `darwin-arm64` binary of about 60 to 100 MB, mostly the Bun runtime.
- Moving to Node later means replacing the platform module, `client/node`, the test runner and the build, not rewriting the engine.
- `bun:sqlite` on macOS uses the system SQLite, so the schema uses no SQLite extensions.

## Replaced

- Go, Rust and Node as runtimes (2026-10-10). Go was the runner-up and lost on the shared contract. The comparison is in git history.
- macOS and Linux on x64 and arm64 as product platforms (2026-10-24). Only `darwin-arm64` can run a box.
- `srt` (`@anthropic-ai/sandbox-runtime`) bundled behind `dipo daemon sandbox-exec`, and the `safe-chain-gate` form (2026-10-24). The box is the only sandbox technology now (0008).
- A planned browser, web, desktop or 3D client, served by the daemon (2026-10-24). It is listed under Later in 0003 and gets an ADR when it is planned.
- `dipo hook <event>` and its versioned handshake with the worker host (2026-10-12). Removed (2026-10-24): no session has hooks (0008).
- One domain layer holding every orchestration directory of the engine (2026-10-29), while those directories still imported each other both ways. Replaced by six bands, a fine layer order in the lint plugin and no directory cycles (2026-10-30, DIPO-381).
