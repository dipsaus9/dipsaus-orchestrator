// The Bash check for DIPO_TMP and TMPDIR (DIPO-194 AC #1, #2): each form that sets or clears the
// variable is refused, alone and inside a compound command; a read, a later argument and a longer
// name pass.

import { describe, expect, it } from "bun:test";

import { refusedTempVariable, tempVariableRefusal } from "../../src/hooks";

const REFUSED: Array<[string, string]> = [
  ["DIPO_TMP=/tmp/x bun test", "DIPO_TMP"],
  ["TMPDIR=/tmp/x bun test", "TMPDIR"],
  ["A=1 DIPO_TMP=/tmp/x bun test", "DIPO_TMP"],
  ["DIPO_TMP=$TMPDIR", "DIPO_TMP"],
  ["TMPDIR+=x", "TMPDIR"],
  ["export DIPO_TMP=$TMPDIR", "DIPO_TMP"],
  ["export FOO=1 TMPDIR=/x", "TMPDIR"],
  ["export -n DIPO_TMP=x", "DIPO_TMP"],
  ["env DIPO_TMP=/tmp/x bun run verify", "DIPO_TMP"],
  ["env -i DIPO_TMP=/tmp/x bun run verify", "DIPO_TMP"],
  ["env -C /x TMPDIR=/y cmd", "TMPDIR"],
  ["env -u TMPDIR bun test", "TMPDIR"],
  ["env -uTMPDIR bun test", "TMPDIR"],
  ["env --unset=DIPO_TMP bun test", "DIPO_TMP"],
  ["env -i -u DIPO_TMP bun test", "DIPO_TMP"],
  ["unset TMPDIR", "TMPDIR"],
  ["unset -v DIPO_TMP", "DIPO_TMP"],
  ["unset FOO TMPDIR", "TMPDIR"],
  ["cd x && export DIPO_TMP=$TMPDIR", "DIPO_TMP"],
  ["export DIPO_TMP=$TMPDIR && bun run verify", "DIPO_TMP"],
  ["cd x; unset TMPDIR; bun test", "TMPDIR"],
  ["ls | DIPO_TMP=x cat", "DIPO_TMP"],
  ["false || TMPDIR=/x bun test", "TMPDIR"],
  ["echo hi\nexport TMPDIR=/x\nbun test", "TMPDIR"],
  ["'export' \"DIPO_TMP=/x\"", "DIPO_TMP"],
  ["bash -c 'export DIPO_TMP=/x && bun test'", "DIPO_TMP"],
  ["(export TMPDIR=/x; bun test)", "TMPDIR"],
  ["command env DIPO_TMP=x bun test", "DIPO_TMP"],
  ["env env TMPDIR=/x bun test", "TMPDIR"],
  // Each form inside a compound command (AC #2).
  ["cd x && TMPDIR=/x", "TMPDIR"],
  ["cd x && env DIPO_TMP=/tmp/x bun run verify", "DIPO_TMP"],
  ["bun install; env -i TMPDIR=/x bun test", "TMPDIR"],
  ["cd x && env -u TMPDIR bun test", "TMPDIR"],
  // After a shell keyword.
  ["if true; then export TMPDIR=/x; fi", "TMPDIR"],
  ["for f in a; do DIPO_TMP=x bun test; done", "DIPO_TMP"],
  ["while true; do unset TMPDIR; done", "TMPDIR"],
  // A shell reads its here-doc body as a script (DIPO-223 AC #1).
  ["bash <<'EOF'\nDIPO_TMP=/x bun test\nEOF", "DIPO_TMP"],
  ["sh <<- EOF\nTMPDIR=/x\nEOF", "TMPDIR"],
  ["cat <<'EOF' | bash\nDIPO_TMP=/x\nEOF", "DIPO_TMP"],
  // A here-string is no here-doc: the next line is a command of its own.
  ["read x <<< y\nDIPO_TMP=/x bun test", "DIPO_TMP"],
  // eval, local, printf -v, read and the wrappers (DIPO-223 AC #2, #3).
  ['eval "DIPO_TMP=/x bun test"', "DIPO_TMP"],
  ["eval 'TMPDIR=/x' bun test", "TMPDIR"],
  ["local TMPDIR=/x", "TMPDIR"],
  ["printf -v TMPDIR %s /x", "TMPDIR"],
  ["printf -vDIPO_TMP %s /x", "DIPO_TMP"],
  ["read TMPDIR <<< /x", "TMPDIR"],
  ["read -a TMPDIR <<< 'a b'", "TMPDIR"],
  ["sudo TMPDIR=/x bun test", "TMPDIR"],
  ["sudo -u me env DIPO_TMP=/x bun test", "DIPO_TMP"],
  ["xargs env TMPDIR=/x bun test", "TMPDIR"],
  ["xargs -I {} -n 1 env DIPO_TMP={} bun test", "DIPO_TMP"],
  // Combined env short options (DIPO-223 AC #4).
  ["env -iu TMPDIR bun test", "TMPDIR"],
  ["env -iuTMPDIR bun test", "TMPDIR"],
  // Command substitution inside double quotes (DIPO-223 AC #5).
  ['echo "$(DIPO_TMP=/x bun test)"', "DIPO_TMP"],
  ['echo "`TMPDIR=/x bun test`"', "TMPDIR"],
  // A shell reached through a wrapper, a pipe or a group reads the here-doc body too.
  ["sudo bash <<'EOF'\nDIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["env bash <<'EOF'\nDIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["env -i bash <<EOF\nDIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["cat <<'EOF' | sudo bash\nDIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["cat <<'EOF' | env bash\nDIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["cat <<'EOF' | grep x | bash\nDIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["{ bash; } <<'EOF'\nDIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["( bash ) <<'EOF'\nDIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["(bash) <<'EOF'\nexport DIPO_TMP=/x\nEOF", "DIPO_TMP"],
  // A here-doc on the closing word of an if, loop or case compound is the body of the shell inside
  // it (DIPO-237 AC #2).
  ["if true; then bash; fi <<'EOF'\nexport DIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["if true; then bash; fi <<'EOF'\nexport TMPDIR=/x\nEOF", "TMPDIR"],
  ["while read l; do bash; done <<'EOF'\nexport DIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["until false; do sh; done <<'EOF'\nexport DIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["for i in a; do bash; done <<'EOF'\nexport DIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["while read l; do bash; done <<'EOF'\nexport TMPDIR=/x\nEOF", "TMPDIR"],
  ["until false; do sh; done <<'EOF'\nexport TMPDIR=/x\nEOF", "TMPDIR"],
  ["for i in a; do bash; done <<'EOF'\nexport TMPDIR=/x\nEOF", "TMPDIR"],
  ["case x in x) bash ;; esac <<'EOF'\nexport DIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["case x in x) bash ;; esac <<'EOF'\nexport TMPDIR=/x\nEOF", "TMPDIR"],
  ["case x in (x) bash ;; esac <<'EOF'\nexport DIPO_TMP=/x\nEOF", "DIPO_TMP"],
  // A nested compound: the shell two compounds deep reads the body of the outer closing word.
  ["if true; then for i in a; do bash; done; fi <<'EOF'\nexport DIPO_TMP=/x\nEOF", "DIPO_TMP"],
  ["{ if true; then bash; fi; } <<'EOF'\nexport DIPO_TMP=/x\nEOF", "DIPO_TMP"],
  // A command substitution is no group: the shell inside it does not read the body of cat, but
  // a `$(` export is still checked on its own (DIPO-237 AC #3).
  ["x=$(export DIPO_TMP=/x) true", "DIPO_TMP"],
  // A parenthesis inside quotes or a here-doc body does not hide the rest of the text.
  ["echo \"$(echo '(')\"; DIPO_TMP=/x bun test", "DIPO_TMP"],
  ['echo "$(echo :-()" && DIPO_TMP=/x bun test', "DIPO_TMP"],
  ["git commit -m \"$(cat <<'EOF'\n...(see below\nEOF\n)\" && DIPO_TMP=/x bun test", "DIPO_TMP"],
  // An arithmetic shift opens no here-doc.
  ["echo $((1<<2))\nDIPO_TMP=/x bun test", "DIPO_TMP"],
  ["(( x = 1<<2 ))\nDIPO_TMP=/x bun test", "DIPO_TMP"],
  ['echo "$((1<<2))"\nDIPO_TMP=/x bun test', "DIPO_TMP"],
  // Long wrapper options with a separate value.
  ["sudo --user me TMPDIR=/x bun test", "TMPDIR"],
  ["xargs --max-args 1 env TMPDIR=/x bun test", "TMPDIR"],
];

const PASSED = [
  "",
  "bun run verify",
  "echo $DIPO_TMP",
  "echo ${TMPDIR}/x",
  'ls "$DIPO_TMP" && cat ${TMPDIR}',
  "echo DIPO_TMP=1",
  "echo TMPDIR=1 > out.txt",
  "grep -r DIPO_TMP=x src",
  "DIPO_TMP_ROOT=x bun test",
  "export DIPO_TMP_ROOT=x",
  "export DIPO_TMP",
  "unset DIPO_TMP_ROOT",
  "env FOO=1 bun test",
  "env -u FOO bun test",
  "env | grep TMPDIR",
  "cd x && echo 'export DIPO_TMP=1'",
  "# export DIPO_TMP=1\nbun test",
  "bun test --preload TMPDIR=x",
  "git commit -m 'unset TMPDIR'",
  // A here-doc body is not split, unless a shell reads it (DIPO-223 AC #1).
  "cat > s.sh <<'EOF'\nDIPO_TMP=/x bun test\nEOF",
  "cat > s.sh <<-EOF\n\tTMPDIR=/x\n\tEOF",
  "bash -c 'echo hi' <<'EOF'\nDIPO_TMP=/x\nEOF",
  "read x <<< y",
  "printf -v DIPO_TMP_ROOT %s x",
  "read -d TMPDIR line",
  "local DIPO_TMP_ROOT=x",
  'eval "echo DIPO_TMP=1"',
  "sudo -u me env FOO=1 bun test",
  "env -iC /x bun test",
  "echo '$(DIPO_TMP=/x bun test)'",
  "printf -- -v TMPDIR",
  'eval "DIPO_TMP_ROOT=/x bun test"',
  "read DIPO_TMP_ROOT <<< x",
  "cat > s.sh <<EOF\nDIPO_TMP=/x bun test\nEOF",
  "git commit -m \"$(cat <<'EOF'\nTMPDIR=/x (\nEOF\n)\"",
  "{ cat; } <<'EOF'\nDIPO_TMP=/x\nEOF",
  // The closing word of an if, loop or case compound with cat, or as an argument, reads no shell
  // (DIPO-237 AC #2).
  "if true; then cat; fi <<'EOF'\nexport DIPO_TMP=/x\nEOF",
  "if true; then cat; fi <<'EOF'\nexport TMPDIR=/x\nEOF",
  "while read l; do cat; done <<'EOF'\nexport DIPO_TMP=/x\nEOF",
  "until false; do cat; done <<'EOF'\nexport DIPO_TMP=/x\nEOF",
  "for i in a; do cat; done <<'EOF'\nexport DIPO_TMP=/x\nEOF",
  "case x in x) cat ;; esac <<'EOF'\nexport DIPO_TMP=/x\nEOF",
  "echo done <<'EOF'\nexport DIPO_TMP=/x\nEOF",
  "while read l; do echo done; done <<'EOF'\nexport DIPO_TMP=/x\nEOF",
  "echo fi <<'EOF'\nexport DIPO_TMP=/x\nEOF",
  "while read l; do cat; done <<'EOF'\nexport TMPDIR=/x\nEOF",
  "until false; do cat; done <<'EOF'\nexport TMPDIR=/x\nEOF",
  "for i in a; do cat; done <<'EOF'\nexport TMPDIR=/x\nEOF",
  "case x in x) cat ;; esac <<'EOF'\nexport TMPDIR=/x\nEOF",
  "echo done <<'EOF'\nexport TMPDIR=/x\nEOF",
  // A command substitution is no group: the command it is a word of reads no body (DIPO-237 AC #3).
  "x=$(bash ./mk.sh) cat > f <<'EOF'\nexport DIPO_TMP=/x\nEOF",
];

describe("refusedTempVariable (pure)", () => {
  for (const [command, variable] of REFUSED) {
    it(`refuses ${JSON.stringify(command)} for ${variable}`, () => {
      expect(refusedTempVariable(command)).toBe(variable);
    });
  }

  it("refuses the command of run_01M5619VZDHNJH9AHJY3VCZAYK", () => {
    expect(refusedTempVariable("export DIPO_TMP=$TMPDIR && bun run verify")).toBe("DIPO_TMP");
  });

  for (const command of PASSED) {
    it(`passes ${JSON.stringify(command)}`, () => {
      expect(refusedTempVariable(command)).toBeNull();
    });
  }

  it("ends without throwing on unterminated and long input", () => {
    const texts = [
      "bash <<'EOF'\nDIPO_TMP=/x\n",
      "cat <<",
      "echo 'abc; TMPDIR=/x",
      'echo "$(abc; TMPDIR=/x',
      "echo \\",
      '"$('.repeat(34_000),
      "(".repeat(100_000),
      "cat <<E\n".repeat(12_500),
      "{ ".repeat(25_000) + "} ".repeat(25_000),
      "a|".repeat(50_000),
    ];
    for (const text of texts) expect(() => refusedTempVariable(text)).not.toThrow();
    expect(refusedTempVariable("bash <<'EOF'\nDIPO_TMP=/x\n")).toBe("DIPO_TMP");
  });

  it("names the variable and the rule in the reason", () => {
    expect(tempVariableRefusal("DIPO_TMP")).toBe(
      "dipo refused this command because it sets or clears DIPO_TMP; dipo sets DIPO_TMP and the sandbox sets TMPDIR for the run, so never set or clear them (contract rule Temp files); run the command without it.",
    );
  });
});
