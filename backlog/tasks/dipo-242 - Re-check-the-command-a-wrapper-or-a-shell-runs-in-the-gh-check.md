---
id: DIPO-242
title: Re-check the command a wrapper or a shell runs in the gh check
status: Done
assignee: []
created_date: '2026-10-20 18:34'
updated_date: '2026-10-21 01:01'
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
  - packages/engine/test/hooks/temp-guard.test.ts
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
- [x] #1 In packages/engine/src/hooks/gh-guard.ts a wrapper's wrapped command is found by option parsing, as the temp guard's wrappedCommandAt and envRefusal do (shared from packages/engine/src/hooks/temp-guard.ts), and checked again in full, so `env bash -c 'gh pr list'`, `sudo sh -c 'gh pr list'`, `nice -n5 bash -c 'gh pr list'` and `env -S 'gh pr list'` are refused, and `command -v gh` and `sudo -u gh ls` are allowed
- [x] #2 `function` and `coproc` are skipped before the program, so `function f { gh pr list; }` and `coproc gh pr list` are refused
- [x] #3 A shell without -c that reads a here-string, or that reads its stdin from an earlier stage of a pipe, has that text checked as a script, so `bash <<< 'gh pr list'` and `echo gh pr list | bash` are refused
- [x] #4 Each case of the criteria before is a row in the refused or allowed table of packages/engine/test/hooks/gh-guard.test.ts, and every row there before keeps its result
- [x] #5 In packages/engine/src/hooks/temp-guard.ts simpleCommands decodes ANSI-C quoting: a `$'...'` span is a quoted span whose escapes (`\xHH`, `\NNN` octal, `\n`, `\t` and the like) are read as bash reads them, and `$"..."` is read as a double-quoted span, so `$'gh' pr merge 1`, `$'\x67h' pr list` and `$"gh" pr list` give the word gh and are refused; the temp guard shares simpleCommands, so `export $'DIPO_TMP=/x'`, `$'DIPO_TMP=/x' ls`, `env $'DIPO_TMP=/x' ls` and `unset $'DIPO_TMP'` are refused too (rows in packages/engine/test/hooks/temp-guard.test.ts), and every temp-guard row before keeps its result
- [x] #6 The gh check compares a program's basename with gh case-insensitively, so `GH pr merge 1` and `Gh api /user` are refused, while the allowed help forms stay allowed whatever the letter case of the program name (`GH --version` is a row in the allowed table)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by dipo run run_01M5DX38NPT02G21QHC1XVCWPA (37 turns, $0.47, 10 min); dipo's reviewer approved round 1 with one advisory.

Finish commits (DIPO-242/gh-check-wrapped-commands-finish), from probing old vs new code with candidate strings:
- Regressions fixed: an option missing from a wrapper's table hid the gh word after it (doas -a style gh, sudo -r/-t, stdbuf --output L, env -a). ghWordRefusal now refuses any gh word behind a wrapper that is no known option's value, as the code before this story did; sudo -u gh ls and command -v gh stay allowed (AC #1).
- Regressions fixed: `$$'` and an escaped `\$'` were read as ANSI-C quoting in simpleCommands and closingParen, which shifted command boundaries (echo $$'\'; gh pr list; echo 'x'). A here-string hid a here-doc body (bash <<< x <<EOF), and an echo/printf stage hid the stdin it passes on (echo "$(cat)").
- Pre-existing bypasses closed: bash -c -- / -c -x (every word after -c is checked), printf '%s\n' and echo -e piped into a shell (decoded texts), 0<<<, more shells (mksh, ash, yash, fish, csh, ...), setsid and busybox as wrappers, an ANSI-C string ends at a NUL, and nesting past MAX_DEPTH is refused when it holds a gh word.
- Known false refusals, kept on purpose: a gh word behind a wrapper as a plain argument (timeout 30 grep gh file), and bash -c 'x' gh.

Left for follow-ups: temp guard program names are case-sensitive and it has no doas/timeout/nice tables (ENV DIPO_TMP=/x bun test, timeout 5 env DIPO_TMP=/x ls pass, pre-existing); the review's list of pre-existing gh forms (redirection first, |&, ( ) and { } pipe stages, cat <<< x | bash, process substitution, unknown wrappers such as caffeinate, script, su -c, find -exec).

The finish branch went through three independent story-reviewer rounds. Round 1 read the code only and missed the regressions. Rounds 2 and 3 probed old against new code with candidate strings; round 3 passed. Verify outside the sandbox: exit 0, 4241 tests. The DIPO_TEST_CI=1 hooks and daemon tests pass (401).
<!-- SECTION:NOTES:END -->
