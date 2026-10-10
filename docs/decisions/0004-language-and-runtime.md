# 0004 Language, runtime and project structure

Status: Proposed (DIPO-1 spike, 2026-10-09). Needs the maintainer's approval.

## Context

The orchestrator is a long-lived open source program with these parts (decisions 0001, 0003, 0011):

- A headless **engine** that runs as a detached **daemon**, so workers survive closing a client and overnight runs work.
- Workers are **long-running subprocesses**. The first adapter runs the Claude Code CLI (`claude -p --output-format stream-json`), which writes newline-delimited JSON events until a final `result` message [12]. The engine must spawn, stream, steer, signal (SIGINT to end a turn, SIGTERM to stop) and reap them, plus run `git`, `backlog` and project scripts.
- **Local IPC** between daemon and clients. Commands in, events out (transport is DIPO-2/DIPO-3).
- An embedded **SQLite** database per office (schema is DIPO-4).
- A **TUI** as the first client. A local web UI or desktop app may follow and must share the same command and event contract.
- Ships as **one installable CLI** on macOS and Linux.

Maintainer environment: Node 24.14, Bun 1.3.5 and pnpm 11 installed. No Go or Rust toolchain. The related plugin `dipsaus-ai` is TypeScript on Bun (`engines.bun >=1.3`), with zod 4 for schemas, oxlint, `tsc --noEmit` and vitest.

This ADR picks language, runtime, repo layout and tooling. It does not pick the IPC transport, schema, or worker contract.

## Options

### A. TypeScript on Node (24 LTS / 26)

- **Subprocesses:** `node:child_process` is mature and well understood. Line-splitting NDJSON from stdout is a few lines.
- **Daemon and IPC:** `node:net` supports Unix domain sockets. Detaching via `spawn(..., { detached: true })` is standard.
- **SQLite:** `node:sqlite` is built in but still "Release candidate" (stability 1.2) in the Node 26 docs [3]. It had a data-corrupting TEXT truncation bug fixed in 24.16 and a 2026 CVE in the statement iterator [4][5]. `better-sqlite3` is the mature alternative but is a native addon.
- **TUI:** Ink 8 (React, `node >=22`) is the most used TS terminal UI library [8][9]. OpenTUI requires Node 26.4 with `--experimental-ffi` to render [10][11].
- **Distribution:** Single executable applications are "Active development" (stability 1.1). `node --build-sea` exists from 25.5, ESM entry points are supported, native addons must be extracted to a temp file at runtime [2]. In practice the simplest install is `npm i -g`, which requires Node on the user's machine.
- **Shared contract:** Same language as any web UI. zod schemas give runtime validation and static types in one place.
- **Contributors:** Largest contributor pool of the four.
- **Maintenance:** Node LTS cadence is predictable and governed by the OpenJS Foundation.

### B. TypeScript on Bun (1.4)

- **Subprocesses:** `Bun.spawn` plus the Node `child_process` API. Bun 1.4 adds stream backpressure for child processes, built-in PTY support (`terminal` option), and `--no-orphans` so children die with the parent [6].
- **Daemon and IPC:** Node `net` compatibility plus `Bun.listen` on Unix sockets. Same patterns as Node.
- **SQLite:** `bun:sqlite` is built in, synchronous, modeled on better-sqlite3, supports WAL, prepared statements and nested transactions, and works inside compiled executables [7][13]. On macOS it uses the system SQLite, so loading extensions needs `Database.setCustomSQLite` [13].
- **TUI:** Ink is expected to run on Bun; unverified, confirmed by the DIPO-6 prototype (under Bun and inside a compiled binary). OpenTUI (`@opentui/core` 0.5.17, `engines.bun >=1.3.0` [10]) is Bun-first, with React and Solid renderers. Its repository README states OpenCode uses it in production [11]. Still 0.x.
- **Distribution:** `bun build --compile` produces one self-contained executable and supports `--target` for darwin and linux x64/arm64 (glibc and musl) [7]. Bundled SQLite and assets come along. Binaries are large: the Bun runtime alone is about 70 MB on Linux [1].
- **Shared contract:** Same as A.
- **Contributors:** TypeScript pool. Bun is one `curl | bash` install; contributors already using Node can follow because Bun reads `package.json` and runs Node APIs.
- **Maintenance:** Bun joined Anthropic in December 2025, stays MIT, and Claude Code ships as a Bun executable, so the runtime the worker depends on is the same runtime the orchestrator would use [14]. Risks: Bun 1.4 (August 2026) is the first release after a mechanical port from Zig to Rust; the authors report 19 regressions found and fixed and 128 old bugs fixed [1][6]. Governance is one company, not a foundation.

