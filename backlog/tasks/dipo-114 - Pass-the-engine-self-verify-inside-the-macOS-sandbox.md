---
id: DIPO-114
title: Pass the engine self-verify inside the macOS sandbox
status: To Do
assignee: []
created_date: '2026-10-16 09:39'
labels:
  - 'tier:M'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/platform/process.ts
  - packages/client/src/node/lifecycle/process.ts
  - test/lifecycle-parity
  - packages/engine/src/sandbox/
  - packages/engine/test/platform
  - packages/engine/test/sandbox
  - packages/client/test
priority: high
type: feature
ordinal: 104000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo can run this repository's bun run verify inside its own sandbox on macOS, which the cutover (docs/plan.md step 4) needs because the maintainer's machine is macOS.

Context: the process identity probe on macOS runs the setuid /bin/ps (packages/engine/src/platform/process.ts probeDarwin), which Seatbelt refuses inside the sandbox, so tests that probe processes fail under the sandboxed verify. DIPO-37's notes record this limitation as unchanged; CI runs the self-verify on Linux only. The same probe has a twin in packages/client/src/node/lifecycle/process.ts, kept equal by test/lifecycle-parity. Found by the 2026-10-16 milestone review (TL;DR 1, suggestion 1).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The macOS process probe returns the same start time, state and command without a setuid binary, in both copies, and test/lifecycle-parity still passes.
- [ ] #2 A sandboxed run of this repository's verify on macOS passes (recorded in the task notes with the command and the result).
- [ ] #3 The probe keeps working outside the sandbox and on Linux; tests cover a live PID, a dead PID and a zombie where the platform allows.
<!-- AC:END -->
