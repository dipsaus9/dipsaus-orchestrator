---
id: DIPO-457
title: >-
  TUI v2 foundations: colour roles, one frame, one action registry and a
  multi-line input
status: Done
assignee: []
created_date: '2026-11-06 14:11'
updated_date: '2026-11-07 10:43'
labels:
  - 'tier:M'
milestone: m-6
dependencies:
  - DIPO-443
references:
  - packages/tui/src/colour.tsx
  - packages/tui/src/screen.tsx
  - packages/tui/src/keys.ts
  - packages/tui/src/footer.ts
  - packages/tui/src/actions.ts
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/keymap.json
  - docs/design/tui-v2/roles.json
  - docs/design/tui-v2/screens/17-themes.txt
  - docs/design/tui-v2/designs/dipo-ux-spec.html
  - packages/tui/src/planning.tsx
modified_files:
  - packages/cli/src/tui-command.ts
  - packages/tui/src/app.test.tsx
  - packages/tui/src/colour.test.ts
  - packages/tui/src/colour.tsx
  - packages/tui/src/composer.test.tsx
  - packages/tui/src/composer.tsx
  - packages/tui/src/desk.test.tsx
  - packages/tui/src/desk.tsx
  - packages/tui/src/detail.test.tsx
  - packages/tui/src/detail.tsx
  - packages/tui/src/footer.test.ts
  - packages/tui/src/footer.ts
  - packages/tui/src/frame.tsx
  - packages/tui/src/home.tsx
  - packages/tui/src/index.ts
  - packages/tui/src/keys.ts
  - packages/tui/src/live.test.tsx
  - packages/tui/src/options.ts
  - packages/tui/src/overview.test.tsx
  - packages/tui/src/overview.tsx
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/planning.tsx
  - packages/tui/src/queue.test.tsx
  - packages/tui/src/queue.tsx
  - packages/tui/src/run.tsx
  - packages/tui/src/screen.tsx
  - packages/tui/src/settings.tsx
  - packages/tui/src/theme.test.ts
  - packages/tui/src/theme.ts
  - packages/tui/src/views.tsx
priority: medium
type: feature
ordinal: 430000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want every TUI screen drawn in one frame with colour roles and every key coming from one registry, so that keys stay consistent and later views land in the new design by construction.

Step 1 of docs/design/tui-v2/migration.md. Colored takes one of the ten roles of roles.json (the nine of the ux-spec plus shade for overlay backdrops), with per-theme values exactly as the HTML previews, instead of a raw colour, with the truecolor Classical theme opt-in and theme detection by OSC 11, then COLORFGBG, then dark. A Frame component owns header, rooms, body, ticker and keys. KEY_TABLE grows label, when() and priority, and the footer reads hints from it. A Composer component gives a multi-line input (Enter adds a line, ctrl-s sends, Esc cancels) that replaces the planning view's own input (DIPO-449), so one input remains. Below 60 columns or 16 rows the Frame shows "Widen the terminal to at least 60 columns". Screens look the same apart from colours.

Design: docs/design/tui-v2/ (spec.md, screens/, keymap.json, roles.json, migration.md). The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text. Where spec.md's Maintainer decisions (2026-11-06) differ from the HTML, the text files win.

