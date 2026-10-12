import { describe, expect, it } from "bun:test";

import { encode, PAUSE_MESSAGE, STOP_MESSAGE } from "../../src/workers/claude-cli/encode";
import type { HostOp } from "../../src/workers/types";

function written(op: HostOp): unknown {
  if (!("write" in op)) throw new Error(`not a write: ${JSON.stringify(op)}`);
  expect(op.write.endsWith("\n")).toBe(true);
  expect(op.write.slice(0, -1)).not.toContain("\n");
  return JSON.parse(op.write);
}

const user = (content: string, priority?: string) => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
  ...(priority === undefined ? {} : { priority }),
});

describe("claude-cli encode", () => {
  it("sends a steer as a priority next user message", () => {
    const ops = encode({ kind: "steer", text: "Use the existing helper.\nNot a new one." });
    expect(ops).toHaveLength(1);
    expect(written(ops[0]!)).toEqual(user("Use the existing helper.\nNot a new one.", "next"));
  });

  it("sends an answer as the next user message", () => {
    const ops = encode({ kind: "answer", text: "Yes, keep the old flag." });
    expect(ops).toHaveLength(1);
    expect(written(ops[0]!)).toEqual(user("Yes, keep the old flag."));
  });

  it("sends a pause as a priority now message and nothing else", () => {
    const ops = encode({ kind: "pause" });
    expect(ops).toHaveLength(1);
    expect(written(ops[0]!)).toEqual(user(PAUSE_MESSAGE, "now"));
  });

  it("stops with a priority now message, closes stdin, SIGTERM after 10 s and SIGKILL after 30 s", () => {
    const ops = encode({ kind: "stop" });
    expect(ops).toHaveLength(4);
    expect(written(ops[0]!)).toEqual(user(STOP_MESSAGE, "now"));
    expect(ops.slice(1)).toEqual([
      { closeStdin: true },
      { signal: "SIGTERM", afterMs: 10_000 },
      { signal: "SIGKILL", afterMs: 30_000 },
    ]);
  });

  it("kills with SIGKILL at once", () => {
    expect(encode({ kind: "kill" })).toEqual([{ signal: "SIGKILL" }]);
  });
});
