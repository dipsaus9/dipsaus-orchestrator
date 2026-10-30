// The shapes that never change (0005): so `dipo daemon restart` works across versions, the frame
// envelope, the reply frame with `EngineError`, `engine.hello` with its version, `daemon.status`
// (`state`, `pid`, `version`) and `daemon.stop` stay as they are. Each expected value below is
// written out by hand. If this test fails, the change breaks every older and newer client: revert
// it.

import { describe, expect, it } from "bun:test";

import {
  ClientFrame,
  daemonStatus,
  daemonStop,
  EngineError,
  engineHello,
  jsonSchemaOf,
  RequestId,
  ServerFrame,
} from "./index";

const ULID_PATTERN = "^[0-7][0-9A-HJKMNP-TV-Z]{25}$";

function field(schema: unknown, name: string): unknown {
  return (schema as { properties: Record<string, unknown> }).properties[name];
}

describe("the shapes that never change (0005)", () => {
  it("frame envelope: kind on every frame, requestId a ULID", () => {
    expect(jsonSchemaOf(RequestId)).toEqual({ type: "string", pattern: ULID_PATTERN });
    for (const frame of ClientFrame.options) {
      expect(frame.shape.kind).toBeDefined();
      if ("requestId" in frame.shape) expect(frame.shape.requestId).toBe(RequestId);
    }
    expect(ClientFrame.options.map((frame) => frame.shape.kind.value)).toEqual(
      expect.arrayContaining(["command", "read"]),
    );
  });

  it("reply frame: kind reply, ok, requestId and EngineError", () => {
    const reply = ServerFrame.options.find((frame) => frame.shape.kind.value === "reply");
    if (reply === undefined || !("reply" in reply.shape)) throw new Error("no reply frame");
    const schema = jsonSchemaOf(reply.shape.reply);
    const errorBranches = (schema["anyOf"] as { oneOf: unknown[] }[])
      .flatMap((branch) => branch.oneOf)
      .filter((branch) => (field(branch, "ok") as { const: boolean }).const === false);
    expect(errorBranches.length).toBe(2);
    for (const branch of errorBranches) {
      expect(field(branch, "requestId")).toEqual({ type: "string", pattern: ULID_PATTERN });
      expect(field(branch, "error")).toEqual(jsonSchemaOf(EngineError));
    }
  });

  it("EngineError: code, message, retryable, details", () => {
    expect(jsonSchemaOf(EngineError)).toEqual({
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        retryable: { type: "boolean" },
        details: {},
      },
      required: ["code", "message", "retryable"],
    });
  });

  it("engine.hello request, and the daemon's version in its result", () => {
    expect(engineHello.name).toBe("engine.hello");
    expect(jsonSchemaOf(engineHello.args)).toEqual({
      type: "object",
      properties: {
        client: {
          type: "object",
          properties: { name: { type: "string" }, version: { type: "string" } },
          required: ["name", "version"],
        },
      },
      required: ["client"],
    });
    const result = jsonSchemaOf(engineHello.result);
    expect(field(result, "engine")).toEqual({ type: "string" });
    expect(result["required"]).toEqual(expect.arrayContaining(["engine"]));
  });

  it("daemon.status fields state, pid and version", () => {
    expect(daemonStatus.name).toBe("daemon.status");
    const result = jsonSchemaOf(daemonStatus.result);
    expect(field(result, "state")).toEqual({
      type: "string",
      enum: ["starting", "recovering", "running", "draining"],
    });
    expect(field(result, "pid")).toEqual({
      type: "integer",
      exclusiveMinimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(field(result, "version")).toEqual({ type: "string" });
    expect(result["required"]).toEqual(expect.arrayContaining(["state", "pid", "version"]));
  });

  it("daemon.stop { stopWorkers }", () => {
    expect(daemonStop.name).toBe("daemon.stop");
    expect(jsonSchemaOf(daemonStop.args)).toEqual({
      type: "object",
      properties: { stopWorkers: { type: "boolean" } },
      required: ["stopWorkers"],
    });
  });
});