### C. Go (1.27)

- **Subprocesses:** `os/exec`, goroutines and channels are the strongest fit of the four for supervising many long-running children and their streams.
- **Daemon and IPC:** `net` Unix sockets, trivial.
- **SQLite:** `modernc.org/sqlite` is a cgo-free port (SQLite 3.53.4) for darwin and linux on amd64 and arm64 [16], so cross-compiling stays easy.
- **TUI:** Bubble Tea 2.0 with Lip Gloss and Bubbles 2.0 shipped stable in 2026, with a new renderer [17][18]. Mature and widely used.
- **Distribution:** Best of the four. Small static binaries, `GOOS/GOARCH` cross-compiling, goreleaser and Homebrew taps are routine.
- **Shared contract:** Go types cannot be shared with a TS web UI. Needs a schema source (JSON Schema, protobuf) and code generation for both sides, plus a drift check in verify.
- **Contributors:** Easy language to read and review. The maintainer would have to install and learn a new toolchain, and reviewer agents would judge code in a language the maintainer does not use elsewhere.
- **Maintenance:** Excellent. Go 1.27.0 released 2026-08-19, strong compatibility promise [15].

### D. Rust

- **Subprocesses:** `tokio::process` is capable but async Rust adds real complexity for supervision code.
- **Daemon and IPC:** `tokio` Unix sockets, fine.
- **SQLite:** `rusqlite` 0.40 with the `bundled` feature compiles SQLite in [20].
- **TUI:** Ratatui 0.30.2 (June 2026), mature in practice, still pre-1.0 [19]. Immediate-mode, more code per screen than Ink or Bubble Tea.
- **Distribution:** Single binary, but cross-compiling to macOS from Linux needs extra setup.
- **Shared contract:** Same codegen problem as Go (e.g. `typeshare`, `ts-rs`) [21].
- **Contributors:** Smallest pool, steepest curve, slow compiles. Highest bar for an open source project with one maintainer.
- **Maintenance:** Excellent stability once written; slowest to change.

### Comparison

Scores: ++ strong, + good, 0 workable, - weak.

| Criterion | TS / Node | TS / Bun | Go | Rust |
|---|---|---|---|---|
| Spawn and supervise long-running subprocesses, stream JSON | + | + | ++ | + |
| Daemon and local IPC | + | + | ++ | + |
| Embedded SQLite | 0 (built-in is RC, or native addon) | ++ (built in, in binary) | + (pure Go) | + (bundled) |
| TUI library quality and maturity | + (Ink) | + (Ink, OpenTUI 0.x) | ++ (Bubble Tea 2) | + (Ratatui 0.30) |
| Single binary / simple install | 0 (SEA in active development) | + (large binary) | ++ | + |
| Contract types shared with web UI | ++ | ++ | - (codegen) | - (codegen) |
| Contributor friendliness | ++ | + | + | - |
| Long-term maintenance | ++ | + (young 1.4, one vendor) | ++ | ++ |
| Fits maintainer's environment and dipsaus-ai | + | ++ | - | - |
| Same runtime as Claude Code / Agent SDK types | + | ++ | - | - |

## Decision

**TypeScript on Bun, in a Bun workspace monorepo, compiled to a single executable with `bun build --compile`.**

Why:

