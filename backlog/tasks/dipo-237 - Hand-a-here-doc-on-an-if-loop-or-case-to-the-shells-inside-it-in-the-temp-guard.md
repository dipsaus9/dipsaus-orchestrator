---
id: DIPO-237
title: >-
  Hand a here-doc on an if, loop or case to the shells inside it in the temp
  guard
status: Ready
assignee: []
created_date: '2026-10-20 10:40'
updated_date: '2026-10-20 13:38'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies:
  - DIPO-223
references:
  - packages/engine/src/hooks/temp-guard.ts
  - packages/engine/test/hooks/temp-guard.test.ts
priority: medium
type: bug
ordinal: 237000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the worker Bash temp guard refuses a shell inside an if, while, until, for or case compound that reads a here-doc body setting DIPO_TMP or TMPDIR, as main refused it before DIPO-223, and no longer refuses a command whose unquoted `$(...)` runs a shell while the command itself reads such a body.

Context: DIPO-223 (PR #264, merged) gives simpleCommands in packages/engine/src/hooks/temp-guard.ts here-doc bodies: a body goes to the command that opens it and, for the `}` of a `{ ...; }` group or the command after the `)` of a `( ... )` group, to each command inside the group; a shell (sh, bash, zsh, dash, ksh) without -c that reads a body is checked against it. Probed on that branch with refusedTempVariable and a body `export DIPO_TMP=/x`: (1) `if true; then bash; fi <<'EOF'` passes, and so do the same forms with while, until, for and case: the `fi`, `done` or `esac` command gets the body and the shell inside does not. origin/main, with no here-doc handling, refuses them, since it reads the body lines as commands. (2) An unquoted `$(` is read as a `$` word and a `(` group, so in `x=$(bash ./mk.sh) cat > f <<'EOF'` the command after the `)` carries the group and the body goes to `bash ./mk.sh`, which is refused, although the substitution runs before cat and does not read cat's here-doc. KEYWORDS holds if, then, else, elif, do, while and until; listStart marks a command that holds only keywords and `{`. The refused and passed tables are in packages/engine/test/hooks/temp-guard.test.ts. This story builds on DIPO-223's code.

```dipo
branch: "DIPO-237/temp-guard-heredoc-compounds"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) refused-table rows: a shell inside if, while, until, for and case compounds with a here-doc on fi, done or esac whose body sets DIPO_TMP or TMPDIR, including one nested compound"
    - kind: "automated"
      check: "(unit) passed-table rows: the same compounds with cat in place of the shell, a closing word that is an argument such as echo done, and x=$(bash ./mk.sh) cat > f with a DIPO_TMP body"
    - kind: "automated"
      check: "(unit) refused-table rows: x=$(export DIPO_TMP=/x) true, and (bash) with a DIPO_TMP here-doc body; the rows DIPO-223 added still pass"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 In packages/engine/src/hooks/temp-guard.ts an if, while, until, for or case compound is a group as `{ ...; }` is: its opening word counts only where a command starts, its closing `fi`, `done` or `esac` only as the first word of a command, and a here-doc opened on the closing word is the body of each command inside the compound that has none of its own, nested compounds and groups included
- [ ] #2 refusedTempVariable refuses, with a here-doc body `export DIPO_TMP=/x` and with one setting TMPDIR, `if true; then bash; fi <<'EOF'`, `while read l; do bash; done <<'EOF'`, `until false; do sh; done <<'EOF'`, `for i in a; do bash; done <<'EOF'` and `case x in x) bash ;; esac <<'EOF'`, and passes the same compounds with `cat` in place of the shell and `echo done <<'EOF'`
- [ ] #3 An unquoted `$(...)` is a command substitution, not a group: the commands inside it are still checked on their own, so `x=$(export DIPO_TMP=/x) true` is refused, but a here-doc of the command it is a word of is not their body, so `x=$(bash ./mk.sh) cat > f <<'EOF'` with a DIPO_TMP body passes; `(bash) <<'EOF'` with that body is still refused
- [ ] #4 Each case of the two criteria before is a row in the refused or passed table of packages/engine/test/hooks/temp-guard.test.ts, and the rows DIPO-223 added keep passing
<!-- AC:END -->
