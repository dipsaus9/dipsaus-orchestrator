---
id: DIPO-214
title: Follow more script runners when checking the verify tools
status: In Review
assignee: []
created_date: '2026-10-19 14:43'
updated_date: '2026-10-19 21:29'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/verify-tools.ts
  - packages/engine/test/workers/verify-tools.test.ts
priority: low
type: feature
ordinal: 214000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the verify tools check (DIPO-173) also follows a verify written with pnpm, yarn, npx or bun's script shorthand, so such a verify cannot pass the check while it checks nothing.

Context: review of DIPO-173 (PR #223). verify-tools.ts follows only `bun run <script>` and `npm run <script>` through the root package.json scripts. A verify such as `pnpm verify`, `yarn verify`, `bun verify` or `npx oxfmt --check` is not followed, so the programs it starts are never checked and the check passes silently.

```dipo
branch: "DIPO-214/verify-tools-more-runners"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a verify written as pnpm run, pnpm <script>, yarn run, yarn <script>, bun <script> and npx <bin> resolves to the same node_modules/.bin programs as bun run does, and an unreachable interpreter is refused for each"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 verify-tools.ts follows pnpm run <script>, pnpm <script>, yarn run <script>, yarn <script> and bun <script> through the root package.json scripts, and checks npx <bin> as the node_modules/.bin program it names
- [x] #2 A shorthand word that is not a package.json script and not a .bin program is left alone, as today, and so is a word that is one of bun's own commands (test, build, install, add, x and the others bun runs before a script of the same name), so `bun test` with a test script is not followed; tests in packages/engine/test/workers/verify-tools.test.ts cover each runner and the bun test case
<!-- AC:END -->
