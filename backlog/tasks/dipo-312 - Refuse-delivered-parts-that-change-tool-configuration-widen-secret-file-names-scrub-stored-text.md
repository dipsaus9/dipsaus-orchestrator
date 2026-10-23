---
id: DIPO-312
title: >-
  Refuse delivered parts that change tool configuration, widen secret file
  names, scrub stored text
status: Done
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-23 12:22'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - '- packages/engine/src/box/parts.ts'
  - docs/decisions/0021-worker-isolation.md
  - packages/daemon/src/foreground.ts
  - packages/engine/src/backlog/lane/ops.ts
  - packages/engine/src/backlog/runner.ts
  - packages/engine/src/box/collisions.ts
  - packages/engine/src/box/parts.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/src/context/secrets.ts
  - packages/engine/src/ingest/output.ts
  - packages/engine/src/log/logger.ts
  - packages/engine/src/worktree/claim.ts
  - packages/engine/test/backlog/
  - packages/engine/test/backlog/front-matter.test.ts
  - packages/engine/test/backlog/status-command.test.ts
  - packages/engine/test/box/
  - packages/engine/test/box/parts.test.ts
  - packages/engine/test/context/
  - packages/engine/test/context/secrets.test.ts
  - packages/engine/test/ingest/
  - packages/engine/test/ingest/command-bodies.test.ts
  - packages/engine/test/log/
  - packages/engine/test/log/logger.test.ts
  - packages/engine/test/run/parts-commit.test.ts
type: enhancement
ordinal: 297000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a part a box worker delivers can no longer add, change or delete a file that configures a tool dipo itself runs on checkouts of the repository; dipo refuses a Backlog CLI status change whose configuration or task file asks the CLI to run a command; the part scan knows the common credential file names; and stored tool lines and log messages hold no credential-shaped value.

Context:
- 0021 section 14: dipo never runs a tool on configuration from a directory the worker can write. DIPO-270 runs story-level Backlog CLI calls in dipo's own copy, built from git objects.
- After a story merges, dipo runs the Backlog CLI and Bun in checkouts of the base: the story index (`stories/read.ts`), the gate store, and the backlog lane, whose status edits run in `backlog/lane/ops.ts`. Criterion 2 covers those checkouts too.
- The protected-file check of a part (`protectedKind` in `packages/engine/src/box/parts.ts`) gains the entries in criterion 1.
- The secret-name list (`isSecretPath` and `isSecretPartPath` in `packages/engine/src/context/secrets.ts`) gains the names in criterion 3.
- `privacy.storeCommandBodies` defaults to true (`config/schema.ts`), and criterion 4 makes the header of `ingest/output.ts` say so. Stored tool lines, log messages and error strings get the scrubbing of criteria 4 and 5.
- `.yarnrc.yml` is left out of criterion 3 on purpose: Yarn projects commit it as plain config, and the content scan already catches tokens in it.

```dipo
branch: "DIPO-312/protect-tool-config-and-scrub"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `protectedKind` also returns a kind for every file that configures a tool dipo runs on checkouts of the repository: the Backlog CLI's configuration in every place Backlog.md 1.53 reads it (not only `backlog/config.yml`), the Bun runtime's project configuration, and Claude Code's MCP server configuration. Each entry has a comment naming the tool and the documentation that says it reads the file. A part that adds, changes or deletes one parks with the protected-file cause.
- [x] #2 Before any Backlog CLI call that changes a story's status, dipo checks the Backlog configuration and the task file the call runs with. This holds in its own copy and in the base and lane checkouts. When either defines a command for the CLI to run on that change, dipo refuses the call and raises an `engine.notice` naming the story and the file.
- [x] #3 `isSecretPath` and `isSecretPartPath` also match these credential files, each covered by a test: Claude's `.credentials.json`; cloud CLI credentials (`application_default_credentials.json`, `client_secret*.json`); package-registry credentials (`.pypirc`); `.vault-token` and `.dev.vars`; infrastructure state and variable files (`*.tfstate`, `*.tfvars`); `kubeconfig`; `*.p8` and `*.ppk` keys.
- [x] #4 The header of `ingest/output.ts` states the real default of `privacy.storeCommandBodies`. A stored tool line has every value that matches a `SECRET_PATTERNS` shape, and every URL that holds user information, replaced by `[redacted]`.
- [x] #5 The logger replaces the same shapes in a line's message and error strings with `[redacted]`. A test shows this with a git error that holds a credentialed remote URL.
- [x] #6 Tests cover each case: the protected kinds and the status-change refusal, in `packages/engine/test/box/` and `packages/engine/test/backlog/`; the secret names, in `packages/engine/test/context/`; stored lines and log lines, in `packages/engine/test/ingest/` and `packages/engine/test/log/`. `bun run verify` passes.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done 2026-10-23 (maintainer session): built outside dipo, reviewed twice by separate agents. The first review found four bypasses of the Backlog checks and five advisories, all fixed; the second review passed. Extended by the maintainer: every Backlog CLI call (not only status changes) is refused when a Backlog file's front matter is not plain YAML, and a folder without its own project configuration is refused (except backlog --version). Kept strict by the maintainer's choice. Branch DIPO-312/refuse-tool-config-parts instead of the declared protect-tool-config-and-scrub. 0021 line approved.
<!-- SECTION:NOTES:END -->
