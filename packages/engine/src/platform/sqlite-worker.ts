// Bun Worker for `VACUUM INTO` (0007 sections 1 and 10). It opens its own read-only connection,
// which takes no write lock, so the snapshot never pauses the daemon's one JS thread.

import { Database } from "bun:sqlite";

import type { VacuumReply, VacuumRequest } from "./sqlite";

declare const self: Worker;

function snapshot({ source, target, quickCheck }: VacuumRequest): VacuumReply {
  const db = new Database(source, { readonly: true, strict: true });
  try {
    db.query("vacuum into $target").run({ target });
  } finally {
    db.close();
  }
  if (!quickCheck) return { ok: true };
  const copy = new Database(target, { readonly: true });
  try {
    const rows = copy.query("pragma quick_check").all() as Record<string, unknown>[];
    const result = rows.flatMap((row) => String(Object.values(row)[0]).split("\n"));
    return result.length === 1 && result[0] === "ok"
      ? { ok: true }
      : { ok: false, error: `quick_check: ${result.slice(0, 3).join("; ")}` };
  } finally {
    copy.close();
  }
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
