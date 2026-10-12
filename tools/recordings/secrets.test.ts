import { describe, expect, it } from "bun:test";

import { guardSecrets, machineNeedles, scanForSecrets, SecretFoundError } from "./secrets";

// Shapes are assembled at run time so this file itself holds no token-shaped literal.
const SHAPES: readonly [string, string][] = [
  ["anthropic key", ["sk", "ant", "api03-xyz"].join("-")],
  ["github token", `${"ghp"}_${"a".repeat(36)}`],
  ["github fine-grained token", `${"github"}_pat_11ABC`],
  ["aws access key id", `${"AKIA"}${"ABCDEFGHIJKLMNOP"}`],
  ["bearer token", `Authorization: ${"Bearer"} abc`],
  ["private key", `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`],
  ["email address", `mail ${"someone"}@${"mail"}.example.net`],
  ["home path", `/${"Users"}/someone/.claude`],
  ["home path", `/${"home"}/someone/x`],
];

describe("secret guard", () => {
  for (const [name, sample] of SHAPES) {
    it(`finds a ${name}`, () => {
      const hits = scanForSecrets(`{"a":1}\n{"text":"${sample}"}\n`);
      expect(hits).toContainEqual({ name, line: 2 });
    });
  }

  it("reports the line but never the matched text", () => {
    try {
      guardSecrets("stream.jsonl", `x ${SHAPES[0]?.[1]}`);
      throw new Error("expected a SecretFoundError");
    } catch (error) {
      expect(error).toBeInstanceOf(SecretFoundError);
      expect((error as Error).message).not.toContain(SHAPES[0]?.[1] ?? "");
    }
  });

  it("finds literal needles case-insensitively", () => {
    const hits = scanForSecrets("written by Someone", [{ name: "user", value: "someone" }]);
    expect(hits).toEqual([{ name: "user", line: 1 }]);
  });

  it("allows example.org and example.com email placeholders", () => {
    expect(scanForSecrets("from test@example.org and dev@example.com")).toEqual([]);
    expect(scanForSecrets("test@example.org and x@corp.io")).toEqual([
      { name: "email address", line: 1 },
    ]);
  });

  it("passes placeholders and redaction markers", () => {
    expect(
      scanForSecrets('{"cwd":"${WORKDIR}","text":"[redacted sha256:0123456789ab len:4]"}'),
    ).toEqual([]);
  });

  it("always includes the home directory and ignores short needles", () => {
    const needles = machineNeedles([{ name: "short", value: "ab" }]);
    expect(needles.some((needle) => needle.name === "home directory")).toBe(true);
    expect(needles.some((needle) => needle.name === "short")).toBe(false);
  });
});