```dipo
branch: "DIPO-457/tui-v2-foundations"
unknowns:
  - q: "Please merge current main (with DIPO-456's queue test) into my box so I can see and fix the failing test. Or paste that test's body and the CI frame it printed."
    status: "resolved"
    answer: "The failing test is DIPO-456's in packages/tui/src/queue.test.tsx: 'u runs stories > shows the decision at once and the story in setup from it: the answer's cursor is the decision's own entry (DIPO-456)'. It waits for a frame containing \"> READY (2)\" (the old focus marker and heading), which your Frame and focus-bar change no longer draws. Merge origin/main into the branch (the PR also conflicts with main now), keep DIPO-456's test and its intent (the answer's cursor is the decision's own entry, the story shows in setup), and update only its frame expectations to the new rendering (the ▌ focus bar and the new Queue heading). Run DIPO_TEST_CI=1 bun run verify before you push."
  - q: "This box has no origin remote and no DIPO-456 test, so I cannot merge main. Please bring the merged branch (story branch plus main, with DIPO-456's queue test) into my box, or paste that test's body and the CI frame it printed. Then I will update only its frame expectations to the ▌ focus bar and the new Queue heading, and run DIPO_TEST_CI=1 bun run verify."
    status: "resolved"
    answer: "dipo cannot give the box a remote; here is what you asked for. CI frame: 'error: no frame contains \"> READY (2)\"' in packages/tui/src/queue.test.tsx. Add this test from main (DIPO-456) to that file, with its intent kept (the answer's cursor is the decision's own entry, the story shows in setup and RUNNING, no 'wait for its reply'), and change only its frame expectations to your rendering (the ▌ focus bar and the new Queue heading). It may need the fake office's 'starting' skip reason and run_starts setup that exist on main; if the test cannot run on your base, leave a note in the done report and dipo's conflict round will merge main. The test on main:\n  it(\"shows the decision at once and the story in setup from it: the answer's cursor is the decision's own entry (DIPO-456)\", async () => {\n    const { ui, session } = await openQueue();\n    // work.run answers at its decision; its one change moves the story out of Ready.\n    session.runReply = () => ({\n      ok: true,\n      result: {\n        started: [{ story: \"DIPO-30\", key: KEY_30, run: \"run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30\" }],\n        skipped: [{ story: \"DIPO-32\", key: \"sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C32\", reason: \"starting\" }],\n      },\n      changed: true,\n      cursor: { stream: STREAM, seq: 9 },\n    });\n    await ui.press(\"j\");\n    await ui.waitFor(\"> READY (2)\");\n    await ui.press(\"u\");\n    await ui.waitFor(\"waiting for the office stream\");\n    const starting = { ...golden(KEY_30), column: \"running\" } as StoryView;\n    session.active(STREAM)?.options.onEvent(storyEvent(9, starting, \"Ready\"));\n    const done = await ui.waitFor(\"run DIPO-30: done\");\n    expect(done).toContain(\"started DIPO-30\");\n    expect(done).toContain(\"skipped DIPO-32: already starting: its claim and box are under way\");\n    expect(done).toContain(\"RUNNING (4)\");\n    expect(done).not.toContain(\"wait for its reply\");\n    // A second u is sent at once: nothing waits for the first start's setup.\n    await ui.press(\"u\");\n    expect(ui.frame()).not.toContain(\"wait for its reply\");\n    expect(session.commands).toHaveLength(2);\n  });"
  - q: "The DIPO-456 test body was cut off after \"session.ru\" in the answer, so I could not add it. Please send the full test, or let dipo's conflict round merge main to bring it in. Criterion 7 also has no test or hand check: what should prove that the four mocks of 17-themes.txt match the rendering?"
    status: "resolved"
    answer: "main is merged into your branch now (commit 73db2499), so DIPO-456's test is in packages/tui/src/queue.test.tsx in your box. Keep its intent; change only its frame expectations (\"> READY (2)\" etc.) to your new rendering. Criterion 7 (matches the HTML preview by eye) is the maintainer's hand test: mark it maintainer, no automated test needed. Run the full verify before you finish."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) colour roles map to ANSI slots and drop under NO_COLOR"
    - kind: "automated"
      check: "(unit) footer hints come from the registry and fit the width with q quit kept"
    - kind: "automated"
      check: "(unit) Composer adds a line on Enter and sends on ctrl-s"
    - kind: "manual"
      check: "Open the TUI in a dark and a light terminal, once with NO_COLOR=1, next to designs/dipo-ux-spec.html S10 (Tweaks: dark/light, truecolor/ansi16)"
      expect: "Each terminal matches the HTML preview side by side: same roles, the focus row on sel, and under NO_COLOR only ▌ marks it"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Colored takes a role from the ten roles in roles.json (bg, fg, hi, dim, faint, acc, ok, err, sel, shade) and maps each to its ANSI slot and per-theme values; hi is a brighter colour and bold appears only where a screen marks it; dim and faint stay distinct; NO_COLOR makes sel equal bg so only ▌ marks the focused row, and NO_COLOR and --ascii still read fully
- [x] #2 One Frame component draws header, rooms, body, ticker and keys for every home view
- [x] #3 The key table carries label, when and priority, and the footer hints come from it with no per-view hint lists
- [x] #4 A Composer multi-line input exists where Enter adds a line, ctrl-s sends and Esc cancels
- [x] #5 Existing TUI tests pass unchanged apart from colour assertions
- [x] #6 Below 60 columns or below 16 rows the TUI shows "Widen the terminal to at least 60 columns" instead of the layout
- [ ] #7 The four theme mocks of screens/17-themes.txt match the HTML preview's S10 in truecolor light, 16 colours light and dark, and NO_COLOR. The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text
- [x] #8 The planning view uses the Composer; its own input code is gone
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-06 15:47 UTC: ambiguous-spec
- Detail: Please merge current main (with DIPO-456's queue test) into my box so I can see and fix the failing test. Or paste that test's body and the CI frame it printed.
- Run: run_01M6RMCQYTBTB2HDN3M12C4NV8
- Criteria met: 6 of 8 (as the worker reported them)
- Loops: 0 of 5; CI attempts: 1 of 2
- Review rounds: 2, failed 1 of 3
- Budget used: 254,313 of 800,000 tokens; 94 of 200 turns; 18 of 90 minutes
- Last good commit: 15233fc3268030953ab7fafc8ab510fa78c17a48

Resumed 2026-11-06 16:15 UTC; grants: none; note: The failing test is DIPO-456's in packages/tui/src/queue.test.tsx: 'u runs stories > shows the decision at once and the story in setup from it: the answer's cursor is the decision's own entry (DIPO-4…

Parked 2026-11-06 16:16 UTC: ambiguous-spec
- Detail: This box has no origin remote and no DIPO-456 test, so I cannot merge main. Please bring the merged branch (story branch plus main, with DIPO-456's queue test) into my box, or paste that test's body…
- Run: run_01M6RMCQYTBTB2HDN3M12C4NV8
- Criteria met: 6 of 8 (as the worker reported them)
- Loops: 0 of 5; CI attempts: 1 of 2
- Review rounds: 2, failed 1 of 3
- Budget used: 284,492 of 800,000 tokens; 99 of 200 turns; 19 of 90 minutes
- Last good commit: 1c6023f95afc7799a03be9757e1a29af399ed445

Resumed 2026-11-06 16:17 UTC; grants: none; note: dipo cannot give the box a remote; here is what you asked for. CI frame: 'error: no frame contains "> READY (2)"' in packages/tui/src/queue.test.tsx. Add this test from main (DIPO-456) to that file,…

Parked 2026-11-06 16:19 UTC: ambiguous-spec
- Detail: The DIPO-456 test body was cut off after "session.ru" in the answer, so I could not add it. Please send the full test, or let dipo's conflict round merge main to bring it in. Criterion 7 also has no…
- Run: run_01M6RMCQYTBTB2HDN3M12C4NV8
- Criteria met: 7 of 8 (as the worker reported them)
- Loops: 0 of 5; CI attempts: 1 of 2
- Review rounds: 2, failed 1 of 3
- Budget used: 306,101 of 800,000 tokens; 104 of 200 turns; 20 of 90 minutes
- Last good commit: 73db24998f09cbaa21a75b5f49d293d459fae8f5

Resumed 2026-11-06 17:33 UTC; grants: none; note: main is merged into your branch now (commit 73db2499), so DIPO-456's test is in packages/tui/src/queue.test.tsx in your box. Keep its intent; change only its frame expectations ("> READY (2)" etc.) t…
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-06 15:40 UTC
- Criteria met: 7 of 8 (as the worker reported them)
- Loops: 0; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 2, failed 1
- Budget used: 228,702 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
