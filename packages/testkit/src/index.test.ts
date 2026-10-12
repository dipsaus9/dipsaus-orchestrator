import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { packageName } from "./index";

const PACKAGES = join(import.meta.dir, "..", "..");

type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const manifests = readdirSync(PACKAGES).map(
  (dir) => JSON.parse(readFileSync(join(PACKAGES, dir, "package.json"), "utf8")) as Manifest,
);

describe("testkit", () => {
  it("names its package", () => {
    expect(packageName).toBe("@dipsaus-orchestrator/testkit");
  });

  it("is a devDependency only, never a runtime dependency of another package", () => {
    const runtimeUsers = manifests
      .filter((m) => m.dependencies?.[packageName] !== undefined)
      .map((m) => m.name);
    expect(runtimeUsers).toEqual([]);
  });

  it("depends on neither engine nor daemon", () => {
    const own = manifests.find((m) => m.name === packageName);
    const deps = { ...own?.dependencies, ...own?.devDependencies };
    expect(Object.keys(deps)).not.toContain("@dipsaus-orchestrator/engine");
    expect(Object.keys(deps)).not.toContain("@dipsaus-orchestrator/daemon");
  });
});
