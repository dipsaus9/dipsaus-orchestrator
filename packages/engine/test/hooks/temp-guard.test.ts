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

  it("names the variable and the rule in the reason", () => {
    expect(tempVariableRefusal("DIPO_TMP")).toBe(
      "dipo refused this command because it sets or clears DIPO_TMP; dipo sets DIPO_TMP and the sandbox sets TMPDIR for the run, so never set or clear them (contract rule Temp files); run the command without it.",
    );
  });
});
