// The newest worker and verify line of every running run of the open office, for the overview's
// `now:` lines (DIPO-81). Each run and source has a small `OutputFeed` outside React: on open it
// reads the stored tail with `work.outputRange`, as the live agent detail does, then follows the
// store's `work.output` listener. Only the last few kilobytes are held; React keeps a version
// counter, bumped at most 10 times per second.

import type { OfficeStore, OutputChunk } from "@dipsaus-orchestrator/client";
import type { Clock, OfficeId, OutputSource, RunId } from "@dipsaus-orchestrator/contract";
import { useEffect, useMemo, useState } from "react";

import { Batcher, BATCH_MS } from "./batch";
import type { ReadOutput } from "./detail";
import { lastLine, OutputFeed } from "./output";

/** The bytes each feed keeps: enough for the last line. */
export const NOW_TAIL_BYTES = 4 * 1024;

const SOURCES: readonly OutputSource[] = ["worker", "verify"];

export class LatestLines {
  readonly #read: ReadOutput;
  readonly #office: OfficeId;
  readonly #onChange: () => void;
  readonly #tailBytes: number;
  readonly #feeds = new Map<string, OutputFeed>();
  #closed = false;

  constructor(
    read: ReadOutput,
    office: OfficeId,
    onChange: () => void,
    tailBytes: number = NOW_TAIL_BYTES,
  ) {
    this.#read = read;
    this.#office = office;
    this.#onChange = onChange;
    this.#tailBytes = tailBytes;
  }

  /** Follows exactly `runs`: a new run's tails are read, a run that left is dropped. */
  follow(runs: readonly RunId[]): void {
    if (this.#closed) return;
    const wanted = new Set(runs.flatMap((run) => SOURCES.map((source) => `${run}:${source}`)));
    for (const [key, feed] of this.#feeds) {
      if (wanted.has(key)) continue;
      feed.close();
      this.#feeds.delete(key);
    }
    for (const run of runs) {
      for (const source of SOURCES) {
        const key = `${run}:${source}`;
        if (this.#feeds.has(key)) continue;
        const office = this.#office;
        const feed = new OutputFeed(
          (from, to) =>
            this.#read(
              to === undefined ? { office, run, source, from } : { office, run, source, from, to },
            ),
          this.#tailBytes,
          () => this.#onChange(),
        );
        this.#feeds.set(key, feed);
        void feed.load();
      }
    }
  }

  /** A live `work.output` range; ranges of runs not followed are ignored. */
  push(chunk: OutputChunk): void {
    this.#feeds.get(`${chunk.run}:${chunk.source}`)?.push(chunk);
  }

  /** The newest non-empty line of `run`'s `source`, or null. */
  line(run: RunId, source: OutputSource): string | null {
    const feed = this.#feeds.get(`${run}:${source}`);
    return feed === undefined ? null : lastLine(feed.lines);
  }

  close(): void {
    this.#closed = true;
    for (const feed of this.#feeds.values()) feed.close();
    this.#feeds.clear();
  }
}

/**
 * The latest lines of `runs` in `office`, re-read after the store read a snapshot again (a history
 * gap). Returns null without an office; `version` changes when a line may have changed.
 */
export function useLatestLines(options: {
  store: OfficeStore;
  clock: Clock;
  readOutput: ReadOutput;
  office: OfficeId | null;
  runs: readonly RunId[];
  snapshots: number;
}): { readonly latest: LatestLines | null; readonly version: number } {
  const { store, clock, readOutput, office, runs, snapshots } = options;
  const [version, setVersion] = useState(0);
  const batcher = useMemo(
    () => new Batcher(clock, BATCH_MS, () => setVersion((n) => n + 1)),
    [clock],
  );
  const latest = useMemo(
    () => (office === null ? null : new LatestLines(readOutput, office, () => batcher.changed())),
    // A new snapshot means a history gap: read the tails again.
    [readOutput, office, snapshots, batcher],
  );
  useEffect(() => {
    if (latest === null) return;
    const stop = store.onOutput((chunk) => latest.push(chunk));
    return () => {
      stop();
      latest.close();
    };
  }, [store, latest]);
  const key = runs.join(",");
  useEffect(() => {
    latest?.follow(runs);
  }, [latest, key]);
  useEffect(() => () => batcher.stop(), [batcher]);
  return { latest, version };
}
