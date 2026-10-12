import { describe, expect, it } from "bun:test";

import { packageName } from "./index";

describe("client", () => {
  it("names its package", () => {
    expect(packageName).toBe("@dipsaus-orchestrator/client");
  });
});
