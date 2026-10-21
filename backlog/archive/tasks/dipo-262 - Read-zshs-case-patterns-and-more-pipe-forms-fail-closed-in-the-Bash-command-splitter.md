---
id: DIPO-262
title: >-
  Read zsh's $$', case patterns and more pipe forms fail-closed in the Bash
  command splitter
status: Refined
assignee: []
created_date: '2026-10-21 01:03'
updated_date: '2026-10-21 09:21'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/hooks/temp-guard.ts
  - packages/engine/src/hooks/gh-guard.ts
  - packages/engine/test/hooks/temp-guard.test.ts
  - packages/engine/test/hooks/gh-guard.test.ts
priority: medium
type: enhancement
ordinal: 251000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the gh check and the temp guard refuse forms the shared splitter reads differently from bash or zsh today: `$$'` read the zsh way, a case pattern's `)` inside `$(...)`, and a redirection before the program. The gh check also refuses `|&`, a line break after `|`, a `( ... )` or `{ ...; }` group as a pipe stage, and `cat <<<` feeding a shell. The temp guard, which today does not follow piped stdin into a shell at all, checks a shell's here-string and piped stdin as the gh check does.

Context: advisories of the DIPO-242 review (PR #299). All of these passed before DIPO-242 too, so none is a regression. zsh, the Claude CLI's usual shell on macOS, reads `$$'...'` as the PID followed by an ANSI-C span, where `\'` does not close the quote. bash reads a plain quote. So `echo $$'\' A '; gh pr list; echo ' B '` runs gh under zsh and passes. closingParen in packages/engine/src/hooks/temp-guard.ts counts the `)` of an unparenthesised case pattern as the end of `$(`, so `echo "$(case x in x) gh pr list;; esac)"` passes. Other forms that pass:
- `>/dev/null gh pr list`, `2>&1 gh pr list` and `<<< 'gh pr list' bash` (a redirection before the program);
- `echo gh pr list |& bash` and `echo gh pr list |` with `bash` on the next line;
- `(echo gh pr list) | bash`, `{ echo gh pr list; } | bash` and `echo gh pr list | (bash)`;
- `cat <<< 'gh pr list' | bash`.

The temp guard passes `>/dev/null DIPO_TMP=/x bun test`, `>/dev/null env DIPO_TMP=/x ls`, `<<< 'DIPO_TMP=/x bun test' bash` and `echo DIPO_TMP=/x bun test | bash` today.

Out of scope: wrappers not in the table (caffeinate, arch, script, su -c, find -exec), brace and glob expansion, process substitution, and interpreters such as node -e.

```dipo
branch: "DIPO-262/splitter-dialect-fail-closed"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When a `'` follows `$$`, the text is read both ways (bash: a plain quote; zsh: an ANSI-C span), and the command is refused when either reading refuses, so `echo $$'\' A '; gh pr list; echo ' B '` and `echo $$'\' A '; DIPO_TMP=/x bun test; echo ' B '` are refused
- [ ] #2 closingParen in packages/engine/src/hooks/temp-guard.ts does not count the `)` of a case pattern inside `$(...)` as its closer, so `echo "$(case x in x) gh pr list;; esac)"` and `echo "$(case x in x) DIPO_TMP=/x bun test;; esac)"` are refused
- [ ] #3 Redirections before the program are skipped when the program is found, so `>/dev/null gh pr list`, `2>&1 gh pr list`, `<<< 'gh pr list' bash`, `>/dev/null DIPO_TMP=/x bun test` and `>/dev/null env DIPO_TMP=/x ls` are refused
- [ ] #4 `|&` and a line break after `|` join a pipe; a `( ... )` or `{ ...; }` group as a pipe stage passes on what its commands print and gives its stdin to a shell inside it; `cat <<<` passes on its here-string. So `echo gh pr list |& bash`, `echo gh pr list |` with `bash` on the next line, `(echo gh pr list) | bash`, `{ echo gh pr list; } | bash`, `echo gh pr list | (bash)` and `cat <<< 'gh pr list' | bash` are refused
- [ ] #5 The temp guard checks a shell's here-string and its piped stdin as a script, as the gh check does, so `<<< 'DIPO_TMP=/x bun test' bash`, `bash <<< 'export TMPDIR=/x'` and `echo DIPO_TMP=/x bun test | bash` are refused
- [ ] #6 Each case above is a row in packages/engine/test/hooks/gh-guard.test.ts or packages/engine/test/hooks/temp-guard.test.ts, and every row before in both files keeps its result
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Replaced by decision 0021 (worker isolation, DIPO-263, 2026-10-21): there are no per-call Bash guards inside the box (0021 section 7).
<!-- SECTION:NOTES:END -->
