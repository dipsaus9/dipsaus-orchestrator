// The role file format (DIPO-471, 0017): the keys, the strictness and the names a file may have.

import { describe, expect, it } from "bun:test";

import { parseRoleFile } from "../../src/roles/parse";

const PATH = ".dipo/roles/developer.md";
const body = "Build the story.\n";
const file = (frontmatter: string, text = body) => `---\n${frontmatter}\n---\n${text}`;

function refusal(path: string, text: string): string {
  const parsed = parseRoleFile(path, text);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.message;
}

describe("parseRoleFile", () => {
  it("loads a role with its name, purpose, instructions, model and effort", () => {
    const parsed = parseRoleFile(
      PATH,
      file("version: 1\npurpose: Builds stories\nmodel: opus\neffort: high"),
    );
    expect(parsed).toEqual({
      ok: true,
      role: {
        name: "developer",
        purpose: "Builds stories",
        instructions: "Build the story.",
        kind: "code",
        model: "opus",
        effort: "high",
      },
    });
  });

  it("leaves model and effort out when the file sets neither", () => {
    const parsed = parseRoleFile(PATH, file("version: 1\npurpose: Builds stories"));
    expect(parsed.ok && Object.keys(parsed.role).toSorted()).toEqual([
      "instructions",
      "kind",
      "name",
      "purpose",
    ]);
  });

  it("loads kind design and docs, and a file without kind as code", () => {
    for (const kind of ["design", "docs"] as const) {
      const parsed = parseRoleFile(PATH, file(`version: 1\npurpose: x\nkind: ${kind}`));
      expect(parsed.ok && parsed.role.kind).toBe(kind);
    }
    const plain = parseRoleFile(PATH, file("version: 1\npurpose: x"));
    expect(plain.ok && plain.role.kind).toBe("code");
  });

  it("refuses an unknown kind naming the file, the key and the three values", () => {
    const message = refusal(PATH, file("version: 1\npurpose: x\nkind: writer"));
    expect(message).toStartWith(`${PATH}: `);
    expect(message).toContain("`kind`");
    expect(message).toContain("code, design, docs");
  });

  it("refuses each fault with a message naming the file", () => {
    const cases: [string, string, string][] = [
      [PATH, file("version: 1\npurpose: x\ntools: [Bash]"), "unknown key `tools`"],
      [PATH, file("purpose: x"), "`version`"],
      [PATH, file("version: 1"), "`purpose`"],
      [PATH, file("version: 1.5\npurpose: x"), "`version`"],
      [PATH, file("version: 2\npurpose: x"), "newer dipo"],
      [PATH, file("version: 1\npurpose: x", "  \n"), "instructions"],
      [PATH, body, "frontmatter"],
      [".dipo/roles/reviewer.md", file("version: 1\npurpose: x"), "reserved"],
      [".dipo/roles/planner.md", file("version: 1\npurpose: x"), "reserved"],
      [".dipo/roles/auditor.md", file("version: 1\npurpose: x"), "reserved"],
      [".dipo/roles/scanner.md", file("version: 1\npurpose: x"), "reserved"],
      [".dipo/roles/Dev_Ops.md", file("version: 1\npurpose: x"), "not a valid role name"],
    ];
    for (const [path, text, problem] of cases) {
      const message = refusal(path, text);
      expect(message).toStartWith(`${path}: `);
      expect(message).toContain(problem);
    }
  });
});
