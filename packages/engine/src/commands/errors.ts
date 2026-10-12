// A command- or read-specific error a handler throws (0005 section 10). The executor rolls the
// transaction back and replies with the error; any other throw becomes `internal`.

import { engineError, type EngineError } from "@dipsaus-orchestrator/contract";

export class CommandError extends Error {
  readonly error: EngineError;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CommandError";
    this.error = engineError(code, message, details);
  }
}

/** The reply error for anything a handler throws. */
export function errorFromThrown(thrown: unknown): EngineError {
  if (thrown instanceof CommandError) return thrown.error;
  const reason = thrown instanceof Error ? thrown.message : String(thrown);
  return engineError("internal", `The engine failed while handling this request: ${reason}`);
}
