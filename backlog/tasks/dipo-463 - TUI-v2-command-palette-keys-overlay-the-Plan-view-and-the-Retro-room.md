---
id: DIPO-463
title: 'TUI v2: command palette, keys overlay, the Plan view and the Retro room'
status: Parked
assignee: []
created_date: '2026-11-06 14:12'
updated_date: '2026-11-08 09:36'
labels:
  - 'tier:M'
milestone: m-6
dependencies:
  - DIPO-457
  - DIPO-449
  - DIPO-453
references:
  - packages/tui/src/settings.tsx
  - packages/tui/src/keys.ts
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/screens/09-palette.txt
  - docs/design/tui-v2/screens/13-keys-overlay.txt
  - docs/design/tui-v2/screens/07-plan.txt
  - docs/design/tui-v2/screens/06-retro.txt
  - docs/design/tui-v2/designs/dipo-ux-spec.html
priority: medium
type: feature
ordinal: 436000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want a command palette and a keys overlay built from the same registry as the footer, so that I can find every action and setting without remembering keys.

Step 7. : and ctrl-k open a fuzzy palette scoped to the focused item first, with disabled rows saying why. ? opens the keys overlay. Stopping a run is a palette row only (no key) and asks to confirm. Settings and privacy move into the palette; its rows show their keys (p park, z expand stream, O offices). The Retro room (room 4) and the Plan view (P) are mounted in the Frame for DIPO-453 and DIPO-449, laid out as screens/06-retro.txt and screens/07-plan.txt.

Design: docs/design/tui-v2/ (spec.md, screens/, keymap.json, roles.json, migration.md). The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text. Where spec.md's Maintainer decisions (2026-11-06) differ from the HTML, the text files win.

