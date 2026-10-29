// Pack bytes and the `context_packs` record (0014 sections 5 and 10, 0007 section 4). The same
// pack always encodes to the same bytes: object keys sorted, no timestamps. Per story branch the
// engine keeps the head sha and the git blob ids of the scope and input files the last pack read,
// so a restart can tell which packs are stale.

import { createHash } from "node:crypto";

import type { Clock } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { ContextPack } from "./types";

/**
 * The git blob id of `bytes`, as `git hash-object --no-filters` gives it. The provider hashes the
 * raw work-tree bytes it read, so for a file with clean filters, `text`/`eol` attributes or
 * `core.autocrlf` the id can differ from the index id `git ls-files -s` shows. That is fine for
 * staleness: the same work-tree bytes always give the same id.
 */
export function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Canonical JSON of a pack: sorted keys, no whitespace. */
export function encodePack(pack: ContextPack): string {
  return JSON.stringify(canonical(pack));
}

/** sha256 of the encoded pack, hex. */
export function packDigest(pack: ContextPack): string {
  return createHash("sha256").update(encodePack(pack)).digest("hex");
}

export interface ContextPackRecord {
  /** The story branch (`<ID>/<slug>`) the record belongs to. */
  readonly branch: string;
  readonly headSha: string;
  /** Blob id per repo-relative path. */
  readonly blobIds: Readonly<Record<string, string>>;
  readonly provider: string;
  readonly packSha256: string;
  readonly builtAt: number;
}

/** Stores the pack just built for `branch`, replacing the previous one. */
export function recordContextPack(
  office: OfficeHandle,
  branch: string,
  headSha: string,
  pack: ContextPack,
  clock: Clock,
): ContextPackRecord {
  const record: ContextPackRecord = {
    branch,
    headSha,
    blobIds: pack.blobIds,
    provider: pack.provenance.provider,
    packSha256: packDigest(pack),
    builtAt: clock.now(),
  };
  office.immediate(() =>
    office.run(
      `insert into context_packs (office_id, branch, head_sha, blob_ids, provider, pack_sha256, built_at)
       values ($office_id, $branch, $head, $blobs, $provider, $digest, $at)
       on conflict (office_id, branch) do update set
         head_sha = excluded.head_sha, blob_ids = excluded.blob_ids, provider = excluded.provider,
         pack_sha256 = excluded.pack_sha256, built_at = excluded.built_at`,
      {
        branch,
        head: headSha,
        blobs: JSON.stringify(canonical(record.blobIds)),
        provider: record.provider,
        digest: record.packSha256,
        at: record.builtAt,
      },
    ),
  );
  return record;
}

interface ContextPackRow {
  readonly branch: string;
  readonly head_sha: string;
  readonly blob_ids: string;
  readonly provider: string;
  readonly pack_sha256: string;
  readonly built_at: number;
}

/** The last pack recorded for `branch`, or null. */
export function contextPackOf(office: OfficeHandle, branch: string): ContextPackRecord | null {
  const row = office.get<ContextPackRow>(
    "select * from context_packs where office_id = $office_id and branch = $branch",
    { branch },
  );
  if (row === null) return null;
  return {
    branch: row.branch,
    headSha: row.head_sha,
    blobIds: JSON.parse(row.blob_ids) as Record<string, string>,
    provider: row.provider,
    packSha256: row.pack_sha256,
    builtAt: row.built_at,
  };
}

/** Removes the record when the claim ends (0007 retention tier T). */
export function forgetContextPack(office: OfficeHandle, branch: string): void {
  office.immediate(() =>
    office.run("delete from context_packs where office_id = $office_id and branch = $branch", {
      branch,
    }),
  );
}
