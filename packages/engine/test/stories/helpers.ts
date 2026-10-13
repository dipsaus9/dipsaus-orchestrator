// Shared setup for the story index tests: a migrated state database with one office, stories as
// a pass reads them, a pass applied with its change-log entries, and the entries read back.

import { StoryId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { appendEntries } from "../../src/changelog/log";
import type { OfficeHandle } from "../../src/db/office";
import { applyIndex, type IndexStats } from "../../src/stories/apply";
import type { BacklogStory } from "../../src/stories/read";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

export const CREATED = "2026-10-12 11:28 (UTC)";

export async function withOffice(
  fn: (t: TestState, office: OfficeHandle) => void | Promise<void>,
): Promise<void> {
  return withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(t, addOffice(t));
    } finally {
      t.state.close();
    }
  });
}

/** A task as a pass reads it: Refined, created at `CREATED`, no labels, no branch. */
export function task(id: string, overrides: Partial<BacklogStory> = {}): BacklogStory {
  return {
    kind: "task",
    story: StoryId.parse(id),
    title: `Story ${id}`,
    status: "Refined",
    created: CREATED,
    labels: [],
    contentHash: `hash-${id}`,
    ...overrides,
  };
}

export function draft(id: string, overrides: Partial<BacklogStory> = {}): BacklogStory {
  return task(id, { kind: "draft", status: "Draft", ...overrides });
}

/** Applies one pass and appends its entries in one transaction, as `indexStories` does. */
export function pass(
  t: TestState,
  office: OfficeHandle,
  read: readonly BacklogStory[],
): IndexStats {
  return office.immediate(() => {
    const at = t.clock.now();
    const { stats, entries } = applyIndex(office, t.ids, read, { at, source: "base" });
    appendEntries(office, entries, { at });
    return stats;
  });
}

export interface LoggedEntry {
  readonly seq: number;
  readonly type: string;
  readonly key: string | null;
  readonly delta: Record<string, unknown>;
  readonly view: Record<string, unknown> | null;
}

/** The change-log entries after `afterSeq`, in order. */
export function entriesAfter(office: OfficeHandle, afterSeq = 0): LoggedEntry[] {
  return office
    .all<{ seq: number; type: string; key: string | null; delta: string; view: string | null }>(
      "select seq, type, key, delta, view from change_log where office_id = $office_id and seq > $after order by seq",
      { after: afterSeq },
    )
    .map((row) => ({
      seq: row.seq,
      type: row.type,
      key: row.key,
      delta: JSON.parse(row.delta) as Record<string, unknown>,
      view: row.view === null ? null : (JSON.parse(row.view) as Record<string, unknown>),
    }));
}

/** The last seq written; 0 before the first entry. */
export function lastSeq(office: OfficeHandle): number {
  return (
    office.get<{ seq: number | null }>(
      "select max(seq) as seq from change_log where office_id = $office_id",
    )?.seq ?? 0
  );
}

/** The current key of `id`, or null. */
export function keyOf(office: OfficeHandle, id: string): string | null {
  return (
    office.get<{ key: string }>(
      "select key from stories where office_id = $office_id and story_id = $id and removed_at is null",
      { id },
    )?.key ?? null
  );
}

/** Every key with its id and whether it is removed, by id. */
export function storyRows(
  office: OfficeHandle,
): { key: string; story_id: string; removed: boolean }[] {
  return office
    .all<{ key: string; story_id: string; removed_at: number | null }>(
      "select key, story_id, removed_at from stories where office_id = $office_id order by story_id, key",
    )
    .map((row) => ({ key: row.key, story_id: row.story_id, removed: row.removed_at !== null }));
}
