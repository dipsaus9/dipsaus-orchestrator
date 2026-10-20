---
id: DIPO-136
title: Change the privacy settings from the TUI
status: Done
assignee: []
created_date: '2026-10-16 19:09'
updated_date: '2026-10-20 16:19'
labels:
  - 'tier:M'
  - 'slice:m1b'
milestone: m-1
dependencies:
  - DIPO-135
  - DIPO-137
references:
  - packages/contract/src/
  - packages/contract/schema/
  - packages/daemon/src/
  - packages/daemon/test/
  - packages/client/src/
  - packages/engine/src/config/
  - packages/engine/test/config/
  - packages/engine/src/office/
  - packages/engine/test/office/
  - packages/engine/src/platform/
  - packages/engine/src/views/
  - packages/engine/test/stories/views.test.ts
  - packages/tui/src/
  - docs/decisions/0005-command-and-event-model.md
priority: medium
type: feature
ordinal: 126000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the maintainer turns storing worker commands, prompts and raw events on or off from the TUI, without editing .dipo/office.local.yaml by hand; a change applies from the next output dipo stores, also for a run that is going.

Context: the privacy settings (0007 section 8) are machine-local and accepted only in .dipo/office.local.yaml (0017 section 5). After DIPO-135 and DIPO-137, storeCommandBodies and storePrompts are on by default and keepRawEvents is off. Today the TUI only reads; changing a setting means editing that file. UIs never write engine files (CLAUDE.md, engine is headless), so the TUI sends a contract command and the engine office feature (packages/engine/src/office/feature.ts, next to office.reloadConfig) validates the change with the existing config schema (packages/engine/src/config/) and writes the file. That the daemon rewrites a file the maintainer may have edited by hand is new behaviour: the file keeps every other key it holds (timeouts, retention), its comments are not kept, and the TUI says so before the first write. The engine has a YAML parser (packages/engine/src/platform/yaml.ts) but no writer; the writer is Bun.YAML.stringify of the pinned Bun, next to the parser, with no new dependency. It writes flow style on one line unless given an indent argument (0017), and it drops comments, so dipo writes a short header comment of its own at the top of the file.

After a valid write the office configuration is reloaded through office.reloadConfig (OfficeManager.reloadConfig in packages/engine/src/office/manager.ts), and the reply carries the new configHash. Privacy is read from the configuration in force on every ingest pass (packages/engine/src/ingest/ingestor.ts, the privacy option; packages/engine/src/run/hosts.ts; the privacy function in packages/daemon/src/runs.ts), so storeCommandBodies applies from the next output dipo stores, also in a run that is going. storePrompts applies from the next session that starts, keepRawEvents at the next retention pass (packages/engine/src/retention/feature.ts reads the configuration in force).

Where a setting comes from: loadOfficeConfig returns localOverrideKeys (the leaf keys office.local.yaml sets), but the office manager keeps only the config and its hash. This story makes the office manager keep localOverrideKeys with the config, and adds an optional field `privacy` to OfficeSummary (packages/contract/src/software.ts): for each of the three settings its key, effective value and source (`default` or `office.local.yaml`), filled by summarySettings in packages/engine/src/views/summary.ts. packages/contract/schema/ is regenerated. The settings view reads that field, so it updates from the next office.summary event. Asked for by the maintainer during the DIPO-115 cutover (2026-10-16); part of the M1b TUI desk.

