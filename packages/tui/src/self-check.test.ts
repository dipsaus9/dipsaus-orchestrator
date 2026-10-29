import { describe, it } from "bun:test";

import { checkInk } from "./self-check";

describe("ink self-check", () => {
  it("renders an Ink component to a PassThrough stream", async () => {
    await checkInk();
  });
});
