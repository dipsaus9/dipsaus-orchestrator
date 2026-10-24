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

Bun workspaces. Every package is TypeScript ESM, scoped `@dipsaus-orchestrator/*`, with an `exports` map that exposes only its public entry.

| Package | Holds | May import |
|---|---|---|
| `contract` | Commands, reads, events and shared types. zod schemas only, no I/O | zod |
| `engine` | The headless core: offices, stories, runs, gates, git, backlog, the database, the box | `contract` |
| `daemon` | The composition root. Wires the engine to the socket server. Exports only `runDaemon` | `contract`, `engine` |
| `client` | Main entry: the runtime-free protocol core and `OfficeStore`. `client/node`: the Unix-socket transport and daemon lifecycle | `contract` |
| `tui` | The first client | `contract`, `client` |
| `cli` | The binary. `dipo daemon` forms call `runDaemon`; everything else goes through `client` | `contract`, `client`, `tui`, `daemon` |
| `testkit` | Private test helpers: clock, ids, temporary repositories, fake process | Used by tests only |

The daemon-side forms of the binary are `dipo daemon --foreground`, `dipo daemon worker-host <run>`, and `dipo daemon wait-pid <pid>`. All of them call `runDaemon(argv)`.

## Boundaries enforced in code

These are lint rules in `.oxlintrc.json` and `tools/lint/`, proven by `test/lint-boundaries/`. `bun run verify` fails on any of them.

- `tui`, `client` and `cli` never import `engine`. `cli` reaches the daemon only through `runDaemon`.
- No package imports another package's internals (`@dipsaus-orchestrator/*/src/*`), by package specifier or by relative path.
- `contract` imports nothing but zod.
- `engine` never imports `daemon`, `client`, `tui` or `cli`, and finds no file of theirs by path.
- Inside `engine` and `daemon`, only `engine/src/platform/**` touches `bun`, `bun:*` (except `bun:test`) or the global `Bun`.
- Inside `engine`, only `workers/claude-cli/**` imports the Claude adapter.
- `daemon` imports from `engine` only `createEngine`, types and the engine's platform entry (0005).
- `client`'s main entry uses no Bun or Node API.
- No runtime import cycles (`import/no-cycle`, type-only cycles allowed).
- Function size caps: at most 100 lines, complexity 20 and 5 parameters per function.

Four of these rules are not in place yet (2026-10-24): `contract` importing nothing but zod, `engine` never importing the other packages, the ban on deep imports by relative path, and `daemon` importing only `createEngine`, types and the platform entry. The prune plan adds them.

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