1. **One language end to end.** The engine, the contract, the TUI and a later web or desktop UI share zod schemas directly. Types and runtime validation of every command and event come from one definition. Go and Rust need a second schema language and codegen, which is a permanent tax and a drift risk.
2. **The hard runtime pieces are built in.** SQLite, Unix sockets, subprocess streaming with backpressure, and the single-binary build are part of Bun, with no native addon to ship. Node needs either a release-candidate SQLite module or a native addon, and its single-binary story is still in active development.
3. **Fits the worker.** Claude Code itself ships as a Bun executable [14]. The TypeScript Agent SDK (`@anthropic-ai/claude-agent-sdk`) publishes typed message definitions for the same stream-json events [12][22], which the worker adapter can mirror or later swap to.
4. **Fits the maintainer.** Bun and TypeScript are already installed and used in `dipsaus-ai`. The maintainer tests behavior and does not review code (0002), but reading a stack trace or a config in a familiar language still matters.

**Runner-up: Go.** It wins on process supervision, binary size and toolchain stability, and Bubble Tea 2 is the most mature TUI library here. It loses on the shared contract with a web UI (codegen on both sides) and on fit: a new toolchain for the maintainer, and no shared code with `dipsaus-ai`. If the web UI were dropped from the plan, Go would be the stronger choice.

**Node stays a fallback.** Engine code reaches Bun-specific APIs (SQLite, spawn, sockets) only through a small `platform` module. The other Bun touchpoints are the test runner (`bun:test`), Bun workspaces with `bun.lock`, and `bun build --compile` (listed in Consequences). Tests use only the `describe`/`it`/`expect` subset so a runner swap stays mechanical. Moving to Node later is then a bounded change to the platform module, the test runner and the build, not a rewrite.

**TUI library:** this ADR limits the choice to TypeScript libraries that run on Bun. Ink 8 is the default candidate: mature, React-based, testable with plain render-to-string tests, and the same component model a web UI would use. OpenTUI is the alternative if Ink's rendering performance is insufficient for the live overview. The final pick belongs to the overview spike (DIPO-6); see open questions.

## Repo layout

Bun workspaces. Every package is TypeScript ESM. Package names are scoped `@dipsaus-orchestrator/*`.

```
dipsaus-orchestrator/
├── package.json            # workspaces, scripts (verify, lint, typecheck, test, build)
├── bun.lock
├── tsconfig.base.json      # strict settings shared by all packages
├── tsconfig.json           # project references to every package
├── .oxlintrc.json          # lint rules incl. import boundaries
├── packages/               # each package.json has an `exports` map with only its public entry
│   ├── contract/           # commands, events, shared types: zod schemas only, no I/O
│   │   └── src/{commands,events,ids,index}.ts
│   ├── engine/             # headless core: state, gates, scheduler, offices, git/backlog, db
│   │   └── src/
│   │       ├── platform/   # the only place that touches bun:sqlite, Bun.spawn, sockets
│   │       ├── workers/    # Worker interface + adapters (claude-cli first)
│   │       └── ...
│   ├── daemon/             # composition root: wires engine to the IPC server; exports only runDaemon
│   ├── client/             # typed IPC client for the contract; used by every UI and CLI subcommand
│   ├── tui/                # first client; imports contract + client only
│   └── cli/                # the binary: `daemon` subcommand calls runDaemon, all others go through client
├── docs/
└── backlog/
```

Boundary rules, enforced in code, not prose:

- `contract` depends on nothing but zod. Every other package may depend on it.
- `engine` depends on `contract`. It never imports a client package.
- `tui`, `client` and any future `web` or `desktop` package never import `engine` or `daemon`. Enforced by an oxlint `no-restricted-imports` rule (fails `verify`), backed by each package's declared `dependencies` and TypeScript project references.
- `cli` is the only package that imports both `daemon` and `tui`, because the single binary contains both. It has exactly one daemon entry: `<bin> daemon` calls `runDaemon`, the only export of `daemon`. Every other subcommand, including `<bin> tui`, goes through `client` over IPC. `cli` never imports `engine`; the oxlint rule forbids it.
- Every package's `package.json` has an `exports` map exposing only its public entry. Deep imports (`@dipsaus-orchestrator/*/src/*`) are banned by the oxlint rule.
- TypeScript 7 has no stable programmatic API until about 7.1 [23], which is why lint and boundary rules use oxlint, not typescript-eslint.
- Worker adapters live under `engine/src/workers/`. Claude specifics stay there (CLAUDE.md rule).

