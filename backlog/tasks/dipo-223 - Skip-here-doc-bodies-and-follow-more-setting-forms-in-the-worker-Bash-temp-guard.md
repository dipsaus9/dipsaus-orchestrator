---
id: DIPO-223
title: >-
  Skip here-doc bodies and follow more setting forms in the worker Bash temp
  guard
status: Refined
assignee: []
created_date: '2026-10-19 23:02'
updated_date: '2026-10-20 07:19'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - packages/engine/src/hooks/temp-guard.ts
  - packages/engine/test/hooks/temp-guard.test.ts
priority: medium
type: bug
ordinal: 223000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the worker Bash temp guard no longer refuses a command whose here-doc only writes a DIPO_TMP assignment into a file, and refuses the forms that set or clear DIPO_TMP or TMPDIR that DIPO-194 does not follow.

Context: review of DIPO-194 (PR #244). The rule is the 0008 section 5 amendment of 2026-10-19: dipo hook PreToolUse denies a Bash command that sets or clears DIPO_TMP or TMPDIR, also inside a compound command, and the check fails open. The amendment lists the forms DIPO-194 built (a prefix or bare assignment, export, env, unset); the forms below set or clear the same variables under the same rule. packages/engine/src/hooks/temp-guard.ts splits the text at newlines, so a here-doc body is read as commands: `cat > s.sh <<'EOF'`, a body line `DIPO_TMP=/x bun test` and `EOF` is refused, though the body is only written to s.sh. These set or clear the variable and pass today: `eval "DIPO_TMP=/x bun test"`, `local TMPDIR=/x`, `printf -v TMPDIR %s /x`, `read TMPDIR <<< /x`, `sudo TMPDIR=/x bun test`, `xargs env TMPDIR=/x bun test`, `env -iu TMPDIR bun test` (combined short options) and `echo "$(DIPO_TMP=/x bun test)"` (the text inside double quotes is never split).

```dipo
branch: "DIPO-223/temp-guard-heredoc-more-forms"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) cat > s.sh with a quoted or unquoted here-doc whose body sets DIPO_TMP passes; bash and sh reading the same here-doc are refused"
    - kind: "automated"
      check: "(unit) eval, local, printf -v and read with a guarded name are refused, and the same commands with DIPO_TMP_ROOT pass"
    - kind: "automated"
      check: "(unit) sudo TMPDIR=/x bun test, sudo -u me env DIPO_TMP=/x bun test and xargs env TMPDIR=/x bun test are refused"
    - kind: "automated"
      check: "(unit) env -iu TMPDIR bun test and env -iuTMPDIR bun test are refused, and env -iC /x bun test passes"
    - kind: "automated"
      check: "(unit) a command substitution with a guarded assignment inside double quotes, as $(...) or in backticks, is refused, and the same text in single quotes passes"
    - kind: "automated"
      check: "(unit) every REFUSED and PASSED entry that temp-guard.test.ts holds today keeps its result"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A here-doc body (after << or <<- with a quoted or unquoted delimiter, up to the delimiter line) is not split as commands, except when the command that reads it is a shell from SHELLS without -c, whose body is checked as a script; `cat > s.sh <<'EOF'` with a body line that sets DIPO_TMP passes and `bash <<'EOF'` with the same body is refused; `<<<` is a here-string, not a here-doc, so `read x <<< y` followed by a line `DIPO_TMP=/x bun test` is still refused
- [ ] #2 eval's arguments joined by spaces are checked as a command text; local is refused for a guarded assignment as export and declare are; `printf -v` and read are refused when they name DIPO_TMP or TMPDIR as the variable they set (read's -d, -i, -n, -N, -p, -t and -u values skipped, and -a's value checked)
- [ ] #3 sudo and xargs are followed to the command they run, skipping their options and option values (sudo -u, -g, -C, -D, -h, -p, -R, -T and -U; xargs -I, -L, -n, -P, -s, -E, -d and -a), and sudo's leading NAME=value words are checked as assignments
- [ ] #4 env's combined short options are read letter by letter: `-iu TMPDIR` and `-iuTMPDIR` clear TMPDIR and are refused, and `-iC /x` takes /x as the -C value
- [ ] #5 A command substitution inside double quotes, as $(...) or between backticks, is checked as a command text; one inside single quotes is not
- [ ] #6 Tests in packages/engine/test/hooks/temp-guard.test.ts add each form of criteria 1 to 5 to REFUSED or PASSED, and every entry the file holds today keeps its result
<!-- AC:END -->
