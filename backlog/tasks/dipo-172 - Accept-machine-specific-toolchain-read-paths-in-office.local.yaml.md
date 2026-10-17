---
id: DIPO-172
title: Accept machine-specific toolchain read paths in office.local.yaml
status: Refined
assignee: []
created_date: '2026-10-17 17:00'
updated_date: '2026-10-17 17:00'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/config/
  - packages/engine/test/config/
  - packages/engine/schema/
  - packages/engine/scripts/write-schema.ts
  - packages/engine/src/workers/claude-cli/
  - packages/engine/test/workers/
  - .dipo/office.yaml
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: medium
type: feature
ordinal: 161000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a maintainer adds a machine-specific toolchain directory such as ~/.nvm/versions/node to the worker sandbox's read list in .dipo/office.local.yaml, on top of the committed list, and a run is refused when an npm auth token sits in a file that list makes readable.

Context: finding 12 of the DIPO-115 cutover and the PR #159 review advisory. oxfmt and oxlint need node, which lives under ~/.nvm/versions/node on the maintainer's machine, so the committed .dipo/office.yaml now lists it in sandbox.toolchainReadPaths. That path is specific to one machine, but office.local.yaml accepts only timeouts.*, privacy.* and retention.* (LOCAL_ALLOWED_KEYS in packages/engine/src/config/schema.ts; 0017 section 5, Precedence), and lists replace instead of merging. The maintainer decided on 2026-10-17 (option A): sandbox.toolchainReadPaths is accepted in office.local.yaml and its entries are added to the committed list. Every added configuration key bumps the file's version with an in-memory migration (0017 amendment of 2026-10-12); DIPO-133, DIPO-139, DIPO-164, DIPO-165 and DIPO-116 also take office config versions, so this story takes the next free one when it starts.

The advisory: `npm config set --global` with an auth token under nvm writes it to npm's global config file below the node install (~/.nvm/versions/node/<v>/etc/npmrc), which the worker can read once that directory is a read path. Tokens belong in the user-level ~/.npmrc, which the sandbox cannot read. The check reads only whether an auth key is present and never logs or stores a value.

Delivery: this story changes .dipo/office.yaml, which a dipo worker cannot write (denyWrite on <worktree>/.dipo, and the backstop parks any change there), so it is delivered by hand, not by dipo run. Before it merges, the maintainer adds the nvm path to their own .dipo/office.local.yaml, or worker verify fails again on this repository. The 0017 note goes in only with the maintainer's approval on the PR.

```dipo
branch: "DIPO-172/local-toolchain-read-paths"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a local sandbox.toolchainReadPaths adds to the committed list without duplicates, and a local sandbox.allowRead fails validation naming the key"
    - kind: "automated"
      check: "(unit) a fixture node install under a read path whose etc/npmrc holds _authToken refuses the run naming the file; the same install without the key passes"
    - kind: "manual"
      check: "(live) with ~/.nvm/versions/node only in the maintainer's office.local.yaml, run a story on this repository"
      expect: "the worker runs oxfmt and oxlint inside its sandbox; no env: node error in its output"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 .dipo/office.local.yaml accepts sandbox.toolchainReadPaths in the next free office config version with its in-memory migration; its entries are added to the committed list (or the default), each path once; any other sandbox key in the local file stays a validation error that names the key
- [ ] #2 The worker's sandbox read list and PATH planning in packages/engine/src/workers/claude-cli/ use the merged list, and localOverrideKeys names sandbox.toolchainReadPaths when the local file sets it
- [ ] #3 ~/.nvm/versions/node is removed from the committed .dipo/office.yaml, and the file's comment shows the office.local.yaml lines that add it on a machine with node under nvm
- [ ] #4 The PR proposes a dated note in docs/decisions/0017-testing-strategy-and-configuration.md (Amendments, section 5 Precedence): sandbox.toolchainReadPaths is accepted in office.local.yaml and adds to the committed list (maintainer decision 2026-10-17, option A), for the maintainer's approval
- [ ] #5 A launch check refuses a run when npm's global config file of a node install under a toolchain read path, or a .npmrc at the root of a read path, holds an auth key (_authToken, _auth or _password); the refusal names the file and says to keep tokens in ~/.npmrc, and no token value is logged or stored
- [ ] #6 packages/engine/schema/office.schema.json is rewritten by bun packages/engine/scripts/write-schema.ts, and the config tests that pin the version and the local keys are updated
<!-- AC:END -->
