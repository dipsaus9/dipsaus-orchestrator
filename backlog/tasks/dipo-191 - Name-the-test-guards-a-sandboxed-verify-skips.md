---
id: DIPO-191
title: Name the test guards a sandboxed verify skips
status: Done
assignee: []
created_date: '2026-10-17 20:30'
updated_date: '2026-10-17 22:52'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/testkit/src/
  - packages/daemon/test/unit/runtime-isolation.test.ts
  - packages/engine/test/platform/process.test.ts
  - packages/engine/test/sandbox/safe-chain-proxy.test.ts
priority: low
type: enhancement
ordinal: 180000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a verify run in the worker sandbox prints the name and reason of every test guard that skipped, and the DIPO-109 temp-root limits are also checked at the worker's 30-byte temp root, so "verify passes in the sandbox" no longer hides tests that never ran.

Context: the fourth M1a run, DIPO-176 (run_01M55PE8B6W4X9TMJEW2SYV7B6), recorded in the DIPO-176 notes. Inside the worker sandbox 10 tests skip, outside it 2. Six are root-length guards. NESTED_ROOT_FITS, only in packages/testkit/src/temp.test.ts, checks the real temp root plus "/dipo-XXXXXX"; LONGEST_ROOT_FITS, in packages/testkit/src/temp.test.ts and packages/daemon/test/unit/runtime-isolation.test.ts, checks the root plus "/dipo-XXXXXX/r". Both compare against MAX_TEMP_ROOT_BYTES (37 bytes, packages/testkit/src/runtime.ts). The worker's DIPO_TMP is 30 bytes by design (DIPO-118), so the sums are 42 and 44 bytes, and the DIPO-109 runtime-isolation guards never run under the fence. The other two are likely PS_RUNS (packages/engine/test/platform/process.test.ts) and SANDBOX_REFUSES_LOOPBACK (packages/engine/test/sandbox/safe-chain-proxy.test.ts); that is inferred, not observed, and the new skip lines will show it. In the sandbox the only writable roots are DIPO_TMP and TMPDIR, so a shorter real root cannot be made there; the limits themselves are byte counts on paths and can be checked without creating the directories.

```dipo
branch: "DIPO-191/name-skipped-test-guards"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the skip helper writes the guard name and reason when it skips and nothing when the test runs"
    - kind: "automated"
      check: "(unit) the computed-path variants of the root-length limits pass with DIPO_TMP at a 30-byte root"
    - kind: "manual"
      check: "(local) run bun test with DIPO_TMP set to a directory whose real path is 30 bytes"
      expect: "the output names each skipped guard with its reason, and the root-length variants pass"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 packages/testkit/src/ exports one helper for a conditional skip that takes a guard name and a reason and, when it skips, writes one line naming the guard and the reason to stderr; NESTED_ROOT_FITS, LONGEST_ROOT_FITS, PS_RUNS and SANDBOX_REFUSES_LOOPBACK in packages/testkit/src/temp.test.ts, packages/daemon/test/unit/runtime-isolation.test.ts, packages/engine/test/platform/process.test.ts and packages/engine/test/sandbox/safe-chain-proxy.test.ts use it
- [x] #2 A unit test shows the helper writes the line when its condition skips the test and writes nothing when the test runs
- [x] #3 The limits that NESTED_ROOT_FITS and LONGEST_ROOT_FITS guard (a nested DIPO_TMP is accepted when it fits; a root of exactly MAX_TEMP_ROOT_BYTES is accepted and one byte more is refused) gain a variant that checks them on computed paths without creating the directories, and that variant runs with DIPO_TMP at a 30-byte root
- [x] #4 The PR lists the skip lines printed by bun test with DIPO_TMP at a 30-byte root
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M560BS046C5R0RT0N6CPBFXM (Haiku low, 21 turns, about $0.04, 4 min) reported done with no denials. testkit gains skipUnless-style guard helper (testkit/src/guard.ts) that writes 'skipped by guard <NAME>: <reason>' to stderr; the four guards use it; the root-length limits gain computed-path variants that run at a 30-byte root. Skip lines (criterion 4): inside the worker sandbox at its 30-byte DIPO_TMP: SANDBOX_REFUSES_LOOPBACK, LONGEST_ROOT_FITS (twice: temp.test.ts and runtime-isolation.test.ts), PS_RUNS, NESTED_ROOT_FITS. Outside the sandbox at a 30-byte DIPO_TMP (/private/tmp/dipo-t-191a0b1c2d): LONGEST_ROOT_FITS twice and NESTED_ROOT_FITS once; 3203 pass, 8 skip, 0 fail. Verify outside with DIPO_TMP unset on DIPO-191/name-skipped-test-guards-finish: 3209 pass, 2 skip, 0 fail; DIPO_TEST_CI=1 testkit, daemon unit, sandbox and platform 338 pass.
<!-- SECTION:NOTES:END -->
