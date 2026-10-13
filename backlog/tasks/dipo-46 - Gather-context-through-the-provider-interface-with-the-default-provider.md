---
id: DIPO-46
title: Gather context through the provider interface with the default provider
status: Done
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-13 07:30'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-26
  - DIPO-29
references:
  - packages/engine/src/context/
  - packages/engine/src/db/migrations/
  - packages/engine/test/context/
  - packages/engine/src/platform/glob.ts
  - packages/engine/src/db/schema.ts
documentation:
  - docs/decisions/0007-state-database.md
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0014-worker-prompt-assembly.md
priority: high
type: feature
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the engine has the `ContextProvider` interface and a default provider that returns, for a story, its scope files, inputs, matching components of an optional component map and neighbouring tests, within budgets set by the project size class.

Context: the codegraph backend is M1. References: 0014 section 9 (interface, rules, default provider steps 1 to 4), section 4 (size classes from `git ls-files`, per-section and per-item budgets, deterministic line-boundary truncation with marker); 0010 section 10 (component map file and validation); research ideas 23 and 26; 0007 section 4 (`context_packs`).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP` (testkit falls back to `/tmp` when it is unset).

```dipo
branch: "DIPO-46/gather-context-through-provider"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) size class boundaries; truncation marker text; determinism across two runs."
    - kind: "automated"
      check: "(integration) a temp repo with a component map gives the expected components and neighbours."
    - kind: "automated"
      check: "(unit) an invalid component map with a cycle is reported."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `ContextProvider`, `ContextRequest` and `ContextPack` match 0014 section 9; providers return items, never prompt prose.
- [x] #2 The size class is computed from `git ls-files` count: S under 150, M under 500, L under 5,000, XL above.
- [x] #3 Scope files under the per-item cap are included in full, larger ones as head plus marker; a directory becomes a breadth-first list of at most 200 entries; a missing path is marked new with its parent's file list.
- [x] #4 Input files are pre-fetched within the `inputs` budget, the path list is never cut, and URLs are listed only.
- [x] #5 When `.dipo/components.yaml` exists it is validated (names, `depends_on` exists, no cycles, unmatched globs warn), and components matching the scope plus direct neighbours appear with name, purpose and a capped file list.
- [x] #6 Tests next to scope files by name are listed, not inlined.
- [x] #7 Truncation cuts on line boundaries and leaves the 0014 marker naming the path and line.
- [x] #8 The same inputs produce the same pack bytes, and a migration adds `context_packs` with head SHA and blob ids.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S30 (DIPO-15). Before cutover: built by hand-run agents.

Added refs: packages/engine/src/platform/glob.ts, because 0010 section 10 puts Bun.Glob for component globs behind the platform module; packages/engine/src/db/schema.ts, because a new migration is registered in its MIGRATIONS list.

Implemented in packages/engine/src/context/: ContextProvider, ContextRequest and ContextPack as in 0014 section 9, with structured item reasons (scope-file, scope-dir, scope-new, component, test, input-*) and no prose. Additive to the 0014 shape: ContextRequest carries inputsBudget (gather keeps its single context budget), ContextPack carries an inputs part (full path list plus pre-fetched items) and blobIds, provenance carries notes (component map warnings and errors, skipped backends). Providers are built per workspace (createDefaultProvider({ workspace })), since gather takes no workspace in 0014. gitWorkspace reads file lists and HEAD through the office git queue with hardened calls and never reads a symbolic link or a path outside the work tree. Component neighbours are direct both ways (depends-on and depended-on-by); a component's purpose comes from an optional purpose key. Directory scope lists and component file lists are also capped at the 4,000 character item cap with the marker. Migration 5 adds context_packs (office_id, worktree, head_sha, blob_ids JSON, provider, pack_sha256, built_at), one row per worktree; recordContextPack, contextPackOf and forgetContextPack use it. gatherContext runs the default first and lets an optional backend fill the rest of the budget, skipping one that is not ready with a provenance note.

PR #59 review fixes: (1) the provider and the git workspace never read a file whose name matches a 0008 secret pattern (.env*, .npmrc, .netrc, _netrc, .git-credentials, *.pem, id_rsa/id_dsa/id_ecdsa/id_ed25519*; secrets.ts); such scope or input files are listed with content `secret`, empty text and no blob id. (2) gitWorkspace.readFile checks realpath(file) is under realpath(work tree) after lstat and refuses otherwise (a directory swapped for a link). (3) gatherContext catches errors from backend status, prepare and gather and returns the default pack with the note `backend <id> skipped, error: <message>`. (4) Directory and component listings use their own truncation marker without a file line (truncateListing); a cut listing's `shown` counts the entries kept. (5) pack.ts documents that blob ids hash raw work-tree bytes, so they can differ from `git ls-files -s` under filters or eol conversion.

Migration renumbered to 7 (0007-context-packs.ts) after DIPO-34 (5, backlog_journal) and DIPO-32 (6, backlog_mirror) merged to main; the note above that says Migration 5 now reads as Migration 7.

Hardening (PR #59): isSecretPath checks every path segment, so anything under a .env*, .ssh, .aws, .gnupg, .docker or .kube directory is secret; added credential names (credentials, credentials.json, secrets.yaml/yml/json, service-account*.json, .pgpass, .dockercfg, *.key, *.p12, *.pfx, *.keystore, *.jks). Workspace reads open with O_NOFOLLOW and check the open descriptor: a regular file with nlink 1 whose dev/ino match the lstat of its realpath under the work tree. Anything else is listed with content "refused" and a refusal reason (symbolic link, hard link, secret path, resolves outside the work tree, changed while being read).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Context through the provider interface: migration 7 context_packs; default provider builds a deterministic pack from the story's scope, inputs, component map neighbours and nearby tests within the 0014 budgets with truncation markers; file lists and HEAD through the hardened office git queue; secret paths (any .env*, .ssh, .aws, .gnupg, .docker, .kube segment and common credential names) are listed but never read; reads refuse symlinks, hard links and swapped files (O_NOFOLLOW, fstat dev/ino, realpath under root); an optional backend is skipped with a note when not ready or failing; blob ids recorded per pack. Reviewer pass.
<!-- SECTION:FINAL_SUMMARY:END -->
