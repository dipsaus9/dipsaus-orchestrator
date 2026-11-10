import { describe, expect, it } from "bun:test";

import { packageName } from "./index";

describe("engine", () => {
  it("names its package", () => {
    expect(packageName).toBe("@dipsaus-orchestrator/engine");
  });
});