```dipo
branch: "DIPO-463/tui-v2-palette"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) palette fuzzy match and scoping order"
    - kind: "automated"
      check: "(unit) keys overlay lists the same keys as the footer registry"
    - kind: "manual"
      check: "Open the palette with : and type pa, then open ? on a merge item, next to designs/dipo-ux-spec.html S5 and S9"
      expect: "Both overlays match the HTML preview side by side, with the body behind them in shade"
park:
  reason: "verify-failing"
  from: "In Review"
  note: "required checks were red on 2 pushed heads (the CI cap is 2). Required check ci-ok failed on the pushed head.\nJob: ci-ok\nFailing steps: none found\nLink: https://github.com/dipsaus9/dipsaus-orchestrator/actions/runs/42467570702/job/128691582859\nLocations:\n- none found\nLast log lines:\nno log: it failed because other jobs of its workflow run failed (actionlint).\nBudget: 65 turns used, 135 left; 16 minutes used, 74 left; 267,652 tokens used, 532,348 left.\n\nRequired check actionlint failed on the pushed head.\nJob: actionlint\nFailing steps: Download actionlint and check it against the pinned SHA-256\nLink: https://github.com/dipsaus9/dipsaus-orchestrator/actions/runs/42467570702/job/128690591156\nLocations:\n- none found\nLast log lines:\n##[group]Run archive=\"actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz\"\n^[[36;1marchive=\"actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz\"^[[0m\n^[[36;1mcurl -fsSL --proto '=https' --tlsv1.2 -o \"$RUNNER_TEMP/$archive\" \\^[[0m\n^[[36;1m  \"https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT_VERSION/$archive\"^[[0m\n^[[36;1mecho \"$ACTIONLINT_SHA256  $RUNNER_TEMP/$archive\" | sha256sum --check --strict^[[0m\n^[[36;1mtar -xzf \"$RUNNER_TEMP/$archive\" -C \"$RUNNER_TEMP\" actionlint^[[0m\nshell: /usr/bin/bash -e {0}\nenv:\n  ACTIONLINT_VERSION: 1.7.12\n  ACTIONLINT_SHA256: 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8\n##[endgroup]\ncurl: (22) The requested URL returned error: 504\n##[error]Process completed with exit code 22.\nBudget: 65 turns used, 135 left; 16 minutes used, 74 left; 267,652 tokens used, 532,348 left.\n\nRequired check Analyze (javascript-typescript) failed on the pushed head.\nJob: Analyze (javascript-typescript)\nFailing steps: Initialize CodeQL\nLink: https://github.com/dipsaus9/dipsaus-orchestrator/actions/runs/42467567561/job/128690527087\nLocations:\n- codeql-action/v4/lib/entry-points.js:114414:23\n- codeql-action/v4/lib/entry-points.js:114317:28\nLast log lines:\n[dipo: showing the last 39 of 66 output lines.]\n  CODEQL_ACTION_JOB_RUN_UUID: 854b4fcf-254b-4524-9fc7-3a58f8e7d39b\n  CODEQL_PROXY_HOST: \n  CODEQL_PROXY_PORT: \n  CODEQL_PROXY_CA_CERTIFICATE: \n  CODEQL_PROXY_URLS: \n##[endgroup]\nExisting job run UUID is 854b4fcf-254b-4524-9fc7-3a58f8e7d39b.\n##[group]Setup CodeQL tools\n[command]/usr/bin/tar --version\ntar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by John Gilmore and Jay Fenlason.\nFound gnu tar version 1.35.\nFound 39 overlay-base databases in the Actions cache.\nFound overlay databases for the following CodeQL versions in the Actions cache: 2.27.4, 2.27.3\nUsing CodeQL version 2.27.4 since this is the highest enabled version that has a cached overlay-base database.\nDid not find CodeQL tools version 2.27.4 in the toolcache.\nSelected the per-language CodeQL bundle for 'javascript'.\nUsing CodeQL CLI version 2.27.4 sourced from https://github.com/github/codeql-action/releases/download/codeql-bundle-v2.27.4/codeql-bundle-javascript-linux64.tar.zst .\nDeleted the CodeQL tools at '/opt/hostedtoolcache/CodeQL/2.27.3' from the toolcache to free up disk space.\nDownloading CodeQL tools from https://github.com/github/codeql-action/releases/download/codeql-bundle-v2.27.4/codeql-bundle-javascript-linux64.tar.zst . This may take a while.\nStreaming the extraction of the CodeQL bundle.\n##[warning]Failed to download and extract CodeQL bundle using streaming with error: Failed to download CodeQL bundle from https://github.com/github/codeql-action/releases/download/codeql-bundle-v2.27.4/codeql-bundle-javascript-linux64.tar.zst. HTTP status code: 504.\n##[warning]Falling back to downloading the bundle before extracting.\nUnexpected HTTP response: 504\nWaiting 12 seconds before trying again\nUnexpected HTTP response: 504\nWaiting 14 seconds before trying again\n##[error]Unable to download and extract CodeQL CLI: Unexpected HTTP response: 504\n\nDetails: Error: Unexpected HTTP response: 504\n    at codeql-action/v4/lib/entry-points.js:114414:23\n    at Generator.next (<anonymous>)\n    at fulfilled (codeql-action/v4/lib/entry-points.js:114317:28)\n    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)\nBudget: 65 turns used, 135 left; 16 minutes used, 74 left; 267,652 tokens used, 532,348 left."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 : and ctrl-k open a palette listing the focused item's actions first, then settings, then navigation, each with its key
- [x] #2 A disabled action stays listed with its reason
- [x] #3 ? shows the keys of the focused item, movement and global keys, from the registry
- [x] #4 Privacy settings are reached through the palette and keep their yes/no confirmation
- [x] #5 The Retro room (room 4) and the Plan view (P) are slots in the Frame that DIPO-453 and DIPO-449 fill
- [x] #6 The palette and the keys overlay match the HTML preview's S5 and S9, and the Retro room and the Plan view follow S2c and S2d. The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text
- [x] #7 Stopping a run is reached only through the palette and asks to confirm
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-08 09:36 UTC: verify-failing
- Detail: required checks were red on 2 pushed heads (the CI cap is 2). Required check ci-ok failed on the pushed head.
- Run: run_01M6X6ZDB52E3W5Z51THYHVQHY
- Criteria met: 7 of 7 (as the worker reported them)
- Loops: 0 of 5; CI attempts: 2 of 2
- Review rounds: 2, failed 1 of 3
- Budget used: 267,652 of 800,000 tokens; 65 of 200 turns; 17 of 90 minutes
- Last good commit: 979609413b3667c0234e4e41582ac90c48a0997f
<!-- SECTION:NOTES:END -->
