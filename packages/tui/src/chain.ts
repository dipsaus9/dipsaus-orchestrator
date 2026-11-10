// The dependency chain and the gate of the selected story (0009, DIPO-460). The engine computes
// both: `office.chain` sends the graph of the waiting stories as levels with the state of each
// story, and `story.gate` the rule count. The TUI reads them and draws what it got: it derives no
// state, no level and no count (0001). The words here are only joins of what was sent.

import type {
  ChainNode,
  ChainRow,
  EngineError,
  OfficeId,
  StoryId,
  StoryView,
} from "@dipsaus-orchestrator/contract";
import { useEffect, useMemo, useState } from "react";

import type { Span } from "./spans";

export interface Chain {
  readonly rows: readonly ChainRow[];
  readonly nodes: readonly ChainNode[];
}

export type ChainOutcome =
  | { readonly ok: true; readonly result: Chain }
  | { readonly ok: false; readonly error: EngineError };

/** `office.chain` for `office`. */
export type ReadChain = (office: OfficeId) => Promise<ChainOutcome>;

/** What `story.gate` answered, as far as the Queue's preview shows it. */
export interface GateFacts {
  readonly passed: boolean;
  readonly rules: number;
  readonly failures: readonly { readonly rule: string; readonly message: string }[];
  readonly warnings?: readonly { readonly rule: string; readonly message: string }[] | undefined;
  readonly touches?: readonly string[] | undefined;
}

export type GateOutcome =
  | { readonly ok: true; readonly result: GateFacts }
  | { readonly ok: false; readonly error: EngineError };

/** `story.gate` for one story of `office`. */
export type ReadGate = (office: OfficeId, story: StoryId) => Promise<GateOutcome>;

/** The no-chain value: nothing waits. */
export const NO_CHAIN: Chain = { rows: [], nodes: [] };

/** What changes the chain: each story's place and what it waits on. */
function chainSignature(stories: readonly StoryView[]): string {
  return stories
    .map((story) => `${story.key}:${story.column}:${(story.waitingOn ?? []).join(",")}`)
    .join(";");
}

/**
 * The chain of the open office, read when it opens and after each change of the stories' columns or
 * dependencies; `NO_CHAIN` until the first answer. An answer for another office is dropped.
 */
export function useChain(options: {
  readonly readChain: ReadChain;
  readonly office: OfficeId | null;
  readonly stories: readonly StoryView[];
  readonly active: boolean;
}): Chain {
  const { readChain, office, stories, active } = options;
  const [chain, setChain] = useState<{ office: OfficeId; chain: Chain } | null>(null);
  const signature = useMemo(() => chainSignature(stories), [stories]);
  useEffect(() => {
    if (!active || office === null) return;
    let current = true;
    void readChain(office).then((outcome) => {
      if (current && outcome.ok) setChain({ office, chain: outcome.result });
    });
    return () => {
      current = false;
    };
  }, [readChain, office, signature, active]);
  return chain !== null && chain.office === office ? chain.chain : NO_CHAIN;
}

/** The gate of the selected story: undefined while reading, null when the read failed. */
export function useGate(options: {
  readonly readGate: ReadGate;
  readonly office: OfficeId | null;
  readonly story: StoryId | null;
  /** Reads again when it changes: the story's column, so a gate decided meanwhile shows. */
  readonly version: string;
  readonly active: boolean;
}): GateFacts | null | undefined {
  const { readGate, office, story, version, active } = options;
  const [gate, setGate] = useState<{
    office: OfficeId;
    story: StoryId;
    facts: GateFacts | null;
  } | null>(null);
  useEffect(() => {
    if (!active || office === null || story === null) return;
    let current = true;
    void readGate(office, story).then((outcome) => {
      if (current) setGate({ office, story, facts: outcome.ok ? outcome.result : null });
    });
    return () => {
      current = false;
    };
  }, [readGate, office, story, version, active]);
  return gate !== null && gate.office === office && gate.story === story ? gate.facts : undefined;
}

/** `DIPO-447` as `447`: the number after the last hyphen; an id without one stays as it is. */
export function shortId(id: string): string {
  return id.slice(id.lastIndexOf("-") + 1);
}

/** What a Refined dependency is: it waits for the maintainer to set it Ready (DIPO-484). */
export const REFINED_WORDS = "Refined, not Ready yet";

/** The mark after a dependency: `✗` parked, `→` moving by itself, `◌` Refined, none when it waits too. */
export function chainMark(node: ChainNode | undefined, ascii: boolean): string {
  if (node?.state === "parked") return ascii ? "x" : "✗";
  if (node?.state === "moving") return ascii ? ">" : "→";
  if (node?.state === "refined") return ascii ? "o" : "◌";
  return "";
}

