// The client half of the hook relay (0008 section 5, DIPO-59): `dipo hook <event>` connects to the
// worker host named by `DIPO_HOST_SOCKET`, offers the protocol versions that have the `hook` op,
// sends the payload and returns what the host answers. Every failure (no socket, a refused or
// unknown version, a timeout) returns null: the relay is silent, and a hook that prints nothing
// gives no decision.

import type { Clock } from "@dipsaus-orchestrator/contract";

import { connectHost } from "./client";
import { HOOK_PROTOCOL_VERSIONS, MAX_HOOK_PAYLOAD } from "./protocol";

/** How much longer than `waitMs` the relay waits for the host's answer to a waiting call. */
export const HOOK_REPLY_GRACE_MS = 10_000;

export interface HookRelayRequest {
  readonly socketPath: string;
  readonly runId: string;
  readonly payload: string;
  /** How long the call may wait for the engine's reply; absent for a call that does not wait. */
  readonly waitMs?: number;
  readonly clock: Clock;
  /** The time for the handshake, and for the answer of a call that does not wait. */
  readonly timeoutMs: number;
  /** Versions offered in the handshake; this binary's hook versions by default. */
  readonly versions?: readonly number[];
}

/** The host's output for the call (empty for no decision), or null when the relay failed. */
export async function relayHookPayload(request: HookRelayRequest): Promise<string | null> {
  if (request.payload.length > MAX_HOOK_PAYLOAD) return null;
  let connected;
  try {
    connected = await connectHost(request.socketPath, {
      runId: request.runId,
      clock: request.clock,
      timeoutMs: request.timeoutMs,
      versions: request.versions ?? HOOK_PROTOCOL_VERSIONS,
    });
  } catch {
    return null;
  }
  if (!connected.ok) return null;
  const { client } = connected;
  try {
    const waits = request.waitMs !== undefined && request.waitMs > 0;
    const reply = await client.request(
      {
        op: "hook",
        payload: request.payload,
        ...(waits ? { waitMs: request.waitMs } : {}),
      },
      waits ? (request.waitMs ?? 0) + HOOK_REPLY_GRACE_MS : request.timeoutMs,
    );
    if (reply === null || !reply.ok) return null;
    const output = (reply.result as { output?: unknown } | undefined)?.output;
    return typeof output === "string" ? output : "";
  } catch {
    return null;
  } finally {
    client.close();
  }
}
