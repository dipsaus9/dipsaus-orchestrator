// The frozen minimal surface of 0005 section 11: shapes that never change in any major, so
// `dipo daemon restart` works across a major upgrade (0006 section 14). Each expected value below
// is written out by hand. If this test fails, the change breaks every older and newer client:
// revert it.

import { describe, expect, it } from "bun:test";

import {
  ClientFrame,
  CONTRACT_VERSION,
  ContractUnsupportedDetails,
  daemonStatus,
  daemonStop,
  EngineError,
  engineHello,
  jsonSchemaOf,
  RequestId,
  ServerFrame,
} from "./index";

const ULID_PATTERN = "^[0-7][0-9A-HJKMNP-TV-Z]{25}$";
const VERSION = {
  type: "object",
  properties: {
    major: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    minor: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
  required: ["major", "minor"],
};

function field(schema: unknown, name: string): unknown {
  return (schema as { properties: Record<string, unknown> }).properties[name];
}

describe("frozen minimal surface (0005 section 11)", () => {
  // A minor only adds (0005 section 11); the major is what a client of another binary must match.
  it("contract major is 1", () => {
    expect(CONTRACT_VERSION.major).toBe(1);
    expect(Object.keys(CONTRACT_VERSION).toSorted()).toEqual(["major", "minor"]);
  });

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

  it("engine.hello request", () => {
    expect(engineHello.name).toBe("engine.hello");
    expect(jsonSchemaOf(engineHello.args)).toEqual({
      type: "object",
      properties: {
        contract: VERSION,
        client: {
          type: "object",
          properties: { name: { type: "string" }, version: { type: "string" } },
          required: ["name", "version"],
        },
      },
      required: ["contract", "client"],
    });
  });

  it("contract.unsupported details: the daemon's contract and version", () => {
    expect(jsonSchemaOf(ContractUnsupportedDetails)).toEqual({
      type: "object",
      properties: { contract: VERSION, version: { type: "string" } },
      required: ["contract", "version"],
    });
  });

  it("daemon.status fields state, pid and version", () => {
    expect(daemonStatus.name).toBe("daemon.status");
    const result = jsonSchemaOf(daemonStatus.result);
    expect(field(result, "state")).toEqual({
      type: "string",
      enum: ["starting", "recovering", "running", "draining", "safe"],
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
