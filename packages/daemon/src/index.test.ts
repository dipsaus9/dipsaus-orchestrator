import { describe, expect, it } from "bun:test";

import { packageName } from "./index";

describe("daemon", () => {
  it("names its package", () => {
    expect(packageName).toBe("@dipsaus-orchestrator/daemon");
  });
});
