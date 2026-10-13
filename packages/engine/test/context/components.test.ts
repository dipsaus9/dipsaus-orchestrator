// The component map (DIPO-46 AC #5; 0010 section 10): validation and matching.

import { describe, expect, it } from "bun:test";

import {
  componentFiles,
  matchComponents,
  validateComponentMap,
  type Component,
} from "../../src/context";

const TRACKED = [
  "packages/cli/src/main.ts",
  "packages/contract/src/index.ts",
  "packages/engine/src/a.ts",
  "packages/engine/src/b.ts",
  "packages/tui/src/app.ts",
];

const valid = (text: string): readonly Component[] => {
  const result = validateComponentMap(text, TRACKED);
  if (result.state !== "valid") throw new Error(JSON.stringify(result));
  return result.components;
};

describe("validateComponentMap", () => {
  it("accepts a valid map", () => {
    const result = validateComponentMap(
      `components:
  contract: { paths: ["packages/contract/**"], purpose: "Shared types." }
  engine: { paths: ["packages/engine/**"], depends_on: ["contract"] }
`,
      TRACKED,
    );
    expect(result).toEqual({
      state: "valid",
      warnings: [],
      components: [
        {
          name: "contract",
          paths: ["packages/contract/**"],
          dependsOn: [],
          purpose: "Shared types.",
        },
        { name: "engine", paths: ["packages/engine/**"], dependsOn: ["contract"], purpose: null },
      ],
    });
  });

  it("reports a cycle", () => {
    const result = validateComponentMap(
      `components:
  engine: { paths: ["packages/engine/**"], depends_on: ["tui"] }
  tui: { paths: ["packages/tui/**"], depends_on: ["cli"] }
  cli: { paths: ["packages/cli/**"], depends_on: ["engine"] }
  contract: { paths: ["packages/contract/**"], depends_on: ["contract"] }
`,
      TRACKED,
    );
    expect(result).toEqual({
      state: "invalid",
      warnings: [],
      errors: [
        "components depend on each other in a cycle: cli -> engine -> tui -> cli",
        "components depend on each other in a cycle: contract -> contract",
      ],
    });
  });

  it("reports bad names, missing dependencies, bad shapes and unknown keys", () => {
    const result = validateComponentMap(
      `components:
  Engine: { paths: ["packages/engine/**"] }
  tui: { paths: ["packages/tui/**"], depends_on: ["nope"], owner: me }
  cli: { paths: [] }
  contract: nope
extra: 1
`,
      TRACKED,
    );
    expect(result.state).toBe("invalid");
    expect(result.state === "invalid" ? result.errors : []).toEqual([
      ".dipo/components.yaml: unknown key `extra`",
      'component "Engine": names use only a-z, 0-9 and "-"',
      'component "cli": `paths` must be a non-empty list of globs',
      'component "contract": expected a mapping with `paths`',
      'component "tui": unknown key `owner`',
      'component "tui": depends_on "nope" does not exist',
    ]);
  });

  it("warns for a glob that matches no tracked file, without failing", () => {
    const result = validateComponentMap(
      `components:
  docs: { paths: ["docs/**", "packages/cli/**"] }
`,
      TRACKED,
    );
    expect(result.state).toBe("valid");
    expect(result.warnings).toEqual(['component "docs": glob "docs/**" matches no tracked file']);
  });

  it("reports YAML and shape errors without throwing", () => {
    expect(validateComponentMap("components: [", TRACKED).state).toBe("invalid");
    expect(validateComponentMap("other: 1\n", TRACKED)).toEqual({
      state: "invalid",
      errors: [".dipo/components.yaml: expected a mapping with `components`"],
      warnings: [],
    });
  });
});

const names = (matches: ReturnType<typeof matchComponents>) =>
  matches.map((match) => `${match.component.name}:${match.via}`);

describe("matchComponents", () => {
  const components = valid(`components:
  contract: { paths: ["packages/contract/**"] }
  engine: { paths: ["packages/engine/**"], depends_on: ["contract"] }
  tui: { paths: ["packages/tui/**"], depends_on: ["contract"] }
  cli: { paths: ["packages/cli/**"], depends_on: ["engine", "tui"] }
`);

  it("matches a file and adds direct neighbours both ways", () => {
    expect(
      names(matchComponents(components, [{ kind: "file", path: "packages/engine/src/a.ts" }])),
    ).toEqual(["engine:scope", "cli:depended-on-by", "contract:depends-on"]);
  });

  it("matches a new path by its own name and a directory by a file under it", () => {
    expect(
      names(
        matchComponents(components, [
          { kind: "new", path: "packages/contract/src/new.ts" },
          { kind: "dir", path: "packages/tui", files: ["packages/tui/src/app.ts"] },
        ]),
      ),
    ).toEqual(["contract:scope", "tui:scope", "cli:depended-on-by", "engine:depended-on-by"]);
  });

  it("matches nothing for a scope outside every component", () => {
    expect(matchComponents(components, [{ kind: "new", path: "README.md" }])).toEqual([]);
  });

  it("lists a component's tracked files", () => {
    expect(
      componentFiles(components.find((c) => c.name === "engine") as Component, TRACKED),
    ).toEqual(["packages/engine/src/a.ts", "packages/engine/src/b.ts"]);
  });
});
