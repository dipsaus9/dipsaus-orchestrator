---
id: DIPO-195
title: Let a worker read gh's own help and version
status: Refined
assignee: []
created_date: '2026-10-17 23:16'
updated_date: '2026-10-17 23:25'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-164
  - DIPO-194
references:
  - packages/engine/src/hooks/
  - packages/engine/test/hooks/
  - packages/engine/src/workers/claude-cli/plan.ts
  - packages/engine/test/workers/plan.test.ts
  - packages/engine/test/workers/golden/
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/test/prompts/
priority: medium
type: enhancement
ordinal: 184000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: a worker can run gh --version, gh help and gh <command> --help to read gh's own help, while every other gh call stays refused, so a story about gh flags can be done without guessing them.

Context: the M1a run of DIPO-141 (run_01M55XPQ4DHJBPZHGHZCSF1SMR). The story was about gh flags. gh --version and gh <cmd> --help were denied by Bash(gh *) (commands("gh") in permissions(), packages/engine/src/workers/claude-cli/plan.ts), and the sandbox network refused raw.githubusercontent.com, so the worker could not read gh's help. In Claude Code a deny rule beats an allow rule, so Bash(gh *) cannot be carved out by an allow, and a deny rule cannot say "except". Denying each gh command by name would still deny gh pr view --help through Bash(gh pr *). So the help forms need the gh deny rules dropped and the refusal moved into the PreToolUse Bash check of DIPO-194, which sees every Bash call. The help forms need neither the network nor credentials: the sandbox masks ~/.config/gh and GH_TOKEN (CREDENTIAL_FILES and CREDENTIAL_VARIABLES in plan.ts). Whether gh starts at all with ~/.config/gh unreadable is not checked; the manual entry shows it. WebFetch from DIPO-164 is another way to gh's manual, but it reads the web docs, not the installed version.

ADR 0014 section 3 says the worker never runs gh, and 0008 section 2 lists Bash(gh *) among the deny rules, so this needs amendments of both that the maintainer approves. This story does not edit docs/decisions/.

```dipo
branch: "DIPO-195/worker-reads-gh-help"
unknowns:
  - q: "0014 section 3 says the worker never runs gh, and 0008 section 2 lists Bash(gh *) as a deny rule. Do you approve amendments of both that let the worker run gh --version, gh help <subcommand words> and gh <subcommand words> --help, with every other gh call refused by the PreToolUse Bash check of DIPO-194 instead of a deny rule?"
    status: "open"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the check allows gh --version, gh help pr, gh pr view --help and gh api -h, and refuses gh pr create --title x --help and every other gh call, also in a compound command"
    - kind: "automated"
      check: "(unit) a plan with the hook relay holds no gh deny rule, and a plan without it keeps Bash(gh) and Bash(gh *)"
    - kind: "automated"
      check: "(golden) the rendered system file names the gh help forms as the only gh calls allowed"
    - kind: "manual"
      check: "(live) on the scratch repo, run a story whose task asks the worker to report the flags of gh pr view"
      expect: "the worker runs gh pr view --help in the sandbox and reads the help text, and a gh pr view call with a PR number is denied with dipo's reason"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Bash check of DIPO-194 in packages/engine/src/hooks/ also refuses every simple command whose program is gh, with a reason saying the engine handles the code host, except exactly these forms: gh --version; gh help followed by zero or more subcommand words; and gh followed by one or more subcommand words and then --help or -h as the last argument. A subcommand word matches [A-Za-z][A-Za-z0-9-]*, so it starts with a letter and no flag can come before the final --help or -h
- [ ] #2 Unit tests in packages/engine/test/hooks/ allow gh --version, gh help pr, gh pr view --help and gh api -h, and refuse gh, gh pr view 12, gh pr create --title x --help, and the gh auth token part of gh --help && gh auth token
- [ ] #3 A plan that registers the PreToolUse Bash hook holds no Bash(gh) or Bash(gh *) deny rule, and a plan without the hook relay keeps both; tests in packages/engine/test/workers/plan.test.ts assert both, and the golden plan files in packages/engine/test/workers/golden/ are updated
- [ ] #4 L1 (packages/engine/src/prompts/contract/implement.md) says gh --version, gh help and gh <command> --help are the only gh calls allowed; packages/engine/test/prompts/golden/system-implement-developer.md is updated and its test passes
<!-- AC:END -->