/** The Span role of a dependency's mark. */
function markRole(node: ChainNode | undefined): "err" | "ok" | "acc" | "dim" {
  if (node?.state === "parked") return "err";
  if (node?.state === "moving") return "ok";
  return node?.state === "refined" ? "acc" : "dim";
}

/** `Refined, not Ready yet: <first gate failure>` for a Refined dependency; null for any other. */
export function refinedText(node: ChainNode | undefined): string | null {
  if (node?.state !== "refined") return null;
  return node.reason === undefined ? REFINED_WORDS : `${REFINED_WORDS}: ${node.reason}`;
}

/** One line per Refined dependency of `ids`: `449 Refined, not Ready yet: <first gate failure>`. */
export function refinedLines(ids: readonly StoryId[], chain: Chain): string[] {
  return ids.flatMap((id) => {
    const text = refinedText(chain.nodes.find((candidate) => candidate.story === id));
    return text === null ? [] : [`${id} ${text}`];
  });
}

/** `needs 447✗, 449` as spans: the number, then its mark in err (parked) or ok (moving). */
export function needsSpans(
  waitingOn: readonly StoryId[],
  chain: Chain,
  ascii: boolean,
  short = true,
): Span[] {
  const spans: Span[] = [];
  waitingOn.forEach((id, i) => {
    const node = chain.nodes.find((candidate) => candidate.story === id);
    const mark = chainMark(node, ascii);
    if (i > 0) spans.push({ text: ", ", role: "dim" });
    spans.push({ text: short ? shortId(id) : id, role: mark === "" ? "dim" : markRole(node) });
    if (mark !== "") spans.push({ text: mark, role: markRole(node) });
    if (node?.state === "refined") spans.push({ text: " Refined", role: markRole(node) });
  });
  return spans;
}

/** The stories of one level, `448, 449`. */
function level(ids: readonly StoryId[]): string {
  return ids.map(shortId).join(", ");
}

/**
 * The UP NEXT sentence: `When DIPO-447 merges → 448, 449 start in parallel, then 450 → 451, 452 →
 * 453`. The first piece names its one first story and what starts after it; every other piece, and
 * the rest of the first, is its levels joined by arrows. Null when nothing waits.
 */
export function upNextSpans(chain: Chain, arrow: string): Span[] | null {
  const [first, ...others] = chain.rows;
  if (first === undefined) return null;
  const chainText = (levels: readonly (readonly StoryId[])[]) =>
    levels.map(level).join(` ${arrow} `);
  const spans: Span[] = [];
  const rest: string[] = [];
  const [root, started, ...later] = first.levels;
  if (root?.length === 1 && started !== undefined) {
    const [only] = root;
    spans.push({ text: "When " }, { text: String(only), role: "acc" });
    const many = started.length > 1;
    spans.push({
      text: ` merges ${arrow} ${level(started)} ${many ? "start in parallel" : "starts"}`,
    });
    if (later.length > 0) rest.push(`then ${chainText(later)}`);
  } else {
    rest.push(chainText(first.levels));
  }
  for (const row of others) rest.push(chainText(row.levels));
  if (rest.length > 0) {
    spans.push({ text: `${spans.length > 0 ? ", " : ""}${rest.join(", ")}` });
  }
  // A Refined story waits for the maintainer, not for a merge: the sentence says so (DIPO-484).
  const refined = chain.rows.flatMap((row) => refinedLines(row.levels.flat(), chain));
  if (refined.length > 0) {
    spans.push({ text: `${spans.length > 0 ? "; " : ""}${refined.join("; ")}`, role: "acc" });
  }
  return spans;
}

/** One row of the CHAIN picture as spans: `447✗ → 448 · 449 → 450 → 451`. */
export function chainPictureSpans(
  row: ChainRow,
  chain: Chain,
  arrow: string,
  dot: string,
  ascii: boolean,
): Span[] {
  const spans: Span[] = [];
  row.levels.forEach((ids, i) => {
    if (i > 0) spans.push({ text: ` ${arrow} ` });
    ids.forEach((id, n) => {
      if (n > 0) spans.push({ text: ` ${dot} ` });
      const node = chain.nodes.find((candidate) => candidate.story === id);
      if (i === 0) {
        // The first stories carry their state, padded so the arrows of the pieces line up.
        const mark =
          node?.state === "parked" || node?.state === "refined" ? chainMark(node, ascii) : " ";
        spans.push({
          text: `${shortId(id)}${mark}`,
          ...(node?.state === "parked"
            ? { role: "err" as const }
            : node?.state === "moving"
              ? { role: "ok" as const }
              : node?.state === "refined"
                ? { role: "acc" as const }
                : {}),
        });
      } else {
        spans.push({ text: shortId(id) });
      }
    });
  });
  return spans;
}
