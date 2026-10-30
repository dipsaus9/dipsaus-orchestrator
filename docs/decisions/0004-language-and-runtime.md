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
- Inside `engine`, a file imports values only from its own directory and from lower layers (see Engine layers). Types may cross. The layers are listed once, in the lint plugin.
- Inside `engine` and `daemon`, only `engine/src/platform/**` touches `bun`, `bun:*` (except `bun:test`) or the global `Bun`.
- Inside `engine`, only `workers/claude-cli/**` imports the Claude adapter. No other source file of any package names Claude's tools or model aliases, in code or in prose; the office configuration's model defaults are the one exception.
- `daemon` imports from `engine` only `createEngine`, types and the engine's platform entry (0005).
- `client`'s main entry uses no Bun or Node API.
- No runtime import cycles (`import/no-cycle`, type-only cycles allowed).
- Function size caps: at most 100 lines, complexity 20 and 5 parameters per function.

## Engine layers

The engine's directories sit in sixteen layers, lowest first. A file imports values only from its own directory and from lower layers, and two directories of one layer never import each other's values, so the directories form no cycle. Type-only imports may cross. An entry is a directory of `packages/engine/src`, a file at its top, or a listed subdirectory, which then counts apart from its parent. `bun scripts/engine-graph.ts` measures the import graph against the list.

The order follows a fact through the engine (0005): facts are stored and read, views are derived from them, writers store new facts with their change-log entries and views, the run and the services act through the writers, and the composition root wires them together.

| Layer | Entries | Why there |
|---|---|---|
| 1 | `platform` | The only code that touches Bun (above). It imports nothing else of the engine. |
| 2 | `changelog`, `config`, `context`, `git`, `keepawake`, `software-stream`, `story-store`, `wiring`, `workers` | Each needs at most the platform. `git` is the one git module, office discovery included. `story-store` is the StoryStore seam (0010). `workers` is the WorkerPort with its types and holds, not the adapter. |
| 3 | `gate`, `log`, `scan/detect` | Pure checks: the Ready gate's rules and content hash, and repository detection over git. The log redacts with `context`. |
| 4 | `host`, `prompts` | Prompt templates and assembly, which quote the gate's text limits; the engine side of the worker host's socket, which logs. |
| 5 | `box`, `db`, `records` | `records` holds the stored facts the services read and write without a change-log entry: runs, agents, worker hosts, signals, caps, park state, usage, story keys and story PR records. `db` is the schema and its migrations; two migrations render prompt texts, so it sits above `prompts`. `box` is the box backend; it reads repository detection and renders conflict texts. |
| 6 | `commands`, `review`, `views` | `views` derives the work, story and usage views from the facts (0005). `commands` holds command errors, requests and the registry. `review` stores and checks verdicts. |
| 7 | `ingest`, `office`, `reads`, `scan` | `ingest` turns worker output into facts with their entries and views, phase markers included. `office` opens and manages offices, and reads the office file at a commit with the box image code. `reads` runs reads. `scan` builds the repository profile and its AI fallback. |
| 8 | `run-state`, `workers/claude-cli` | `run-state` holds the writes the run, claims, merges and reconcile share: phase and rounds, places, park records, questions and merge gates, each with its change-log entry. The Claude adapter needs the box and ingest. |
| 9 | `worktree` | Story claims, the Done check and teardown, which end runs and resolve parks through `run-state`. |
| 10 | `stories` | The story index, which mirrors Backlog.md and reads claims. |
| 11 | `gate/store`, `retention`, `run` | `run` drives a story's run from launch to its end, with park, resume, discard and tests. `gate/store` keeps gate decisions and reads stories. `retention` deletes old run facts. |
| 12 | `backup`, `merge`, `overview`, `questions`, `reconcile`, `story-pr` | The services that act on runs: the merge slot, `work.answer`, the story PR, reconcile at start, and backups with the daily file maintenance, which work in retention's time slices. `overview` holds the reads the maintainer sees: the snapshot, the desk, the digest and the summary. |
| 13 | `backlog` | The StoryStore's Backlog.md implementation and the planning lane, which use merges, gates and the desk. |
| 14 | `features.ts` | The list of feature modules. |
| 15 | `create` | The composition root, with the run's wiring. |
| 16 | `index.ts`, `platform-entry.ts` | The engine's two entries. |

Until the moves of DIPO-389 to DIPO-394 land, the lint rule holds three coarse layers: the base, one domain layer, and the composition root.

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
- One domain layer holding every orchestration directory of the engine (2026-10-29), while those directories still imported each other both ways. Replaced by the sixteen engine layers above (2026-10-30, DIPO-381).
