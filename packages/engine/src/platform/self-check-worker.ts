// Bun Worker used by the `worker` self-check (DIPO-17). It mirrors 0007 section 1: a Worker opens its
// own read-only connection and writes a `VACUUM INTO` snapshot without taking the write lock.
// `scripts/build.ts` passes this file to `bun build --compile` as an extra entrypoint.

import { Database } from "bun:sqlite";

declare const self: Worker;

type Request = { databasePath: string; snapshotPath: string };

function snapshotRows({ databasePath, snapshotPath }: Request): number {
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    db.run("VACUUM INTO ?", [snapshotPath]);
  } finally {
    db.close();
  }
  const snapshot = new Database(snapshotPath, { readonly: true, strict: true });
  try {
    return snapshot.query<{ n: number }, []>("SELECT count(*) AS n FROM probe").get()?.n ?? -1;
  } finally {
    snapshot.close();
  }
}

self.addEventListener("message", (event: MessageEvent<Request>) => {
  let reply: unknown;
  try {
    reply = { ok: true, rows: snapshotRows(event.data) };
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker has no target origin
  self.postMessage(reply);
});
