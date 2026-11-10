// Bun Worker for `VACUUM INTO` (0007). It opens its own read-only connection, which takes no write
// lock, so the snapshot never pauses the daemon's one JS thread.

import { Database } from "bun:sqlite";

import type { VacuumReply, VacuumRequest } from "./sqlite";

declare const self: Worker;

function snapshot({ source, target }: VacuumRequest): VacuumReply {
  const db = new Database(source, { readonly: true, strict: true });
  try {
    db.query("vacuum into $target").run({ target });
  } finally {
    db.close();
  }
  return { ok: true };
}

self.addEventListener("message", (event: MessageEvent<VacuumRequest>) => {
  let reply: VacuumReply;
  try {
    reply = snapshot(event.data);
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // A Worker has no origin; the empty transfer list is the second argument.
  self.postMessage(reply, []);
});