```dipo
branch: "DIPO-136/tui-privacy-settings"
unknowns:
  - q: "Which YAML serializer writes office.local.yaml: Bun.YAML.stringify from the pinned Bun (no new dependency, drops comments), or a YAML library that keeps comments (a new pinned dependency the maintainer approves)?"
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): Bun.YAML.stringify from the pinned Bun, no new dependency; comments are dropped and dipo writes a short header comment back."
  - q: "Does the command live in the engine office feature (packages/engine/src/office/, next to office.reloadConfig) or in the daemon?"
    status: "resolved"
    answer: "A (maintainer, 2026-10-20): in the engine office feature, packages/engine/src/office/, next to office.reloadConfig."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the command writes the requested privacy value to office.local.yaml, keeps its timeouts and retention keys, creates the file with the current office config version (OFFICE_CONFIG_VERSION) when it is missing, writes dipo's header comment and block-style YAML that parses back to the same values, and refuses an unknown key or a non-boolean value with the file and key named and the file unchanged"
    - kind: "automated"
      check: "(unit) after a valid write the office configuration is reloaded and the reply carries the new configHash; OfficeSummary.privacy names each setting's effective value and its source, default or office.local.yaml"
    - kind: "automated"
      check: "(unit) the TUI settings view shows the three privacy settings with their effective values and sources, warns once that comments in the file are not kept, and sends the command when one is toggled"
    - kind: "manual"
      check: "(live) on the scratch repo, start a run that uses Bash and toggle storeCommandBodies off, then on again, in the TUI while it runs"
      expect: "after off the next tool lines show no commands, after on they show them again, and office.local.yaml holds the last value under dipo's header comment"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A contract command, answered by the engine office feature in packages/engine/src/office/ next to office.reloadConfig, changes one privacy setting (storeCommandBodies, storePrompts or keepRawEvents) of an office; it is validated with the office config schema and written to .dipo/office.local.yaml with Bun.YAML.stringify in block style through packages/engine/src/platform/yaml.ts, under a short header comment that says dipo wrote the file and comments are not kept, keeping the other keys in the file and creating the file with the current office config version when it is missing; package.json gains no dependency
- [x] #2 An unknown key, a non-boolean value or an office.local.yaml that does not validate is refused with the file and key named, and the file is left unchanged
- [x] #3 After a valid write the office configuration is reloaded (office.reloadConfig in packages/engine/src/office/manager.ts) and the reply carries the new configHash
- [x] #4 The office manager keeps the localOverrideKeys of the loaded configuration, and OfficeSummary carries an optional field privacy with each setting key, effective value and source (default or office.local.yaml); packages/contract/schema/ is regenerated
- [x] #5 The TUI has a settings view, opened from the overview, that lists the three privacy settings with their effective values and sources, warns before the first write that comments in office.local.yaml are not kept, and toggles one with a confirmation that names what is stored
- [x] #6 A change applies from the next output dipo stores, also for a run that is going: storeCommandBodies from the next stored output line, storePrompts from the next session that starts, keepRawEvents at the next retention pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5CYD2W4BCP3D7D2MJ0R0NAC (Sonnet, M1b, 56 turns, about $1.37, 12 min) reported done, In Review, with no write outside the References. Two denied calls: a `sed -i` (the temp binary predated DIPO-232's avoid line) and a compound ending in `git stash list`. New command office.setPrivacy { office, key, value } (engine office feature) writes one privacy key of .dipo/office.local.yaml through Bun.YAML (block style, header saying comments are not kept, every other key kept, atomic temp file and rename), refuses an unknown key, a non-boolean value or an invalid file with the file and key named, reloads the configuration and replies with the hash in force; OfficeSummary gains privacy (key, value, source default or office.local.yaml); the TUI settings view ('p' from the overview) lists the three settings, warns about comments before the first write, and toggles one after a confirmation naming what is stored. The schemas, fixtures and version.ts (unreleased minor 1.1) are updated. Fixed on top after review: the maintainer answered (2026-10-20, answer A) that every client asks first, so office.setPrivacy has confirm: true, the TUI sends confirmed: true after its own prompt, and a dated 0005 section 4 amendment records it (References widened to docs/decisions/0005-command-and-event-model.md); a failed write removes its temp file and answers office.refused naming the file, with a test; the settings test waits for the overview after Esc (was flaky, 2 of 6). Advisory, not done: office.refused's comment in errors.ts still describes only a failed office load. The test plan's live entry (toggle storeCommandBodies in the TUI during a run on the scratch repo) is left for the maintainer's wave hand-test. Verify outside the sandbox on the finish worktree with origin/main merged in: exit 0, 4077 tests; DIPO_TEST_CI=1 contract, engine config/office/stories, daemon, client and TUI tests pass.
<!-- SECTION:NOTES:END -->
