import { describe, expect, it } from "bun:test";

import { packageName } from "./index";

describe("cli", () => {
  it("names its package", () => {
    expect(packageName).toBe("@dipsaus-orchestrator/cli");
  });
});
