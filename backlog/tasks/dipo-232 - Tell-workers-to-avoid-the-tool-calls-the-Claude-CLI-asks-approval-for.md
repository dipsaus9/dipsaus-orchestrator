---
id: DIPO-232
title: Tell workers to avoid the tool calls the Claude CLI asks approval for
status: In Progress
assignee: []
created_date: '2026-10-20 10:40'
updated_date: '2026-10-20 11:02'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/prompts/contract/implement.md
  - packages/engine/test/prompts/golden/system-implement-developer.md
  - packages/engine/test/prompts/system.test.ts
priority: high
type: enhancement
ordinal: 232000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the worker contract tells workers to change files with the Edit and Write tools and to run one command per Bash call, so a worker no longer loses its work, and every later call of its session that needs approval, to the Claude CLI's automatic deny of `sed -i`, a heredoc write or a compound command.

Context: maintainer decision of 2026-10-20 (option A): 0008 section 5 stays as it is. With no maintainer present there is no decision, so the CLI denies a call that needs approval; workers are told to avoid such calls instead. Seen on 2026-10-20 in the runs of DIPO-160, 205, 207, 222 and 147: denied `sed -i`, `cd x; cmd`, a `cat >>` heredoc and `grep | sed`. In run_01M5CC7GFCX8WEP9S3FWDN1N2X (DIPO-147) and run_01M5CA3ZH7NEC7KWMP6QGR3CFP (DIPO-222) the CLI's permission_denied event says "This Bash command contains multiple operations. The following part requires approval: sed -i ..." and that anything else that requires approval will be denied the same way for the rest of this session. The run settings allow Bash, and Edit and Write inside the worktree, so the Edit tool and a single command go through. The contract (packages/engine/src/prompts/contract/implement.md) already says, under Working directory, to run every command from the worktree root and never `cd`; nothing tells the worker how to edit files or to keep Bash calls simple. packages/engine/test/prompts/system.test.ts checks that the rendered system file holds no digit and no path but /tmp, so the new text holds no digit and no slash. DIPO-181 and DIPO-231 cover the permission decision path itself. The change is prompt text, its golden file and a test.

```dipo
branch: "DIPO-232/contract-avoid-approval-calls"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) system.test.ts: the rendered system file has the Calls that need approval section right after Working directory, saying why such calls are denied in a run"
    - kind: "automated"
      check: "(unit) system.test.ts finds with toContain the rule to change files only with the Edit and Write tools and the rule of one command per Bash call with its pipe limits"
    - kind: "automated"
      check: "(unit) the system prompt golden test passes with the new section, and the tests that the system file holds no digit and no path but /tmp still pass"
    - kind: "manual"
      check: "(live) on the scratch repo, run a story whose change renames one symbol in several files"
      expect: "the worker edits the files with the Edit tool, and the run's events.ndjson holds no permission_denied event"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 packages/engine/src/prompts/contract/implement.md has a section `## Calls that need approval` right after `## Working directory`, which says that the worker's tool layer asks for approval of some calls, that nobody answers that question in a run, so such a call is denied and later calls that need approval can be denied too, and that the worker therefore avoids these calls
- [ ] #2 That section tells the worker to make the edits it writes itself with its file editing and writing tools, never with `sed -i`, a heredoc, a shell redirection such as `>` or `>>` into a file, `tee`, or a script it writes to change files; a project command that rewrites files (the formatter, a golden update, a code generator) and removing or moving a file are fine, each as one command
- [ ] #3 That section tells the worker to run one command per shell call: no chain with `&&`, `||` or `;`, no `cd` in front of a command (it runs in the directory it is in), and a pipe only to cut one command's output with `head`, `tail` or `grep`, never into `sed`, `awk`, `xargs` or a shell
- [ ] #4 packages/engine/test/prompts/golden/system-implement-developer.md holds the new text, packages/engine/test/prompts/system.test.ts checks the heading and the rules of the two criteria before with toContain, and the existing tests that the system file holds no digit and no path but /tmp keep passing, so the new text has no digit and no slash
<!-- AC:END -->
