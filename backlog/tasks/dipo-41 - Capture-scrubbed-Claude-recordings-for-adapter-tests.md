---
id: DIPO-41
title: Capture scrubbed Claude recordings for adapter tests
status: To Do
assignee: []
created_date: '2026-10-11 18:48'
updated_date: '2026-10-11 18:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-18
  - DIPO-40
references:
  - tools/recordings/
  - packages/engine/test/recordings/claude-cli/
  - packages/engine/test/fixtures/repos/
  - package.json
documentation:
  - docs/decisions/0008-worker-adapter.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
priority: high
type: task
ordinal: 41000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `bun run recordings:capture <scenario>` runs Claude with the adapter's own launch plan on a synthetic fixture repository, scrubs the stream with an allowlist, scans for secrets, and writes `stream.jsonl` and `meta.json`; the M0 scenarios are committed, captured live by the maintainer or derived in code.

Context: 0008 lists unverified CLI behaviour to record before the adapter parser (DIPO-42) and the self-test (DIPO-43) rely on it. Hook-based scenarios (`permission-wait`, `needs-permission`) are captured with DIPO-59. References: 0017 section 2 (format, replay rules, scenario table, capture steps, scrubbing allowlist, decision fields, report exemption, secret scan, storage and refresh, `recordings:status`); 0008 "Consequences" (live checks before the first adapter story).

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. Engine code reaches Bun APIs only through `packages/engine/src/platform/`. Engine time and ids come only from the injected `Clock` and `IdSource`. Database changes are new numbered migrations, never edits of a merged one. New contract shapes are additive minor changes with fixtures. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`.

```dipo
branch: "DIPO-41/capture-scrubbed-claude-recordings"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) scrubber over a synthetic stream with a planted secret aborts; allowlisted fields survive; unknown type redacted whole."
    - kind: "automated"
      check: "(unit) secret scan and decision-field checks over all committed recordings."
    - kind: "manual"
      check: "maintainer runs `bun run recordings:capture success-single`"
      expect: "a new `stream.jsonl` with no redaction marker on `apiKeySource` and no home path in the diff."
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Capture builds a fixture repository under a temp directory from `packages/engine/test/fixtures/repos/<name>`, never a real project.
- [ ] #2 Capture runs the DIPO-40 launch plan plus `--include-partial-messages` and `--include-hook-events`, and holds the raw stream only in memory.
- [ ] #3 The scrubber keeps exactly the fields listed under "kept as is" and redacts every other string as `[redacted sha256:<12 hex> len:<n>]`; an unknown message type is redacted whole and reported.
- [ ] #4 Ids and paths are normalised to stable placeholders within a recording.
- [ ] #5 A secret hit (`sk-ant-`, `ghp_`, `github_pat_`, AWS keys, `Bearer `, private key headers, the real home path) aborts the capture without writing.
- [ ] #6 `derive.ts` produces `terminated`, `crash-truncated`, `crash-zeroed`, `init-rejected`, `start-failed`, `report-invalid`, `prompt-too-long`, `stall` and `budget-engine-cap` from live recordings.
- [ ] #7 Live scenarios `success-single`, `success-tools-subagent`, `max-turns`, `permission-denied`, `interrupt`, `resume` and `worker-park-ambiguous` are committed, and `meta.json` carries version, flags, date, prompt size and hash.
- [ ] #8 Unit tests over every committed recording assert no secret shape, no redacted decision field, and usage numbers equal to the checksum taken at capture.
- [ ] #9 Implementation notes record the 0008 live checks: `--json-schema` per turn in streaming input, `priority: "now"` behaviour, `apiKeySource` on a claude.ai login, and SIGINT behaviour in streaming input.
- [ ] #10 `bun run recordings:status` lists recordings whose `claude_code_version` differs from the local `claude --version`.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M0 breakdown draft number S25 (DIPO-15). Before cutover: built by hand-run agents.
<!-- SECTION:NOTES:END -->
