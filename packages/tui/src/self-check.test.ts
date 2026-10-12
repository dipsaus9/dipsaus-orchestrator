import { describe, expect, it } from "bun:test";

import { checkInk, INK_SELF_CHECK_NAME } from "./self-check";

describe("ink self-check", () => {
  it("renders an Ink component to a PassThrough stream", async () => {
    await checkInk();
  });

  it("is named ink", () => {
    expect(INK_SELF_CHECK_NAME).toBe("ink");
  });
});
