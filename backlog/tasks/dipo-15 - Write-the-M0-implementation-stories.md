---
id: DIPO-15
title: Write the M0 implementation stories
status: To Do
assignee: []
created_date: '2026-10-11 18:43'
updated_date: '2026-10-12 07:59'
labels: []
milestone: m-0
dependencies: []
priority: high
type: docs
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: every M0 implementation story exists in Backlog.md in milestone m-0, written from the accepted ADRs to the story standard, with dependencies, so M0 can be built and cut over.

Context: docs/plan.md step 2 (M0 implementation stories). Stories follow ADR 0012 (story standard and Ready gate) with the field storage of ADR 0010 section 3 (labels and the dipo field block). Sources are ADRs 0001 to 0017. Decisions the maintainer took on the breakdown (D1 to D9, 2026-10-11) are recorded as dated amendment lines in the affected ADRs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 All M0 stories exist in milestone m-0 following ADR 0012, with dependencies between them
- [x] #2 Decisions that change an ADR (D2, D4–D8) are recorded as dated amendment lines in 0003, 0004, 0010 and 0013; D1, D3 and D9 need no ADR change and are recorded in this story's notes.
- [ ] #3 A separate reviewer agent checked the stories and amendments and its findings are fixed
- [ ] #4 Maintainer approved the M0 stories
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Created 52 M0 stories, DIPO-16 to DIPO-67, in milestone m-0 with the Backlog CLI. Each follows ADR 0012 with ADR 0010 storage: Outcome line, context with ADR references, dipo field block (branch, unknowns, test_plan), tier label, scope as references, referenced ADRs as documentation, dependencies. Status stays To Do; the maintainer sets Ready. The test-before-merge label is not set anywhere.

Draft numbers to ids: S01 to S19 are DIPO-16 to DIPO-34; S19b is DIPO-35; S20 to S51 are DIPO-36 to DIPO-67. The draft number is in each story's notes.

Decisions on the breakdown (maintainer, 2026-10-11):
- D1: M0 delivery ends at In Review with the story branch pushed; the story PR and reviewer stay manual until M1 (DIPO-49).
- D2: caps (token budget, turns, time) and parks with a reason are in M0; the triage view and resume of parked stories stay M1 (DIPO-50, DIPO-51).
- D3: the maintainer sets Ready with the Backlog CLI; M0 adds read-only dipo gate <id>, and run refuses a story that fails the gate (DIPO-30, DIPO-48).
- D4: in M0 the engine opens the backlog-lane PR and auto-merges it after its structural check, as 0010 decided. New story DIPO-35 (S19b) split out of the backlog lane story DIPO-34; office init DIPO-36 depends on it.
- D5: private packages/testkit, devDependency only (DIPO-18).
- D6: cutover after DIPO-55; dipo delivers DIPO-56 to DIPO-67 (label after-cutover); v0.1.0 after DIPO-66 lands and the maintainer's live smoke run passes.
- D7: draft promotion moves to M3.
- D8: M0 scan is code only; run refuses an office whose verify is unresolved with a message naming the script to add; AI fallback and confirm command are M1 (DIPO-33).
- D9: office init does not write .dipo/office.yaml; built-in 0008 defaults apply; init still writes .dipo/.gitignore (DIPO-36).

Amendment lines dated 2026-10-11 added to ADRs 0003, 0004, 0010 and 0013. docs/plan.md step 4 names the cutover point.

Open unknown kept on purpose: DIPO-42 has one open unknown (report channel per turn) that the DIPO-41 live check answers; it blocks Ready until then.

Suggested test-before-merge (not set; maintainer decides): DIPO-23, DIPO-25, DIPO-27, DIPO-35, DIPO-36, DIPO-37, DIPO-41, DIPO-43, DIPO-48, DIPO-49, DIPO-50, DIPO-53, DIPO-54, DIPO-55, DIPO-57, DIPO-59, DIPO-63.

Review fixes (PR #16): cutover needs DIPO-16 to DIPO-55 Done; DIPO-55 now also depends on DIPO-49 (verify and commit) and DIPO-51 (worker outcomes) so the end-to-end loop is in place before cutover. ADR 0016 needed no amendment for D6: cutting v0.1.0 after DIPO-66 and the live smoke run is stricter than, and consistent with, 0016's 'v0.1.0 when the skeleton delivers a story end to end'. The Clock and IdSource interfaces live in packages/contract (DIPO-18). DIPO-66's one-time maintainer steps go into docs/release.md. DIPO-50 parks needs-permission for calls denied by the launch plan until DIPO-59 adds the PermissionRequest hook.

D10 (maintainer, 2026-10-12): DIPO-59's allow-once flow with work.answer and dipo answer stays in M0 as an explicit exception to D2. It resumes only a story parked needs-permission; every other resume of a parked story stays M1. Recorded as a 2026-10-12 amendment line in 0003. DIPO-50's context and DIPO-59's ACs, dependencies (now also DIPO-50) and test plan were aligned with 0008 sections 5 and 8 and the 0005 work.answer decision amendment.

Test-before-merge (maintainer, 2026-10-12): DIPO-25, DIPO-35, DIPO-37, DIPO-49, DIPO-53 and DIPO-55 carry the test-before-merge label. Each has at least one manual test entry with steps and an expected result (0012 R20, R21); the manual steps of DIPO-35, DIPO-49 and DIPO-55 were made concrete. The other stories in the earlier suggestion list stay unflagged.
<!-- SECTION:NOTES:END -->
