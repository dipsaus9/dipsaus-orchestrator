---
id: DIPO-312
title: >-
  Refuse delivered parts that change tool configuration, widen secret file
  names, scrub stored text
status: Refined
assignee: []
created_date: '2026-10-22 21:00'
updated_date: '2026-10-22 21:00'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/box/parts.ts
  - packages/engine/src/context/secrets.ts
  - packages/engine/src/backlog/runner.ts
  - packages/engine/src/backlog/lane/ops.ts
  - packages/engine/src/worktree/claim.ts
  - packages/engine/src/ingest/output.ts
  - packages/engine/src/log/logger.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/test/box/
  - packages/engine/test/backlog/
  - packages/engine/test/context/
  - packages/engine/test/ingest/
  - packages/engine/test/log/
type: enhancement
ordinal: 297000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a part a box worker delivers can no longer add, change or delete a file that configures a tool dipo itself runs on checkouts of the repository; dipo refuses a Backlog CLI status change whose configuration or task file asks the CLI to run a command; the part scan knows the common credential file names it misses today; and stored tool lines and log messages hold no credential-shaped value.

Context:
- 0021 section 14: dipo never runs a tool on configuration from a directory the worker can write. DIPO-270 runs story-level Backlog CLI calls in dipo's own copy, built from git objects.
- After a story merges, dipo runs the Backlog CLI and Bun in checkouts of the base: the story index (`stories/read.ts`), the gate store, and the backlog lane, whose status edits run in `backlog/lane/ops.ts`. A configuration file a story added is read there once it is on the base, and today only the reviewer and the maintainer stand in the way.
- The protected-file check of a part (`protectedKind` in `packages/engine/src/box/parts.ts`) covers `.git`, `backlog/`, `.dipo/`, `.github/`, the Claude settings, `.gitattributes`, `.gitmodules` and links. It covers no other tool configuration.
- The secret-name list (`isSecretPath` and `isSecretPartPath` in `packages/engine/src/context/secrets.ts`) misses several common credential files.
- `privacy.storeCommandBodies` defaults to true (`config/schema.ts`), while the header of `ingest/output.ts` says it is opt-in. Log messages and error strings are not scrubbed, so a git error can hold a remote URL with credentials.
- `.yarnrc.yml` is left out of criterion 3 on purpose: Yarn projects commit it as plain config, and the content scan already catches tokens in it.

```dipo
branch: "DIPO-312/protect-tool-config-and-scrub"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `protectedKind` also returns a kind for every file that configures a tool dipo runs on checkouts of the repository: the Backlog CLI's configuration in every place Backlog.md 1.53 reads it (not only `backlog/config.yml`), the Bun runtime's project configuration, and Claude Code's MCP server configuration. Each entry has a comment naming the tool and the documentation that says it reads the file. A part that adds, changes or deletes one parks with the protected-file cause.
- [ ] #2 Before any Backlog CLI call that changes a story's status, dipo checks the Backlog configuration and the task file the call runs with. This holds in its own copy and in the base and lane checkouts. When either defines a command for the CLI to run on that change, dipo refuses the call and raises an `engine.notice` naming the story and the file.
- [ ] #3 `isSecretPath` and `isSecretPartPath` also match these credential files, each covered by a test: Claude's `.credentials.json`; cloud CLI credentials (`application_default_credentials.json`, `client_secret*.json`); package-registry credentials (`.pypirc`); `.vault-token` and `.dev.vars`; infrastructure state and variable files (`*.tfstate`, `*.tfvars`); `kubeconfig`; `*.p8` and `*.ppk` keys.
- [ ] #4 The header of `ingest/output.ts` states the real default of `privacy.storeCommandBodies`. A stored tool line has every value that matches a `SECRET_PATTERNS` shape, and every URL that holds user information, replaced by `[redacted]`.
- [ ] #5 The logger replaces the same shapes in a line's message and error strings with `[redacted]`. A test shows this with a git error that holds a credentialed remote URL.
- [ ] #6 Tests cover each case: the protected kinds and the status-change refusal, in `packages/engine/test/box/` and `packages/engine/test/backlog/`; the secret names, in `packages/engine/test/context/`; stored lines and log lines, in `packages/engine/test/ingest/` and `packages/engine/test/log/`. `bun run verify` passes.
<!-- AC:END -->
