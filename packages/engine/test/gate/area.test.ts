// The files each role kind may write (0012): one check per area and path shape.

import { describe, expect, it } from "bun:test";

import { inArea } from "../../src/gate/area";

describe("role kind areas", () => {
  it("puts a path in the design area of its own story only", () => {
    expect(inArea("design", "docs/design/DIPO-9/a.md", "DIPO-9")).toBe(true);
    expect(inArea("design", "docs/design/DIPO-9/", "DIPO-9")).toBe(true);
    expect(inArea("design", "docs/design/DIPO-9/a.md", "DIPO-8")).toBe(false);
  });

  it("puts Markdown under docs/ or at the root in the docs area, and nothing else", () => {
    expect(inArea("docs", "README.md", "DIPO-9")).toBe(true);
    expect(inArea("docs", "docs/guide/x.md", "DIPO-9")).toBe(true);
    expect(inArea("docs", "docs/decisions/0001.md", "DIPO-9")).toBe(false);
    expect(inArea("docs", "docs/design/x/a.md", "DIPO-9")).toBe(false);
    expect(inArea("docs", "packages/a.md", "DIPO-9")).toBe(false);
  });

  it("lets a code role write any path", () => {
    expect(inArea("code", "packages/a.ts", "DIPO-9")).toBe(true);
    expect(inArea("code", "docs/decisions/0001.md", "DIPO-9")).toBe(true);
  });
});
