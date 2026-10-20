---
id: DIPO-242
title: Re-check the command a wrapper or a shell runs in the gh check
status: Ready
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-20 23:28'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-243
references:
  - packages/engine/src/hooks/gh-guard.ts
  - packages/engine/src/hooks/temp-guard.ts
  - packages/engine/test/hooks/gh-guard.test.ts
priority: medium
type: enhancement
ordinal: 242000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the gh check of the Bash hook refuses a gh call run through a wrapped shell, a shell function, a coprocess, a here-string or piped input to a shell, and no longer refuses `command -v gh`.

Context: advisories of the DIPO-195 review (PR #281); none was caught by the old Bash(gh *) deny rule, so none is a regression. ghCommand in packages/engine/src/hooks/gh-guard.ts looks for a literal gh word after a wrapper (env, sudo, doas, xargs, timeout, stdbuf) and does not re-check the command the wrapper runs, so `env bash -c 'gh pr list'`, `sudo sh -c 'gh pr list'`, `nice -n5 bash -c 'gh pr list'` and `env -S 'gh pr list'` pass; it takes the first later word named gh, so `command -v gh` and `sudo -u gh ls` are refused. `function f { gh pr list; }; f` and `coproc gh pr list` pass because function and coproc are not skipped before the program. A shell reads a here-string or piped stdin as a script (`bash <<< 'gh pr list'`, `echo gh pr list | bash`) and both pass. The temp guard (packages/engine/src/hooks/temp-guard.ts) already finds the wrapped command by option parsing (wrappedCommandAt, envRefusal with env -S as nested text); those helpers are module-private today. Indirection (`x=gh; $x pr view`), aliases and script files stay out of scope.

Added 2026-10-21 from the DIPO-243 and DIPO-241 reviews, both live bypasses of the gh refusal on the normal path since DIPO-195 dropped the Bash(gh *) deny rule: simpleCommands does not decode ANSI-C quoting, so `$'gh' pr merge 1` and `$'\x67h' pr list` give the word `$gh` (or `$\x67h`) and pass, though bash and zsh run gh; and the basename test is case-sensitive, so `GH pr merge 1` passes, though a case-insensitive file system (the macOS default) runs it as gh.

```dipo
branch: "DIPO-242/gh-check-wrapped-commands"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) gh-guard.test.ts refused rows: env bash -c 'gh pr list', sudo sh -c 'gh pr list', nice -n5 bash -c 'gh pr list', env -S 'gh pr list', function f { gh pr list; }, coproc gh pr list, bash <<< 'gh pr list', echo gh pr list | bash"
    - kind: "automated"
      check: "(unit) gh-guard.test.ts refused rows: $'gh' pr merge 1, $'\\x67h' pr list, $\"gh\" pr list, GH pr merge 1 and Gh api /user"
    - kind: "automated"
      check: "(unit) gh-guard.test.ts allowed rows: command -v gh, sudo -u gh ls, env bash -c 'gh --version', and every row allowed before"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 In packages/engine/src/hooks/gh-guard.ts a wrapper's wrapped command is found by option parsing, as the temp guard's wrappedCommandAt and envRefusal do (shared from packages/engine/src/hooks/temp-guard.ts), and checked again in full, so `env bash -c 'gh pr list'`, `sudo sh -c 'gh pr list'`, `nice -n5 bash -c 'gh pr list'` and `env -S 'gh pr list'` are refused, and `command -v gh` and `sudo -u gh ls` are allowed
- [ ] #2 `function` and `coproc` are skipped before the program, so `function f { gh pr list; }` and `coproc gh pr list` are refused
- [ ] #3 A shell without -c that reads a here-string, or that reads its stdin from an earlier stage of a pipe, has that text checked as a script, so `bash <<< 'gh pr list'` and `echo gh pr list | bash` are refused
- [ ] #4 Each case of the criteria before is a row in the refused or allowed table of packages/engine/test/hooks/gh-guard.test.ts, and every row there before keeps its result
- [ ] #5 In packages/engine/src/hooks/temp-guard.ts simpleCommands decodes ANSI-C quoting: a `$'...'` span is a quoted span whose escapes (`\xHH`, `\NNN` octal, `\n`, `\t` and the like) are read as bash reads them, and `$"..."` is read as a double-quoted span, so `$'gh' pr merge 1`, `$'\x67h' pr list` and `$"gh" pr list` give the word gh and are refused
- [ ] #6 The gh check compares a program's basename with gh case-insensitively, so `GH pr merge 1` and `Gh api /user` are refused, while the allowed help forms stay allowed in any case (`GH --version`)
<!-- AC:END -->
