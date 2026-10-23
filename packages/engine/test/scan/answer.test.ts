// The fallback session's answer (DIPO-310 criterion 4): checked against the schema, the request
// and dipo's base copy before anything is stored. A schema failure drops the whole answer; a
// proposal that names a script, target or file the base copy does not have, or a working
// directory outside it, is dropped with the check named; the others pass.

import { describe, expect, it } from "bun:test";

import { checkAnswer, normalCwd, SCAN_ANSWER_JSON_SCHEMA } from "../../src/scan/answer";
import type { RequestItem } from "../../src/scan/evidence";

const BASE = {
  files: [
    "package.json",
    "Makefile",
    "scripts/check.sh",
    "apps/web/package.json",
    "apps/web/src/main.ts",
    "README.md",
  ],
  texts: {
    "package.json": JSON.stringify({ scripts: { test: "vitest run", "verify:puzzle": "x" } }),
    "apps/web/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    Makefile: "check: lint test\n\t./scripts/check.sh\nlint:\n\toxlint\n",
  },
};

const ASKED: RequestItem[] = [
  { capability: "verify", status: "unresolved", candidates: [] },
  { capability: "dev", status: "unresolved", candidates: [] },
  { capability: "setup", status: "unresolved", candidates: [] },
];

const proposal = (over: Record<string, unknown> = {}) => ({
  capability: "verify",
  commands: [["make", "check"]],
  cwd: ".",
  evidence: ["Makefile: target check runs lint and test"],
  confidence: "medium",
  ...over,
});

const check = (proposals: unknown[]) => checkAnswer({ proposals }, ASKED, BASE);

describe("checkAnswer", () => {
  it("passes a proposal whose target exists, with its spec, evidence and the model's confidence", () => {
    const result = check([proposal()]);
    expect(result).toEqual({
      ok: true,
      accepted: [
        {
          capability: "verify",
          spec: { commands: [["make", "check"]], cwd: "." },
          modelConfidence: "medium",
          evidence: ["Makefile: target check runs lint and test"],
        },
      ],
      dropped: [],
    });
  });

  it("drops a proposal naming a script package.json does not have (existence)", () => {
    const result = check([proposal({ commands: [["bun", "run", "verify"]] })]);
    expect(result.ok && result.dropped).toEqual([
      {
        capability: "verify",
        check: "existence",
        detail: 'the script "verify" is not in package.json',
      },
    ]);
    expect(result.ok && result.accepted).toEqual([]);
  });

  it("finds a script in the package.json of the working directory", () => {
    const result = check([
      proposal({ capability: "dev", commands: [["pnpm", "run", "dev"]], cwd: "apps/web" }),
    ]);
    expect(result.ok && result.accepted.map((p) => p.spec)).toEqual([
      { commands: [["pnpm", "run", "dev"]], cwd: "apps/web" },
    ]);
  });

  it("drops a proposal naming a file the base copy does not have (existence)", () => {
    const result = check([proposal({ commands: [["sh", "scripts/missing.sh"]] })]);
    expect(result.ok && result.dropped[0]).toMatchObject({
      check: "existence",
      detail: "the file scripts/missing.sh is not in the repository",
    });
    const program = check([proposal({ commands: [["./scripts/gone.sh"]] })]);
    expect(program.ok && program.dropped[0]?.detail).toBe(
      "the file scripts/gone.sh is not in the repository",
    );
  });

  it("passes a file the base copy has, and drops a Makefile target it lacks", () => {
    expect(check([proposal({ commands: [["sh", "scripts/check.sh"]] })]).ok).toBe(true);
    const result = check([proposal({ commands: [["make", "ship"]] })]);
    expect(result.ok && result.dropped[0]?.detail).toBe('the target "ship" is not in Makefile');
  });

  it("drops a working directory outside the repository or not in it (cwd)", () => {
    for (const cwd of ["../other", "/etc", "apps/none"]) {
      const result = check([proposal({ cwd })]);
      expect(result.ok && result.dropped[0]?.check).toBe("cwd");
    }
  });

  it("drops a path outside the repository", () => {
    const result = check([proposal({ commands: [["sh", "/tmp/x.sh"]] })]);
    expect(result.ok && result.dropped[0]?.detail).toBe(
      "the path /tmp/x.sh is outside the repository",
    );
    const up = check([proposal({ commands: [["sh", "../x.sh"]] })]);
    expect(up.ok && up.dropped[0]?.detail).toBe("the path ../x.sh leaves the repository");
  });

  it("drops a capability the request did not name, and a second proposal of one", () => {
    const result = check([
      proposal({ capability: "build", commands: [["make", "lint"]] }),
      proposal(),
      proposal({ commands: [["make", "lint"]] }),
    ]);
    expect(result.ok && result.dropped.map((d) => d.check)).toEqual(["request", "duplicate"]);
    expect(result.ok && result.accepted).toHaveLength(1);
  });

  it("drops the whole answer on a schema error and names the check", () => {
    for (const bad of [
      { proposals: [proposal({ confidence: "certain" })] },
      { proposals: [proposal({ commands: [] })] },
      { proposals: [proposal({ extra: true })] },
      { proposals: "none" },
      null,
    ]) {
      const result = checkAnswer(bad, ASKED, BASE);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.check).toBe("schema");
      expect(!result.ok && result.detail).toContain("the answer fails the schema");
    }
  });

  it("drops an answer over the size cap", () => {
    const huge = { proposals: [proposal({ evidence: ["x".repeat(40_000)] })] };
    const result = checkAnswer(huge, ASKED, BASE);
    expect(!result.ok && result.check).toBe("size");
  });

  it("cleans terminal control characters at the door before the schema", () => {
    const result = check([proposal({ evidence: ["Makefile\u001b[31m: check"] })]);
    expect(result.ok && result.accepted[0]?.evidence).toEqual(["Makefile: check"]);
  });

  it("offers a JSON Schema for the session's structured output", () => {
    expect(SCAN_ANSWER_JSON_SCHEMA).toMatchObject({ type: "object", required: ["proposals"] });
  });
});

describe("normalCwd", () => {
  it("keeps repo-relative folders and refuses ones that leave the repository", () => {
    expect(normalCwd(".")).toBe(".");
    expect(normalCwd("./apps/web/")).toBe("apps/web");
    expect(normalCwd("apps/../apps/web")).toBe("apps/web");
    expect(normalCwd("../x")).toBeNull();
    expect(normalCwd("/abs")).toBeNull();
  });
});
