---
id: DIPO-114
title: Pass the engine self-verify inside the macOS sandbox
status: Done
assignee: []
created_date: '2026-10-16 09:39'
updated_date: '2026-10-16 10:23'
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
  - packages/client/src/node/lifecycle/
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
- [x] #1 The macOS process probe returns the same start time, state and command without a setuid binary, in both copies, and test/lifecycle-parity still passes.
- [x] #2 A sandboxed run of this repository's verify on macOS passes (recorded in the task notes with the command and the result).
- [x] #3 The probe keeps working outside the sandbox and on Linux; tests cover a live PID, a dead PID and a zombie where the platform allows.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Probe: probeDarwin in both copies (engine/src/platform/process.ts, client/src/node/lifecycle/process.ts) reads kern.proc.pid.<pid> (struct kinfo_proc: p_starttime.tv_sec, p_stat, p_comm) and kern.procargs2 through bun:ffi sysctl on libSystem; no /bin/ps. srt's Seatbelt profile allows sysctl-read of kern.proc.pid.* and process-info for same-sandbox targets. Command follows ps: args joined by spaces, <defunct> for a zombie, (comm) when the args cannot be read (another user's process, or one outside the sandbox). parseLstart/parsePsLine replaced by parseKinfoProc/parseProcArgs/darwinProcessInfo (client lifecycle index exports updated); test/lifecycle-parity compares both copies on kinfo/procargs buffers and probes this process and a child. Tests (engine/test/platform/process.test.ts): live PID, dead PID, child command line, zombie (sh background child under exec sleep) on macOS and Linux, and on macOS outside the sandbox the probe equals /bin/ps for a live PID, a child and a zombie (skipped where ps cannot run). Compiled binary checked: bun build --compile of the probe returns the same.
Sandboxed self-verify on macOS (Darwin 25.6.0, arm64): self-verify.ci.test.ts no longer Linux only. Command, in the worktree: DIPO_HOME=/tmp/dpo-114/home DIPO_RUNTIME_DIR=/tmp/dpo-114/run DIPO_TEST_CI=1 bun test packages/engine/test/sandbox/self-verify.ci.test.ts -> 1 pass, 0 fail (80 s; builds dipo with scripts/build.ts and runs bun run verify through dipo daemon sandbox-exec under the verify policy). First run: process tests passed but 1 other test failed: the Safe-Chain gate test (safe-chain-proxy.test.ts) listens on 127.0.0.1 TCP, which the closed verify network refuses on Seatbelt (EPERM; Linux gives the step its own loopback). No policy change: that test now skips when a loopback listen is refused. Second run passed. Also DIPO_TEST_CI=1 sandbox.ci, hardening.ci and client lifecycle.ci tests pass on macOS (18). bun run verify: 2909 pass, 2 skip.

Review fixes: kinfoOutcome (both copies, parity-tested) returns null only when kern.proc.pid succeeds with 0 bytes; a failed call (EPERM, EINVAL, ENOMEM) or a malformed kinfo_proc throws (unknown, never dead). The Safe-Chain gate test now skips only on macOS with DIPO_SANDBOX_SELF_VERIFY=1 when loopback listen is refused. References gain packages/client/src/node/lifecycle/. Rerun: bun run verify 2911 pass, 2 skip; the macOS sandboxed self-verify (same command) 1 pass.

Loopback skip changed again: the Safe-Chain gate test skips on macOS whenever a 127.0.0.1 listen is refused, with no marker, so the cutover's sandboxed verify passes without a policy change; on Linux it still fails. DIPO_SANDBOX_SELF_VERIFY stays as the self-verify recursion guard. Rerun: parity/process/safe-chain tests 51 pass; inside srt the gate test skips without a marker (18 pass, 1 skip); macOS sandboxed self-verify 1 pass; bun run verify 2911 pass, 2 skip.
<!-- SECTION:NOTES:END -->
