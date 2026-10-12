import { describe, expect, it } from "bun:test";

import { runSelfChecks } from "./self-check";

describe("runSelfChecks", () => {
  it("prints one line per passing check and returns 0", async () => {
    const lines: string[] = [];
    const code = await runSelfChecks(
      [
        { name: "a", run: () => undefined },
        { name: "b", run: async () => undefined },
      ],
      (line) => lines.push(line),
    );
    expect(code).toBe(0);
    expect(lines).toEqual(["ok   a", "ok   b"]);
  });

  it("names the failing check, stops there and returns non-zero", async () => {
    const lines: string[] = [];
    let laterRan = false;
    const code = await runSelfChecks(
      [
        { name: "a", run: () => undefined },
        {
          name: "worker",
          run: async () => {
            throw new Error("ModuleNotFound");
          },
        },
        { name: "c", run: () => void (laterRan = true) },
      ],
      (line) => lines.push(line),
    );
    expect(code).toBe(1);
    expect(lines).toEqual(["ok   a", "fail worker: ModuleNotFound"]);
    expect(laterRan).toBe(false);
  });
});
