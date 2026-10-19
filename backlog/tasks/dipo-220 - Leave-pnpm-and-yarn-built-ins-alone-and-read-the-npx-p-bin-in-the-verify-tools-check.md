---
id: DIPO-220
title: >-
  Leave pnpm and yarn built-ins alone and read the npx -p bin in the verify
  tools check
status: Refined
assignee: []
created_date: '2026-10-19 23:02'
updated_date: '2026-10-19 23:03'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/workers/claude-cli/verify-tools.ts
  - packages/engine/test/workers/verify-tools.test.ts
priority: low
type: bug
ordinal: 220000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the verify tools check no longer follows a pnpm or yarn built-in such as `pnpm install` through a root script of the same name, and checks the program `npx -p <pkg> <cmd>` starts, so neither gives a false refusal nor leaves a bin unchecked.

Context: known limits from the delivery of DIPO-214. In packages/engine/src/workers/claude-cli/verify-tools.ts, scriptOf keeps bun's own commands out of the shorthand through BUN_COMMANDS, but has no such set for pnpm and yarn: `pnpm install` or `yarn install` in a repository with a root script named install is followed through that script, and the programs of the script are checked instead of the runner, which can refuse a run for a program verify never starts. programOf takes the first word after npx that is not a flag, so `npx -p oxfmt oxfmt --check` and `npx --package oxfmt oxfmt` take the package name as the bin. `npx --package=oxfmt oxfmt` already checks oxfmt, since the option is one word. pnpm and yarn run the test and start scripts for `pnpm test` and `yarn test`, so those stay followed.

```dipo
branch: "DIPO-220/verify-tools-pnpm-yarn-builtins"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) pnpm install, pnpm add, yarn install and yarn add with root scripts named install and add resolve to the runner, not to the script's programs"
    - kind: "automated"
      check: "(unit) npx -p oxfmt oxfmt --check, npx --package oxfmt oxfmt and npx -p a -p b oxfmt check oxfmt from node_modules/.bin"
    - kind: "automated"
      check: "(unit) pnpm test and yarn test with a root test script are still followed through it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 verify-tools.ts holds a PNPM_COMMANDS and a YARN_COMMANDS set next to BUN_COMMANDS, with at least add, audit, create, dlx, exec, i, init, install, link, outdated, pack, patch, publish, rebuild, remove, rm, unlink, up, update and why for pnpm and add, audit, cache, config, create, dlx, exec, info, init, install, link, outdated, pack, publish, remove, unlink, up, upgrade and why for yarn; a shorthand word in the runner's set is not followed through a root script of that name, and the runner itself is checked
- [ ] #2 programOf skips the value of npx's -p and --package options, so `npx -p oxfmt oxfmt --check`, `npx --package oxfmt oxfmt` and `npx -p a -p b oxfmt` check oxfmt from node_modules/.bin, as `npx --package=oxfmt oxfmt` does today
- [ ] #3 Tests in packages/engine/test/workers/verify-tools.test.ts cover each case of criteria 1 and 2, and show `pnpm test` and `yarn test` with a root test script still followed through it
<!-- AC:END -->