A future web UI is `packages/web` depending on `contract` and `client`. A desktop shell wraps that. A future 3D or 2D visual client (for example a hermes3d-style office) is built with web technology, React Three Fiber for 3D, in that same package, served by the daemon as a local page; see research section 8 (`docs/research/2026-10-comparable-tools.md`) for the comparison with game engines. Non-TypeScript clients, such as a game engine, use the contract's JSON Schema export (`z.toJSONSchema`). Browsers cannot use Unix sockets, so how browser clients connect is decided in DIPO-3.

## Tooling and the verify command

| Concern | Tool | Notes |
|---|---|---|
| Runtime and package manager | Bun, pinned `>=1.4.2` in `engines`; CI pins the exact version | Bun workspaces, `bun.lock` committed. The maintainer has 1.3.5 and must upgrade (`bun upgrade`): 1.4 is needed for child-process stream backpressure, the `Bun.spawn` `terminal` (PTY) option and `--no-orphans` [6] |
| Language | TypeScript 7 (`tsc`, native compiler) [23] | `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, same as dipsaus-ai |
| Typecheck | `tsc -b` over project references | One pass over all packages |
| Lint | oxlint 1.x [24] | `--deny-warnings`; boundary rules live here |
| Format | oxfmt `--check` [25] | 0.x; fall back to Prettier if it misbehaves |
| Test | `bun test` | No extra runner. `describe`/`it`/`expect` subset only. Ink components tested with `ink-testing-library` (works with Ink 8 under `bun test`: to confirm in DIPO-6) |
| Build | `bun build --compile --target=bun-<os>-<arch>` | darwin-arm64, darwin-x64, linux-x64, linux-arm64 |
| Schemas | zod 4 | JSON Schema export (`z.toJSONSchema`) available for non-TS consumers |

The single verify command, run locally, by workers and in CI:

```sh
bun run verify
# = bun run format:check && bun run lint && bun run typecheck && bun test
```

`verify` exists from the first commit (0003). Every story's verify step calls exactly this. A compile smoke test (`bun run build` for every release target, then `<bin> --version` on each target CI can run) is added to CI, not to `verify`, to keep `verify` fast.

## Consequences

- One language for engine, contract and every client. Contract changes are type errors in all packages at once.
- Releases are per-platform binaries of roughly 60 to 100 MB, mostly the Bun runtime. Acceptable for a developer tool; noted as a known cost.
- The project depends on a young Bun 1.4 line. Mitigations: pin Bun in CI, keep runtime-specific code in `engine/src/platform`, and track Bun releases before upgrading.
- Bun touchpoints outside the platform module: `bun:test`, Bun workspaces and `bun.lock`, and `bun build --compile`. A move to Node replaces these three plus the platform module.
- Vendor concentration: Anthropic owns the runtime (Bun), the worker CLI (Claude Code) and the subscription terms. Mitigation: the platform module and the Worker adapter keep runtime and worker vendor separately swappable.
- On macOS `bun:sqlite` uses the system SQLite, so SQLite extensions are out unless `setCustomSQLite` is used. The schema (DIPO-4) should not depend on extensions.
- Contributors need Bun installed. Node-only contributors cannot run the test suite without it.
- `dipsaus-ai` uses vitest; this repo uses `bun test`. Shared conventions stop at TS config and lint.
- DIPO-2 to DIPO-7 can now assume TypeScript, zod, Bun APIs and this layout.

## Open questions for the maintainer

1. **Bun over Node — answered 2026-10-10: Bun.** The maintainer accepts the risks below. Original question: accept Bun's single-vendor governance and the fresh 1.4 Rust port in exchange for built-in SQLite and single-binary builds? With Bun, Anthropic owns the runtime, the worker CLI and the subscription terms; the platform module and Worker adapter keep runtime and worker separately swappable. The alternative is Node 24 with `better-sqlite3` and `npm i -g` distribution.
2. **TUI library — answered 2026-10-10: Ink.** DIPO-6 confirms with a small prototype that Ink runs on Bun and inside the compiled binary; OpenTUI is the fallback only if that fails. Original question: confirm Ink as default with the final choice in DIPO-6, or decide now (Ink or OpenTUI)?
3. **Binary and package name — distribution answered 2026-10-10:** binaries on GitHub Releases first, a Homebrew tap later; npm not planned. Command name: **`dipo`** (free on npm and Homebrew on 2026-10-10). Original question: what is the command called (for example `dipo`)? Published to npm as well as GitHub Releases, or binaries only? Homebrew tap later?
4. **Formatter — answered 2026-10-10: oxfmt, version pinned**, Prettier as fallback. Original question: accept oxfmt (0.x), or use Prettier for stability?
5. **Windows — answered 2026-10-10: out of scope for now.** Windows users are pointed to WSL; runtime-specific code stays in the platform module so native Windows support can be added later. Original question: out of scope for now (macOS and Linux only), as assumed here?

## Sources

1. Bun blog, "Rewriting Bun in Rust", 2026-07-08. https://bun.com/blog/bun-in-rust
2. Node.js docs v26.11.1, Single executable applications. https://nodejs.org/api/single-executable-applications.html
3. Node.js docs v26.11.1, SQLite (stability 1.2, release candidate since 25.7). https://nodejs.org/api/sqlite.html
4. OpenClaw docs, Node compatibility (node:sqlite NUL truncation, fixed in 24.16 / 26.1). https://docs.openclaw.ai/install/node-compatibility.md
5. CVE-2026-58041, node:sqlite stale iterator. https://stack.watch/vuln/CVE-2026-58041/
6. Bun blog, "Bun 1.4", 2026-08-20 (current v1.4.2, 2026-09-05). https://bun.com/blog/bun-v1.4
7. Bun docs, Single-file executables. https://bun.com/docs/bundler/executables
8. npm registry, `ink` latest 8.0.0, `engines.node >=22`. https://registry.npmjs.org/ink/latest
9. heise, "React in the Terminal: Ink 7.0 fundamentally revises input handling". https://heise.de/-11249949
10. npm registry, `@opentui/core` 0.5.17, `engines: bun >=1.3.0, node >=26.4.0`. https://registry.npmjs.org/@opentui/core/latest
11. OpenTUI docs, Runtime and platform support. https://opentui.com/docs/getting-started/runtime-support ; repository README (OpenCode production use) https://github.com/anomalyco/opentui
12. Claude Code docs, Run Claude Code programmatically (stream-json, SIGINT/SIGTERM behavior). https://code.claude.com/docs/en/headless
13. Bun docs, SQLite. https://bun.com/docs/runtime/sqlite
14. Bun blog, "Bun is joining Anthropic", 2025-12-02. https://bun.com/blog/bun-joins-anthropic
15. Go release history (1.27.0 on 2026-08-19, 1.27.2 on 2026-10-08). https://go.dev/doc/devel/release
16. modernc.org/sqlite package docs. https://pkg.go.dev/modernc.org/sqlite
17. Bubble Tea v2 package docs. https://pkg.go.dev/github.com/charmbracelet/bubbletea/v2
18. Debian NEW queue review, golang-charm-bubbletea-v2 2.0.6, 2026-04-30. https://dfsg-new-queue.debian.org/reviews/golang-charm-bubbletea-v2/2.0.6-1/6763fcf5
19. crates.io API, `ratatui` (0.30.2, 2026-06-19). https://crates.io/api/v1/crates/ratatui
20. crates.io API, `rusqlite` (0.40.2, 2026-08-08). https://crates.io/api/v1/crates/rusqlite
21. typeshare (Rust/Go to TypeScript type generation). https://github.com/1Password/typeshare
22. npm registry, `@anthropic-ai/claude-agent-sdk`. https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest
23. Visual Studio Magazine, "TypeScript 7 arrives", 2026-07-08; npm `typescript` latest 7.0.2. https://visualstudiomagazine.com/articles/2026/07/08/typescript-7-arrives-to-rock-vs-code-with-go-powered-speed.aspx
24. npm registry, `oxlint` latest 1.87.0. https://registry.npmjs.org/oxlint/latest
25. npm registry, `oxfmt` latest 0.72.0. https://registry.npmjs.org/oxfmt/latest
