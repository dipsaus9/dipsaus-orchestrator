import { describe, expect, it } from "bun:test";

import { packageName } from "./index";

describe("testkit", () => {
  it("names its package", () => {
    expect(packageName).toBe("@dipsaus-orchestrator/testkit");
  });
});
