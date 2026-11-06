// A planning session's asides (0022, DIPO-452): an idea the session noticed outside the goal it
// plans reaches dipo as an aside block, a fenced block with the info string `dipo-aside` that holds
// one JSON object of the contract's `AsideBlock` shape. The engine validates each block; a valid
// one is held as an idea with origin `aside` and no source story, and audited when it arrives
// (its run is a session run), and an invalid one is refused with a message that says why. The
// session's words are data: a block that names tools, permissions or anything else is refused.

import { AsideBlock, type RunId } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { holdIdea } from "../records/ideas";

/** The info string of an aside block's fence. */
export const ASIDE_FENCE = "dipo-aside";

/** The `engine.notice` code of an aside block the engine refused. */
export const ASIDE_REFUSED_NOTICE = "planning.asideRefused";

/** The longest refusal message, in characters. */
const MESSAGE_MAX = 500;

const FENCE = /^```[ \t]*dipo-aside[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

/** Pure: the bodies of the aside blocks in `text`, in order. */
export function asideBlocks(text: string): string[] {
  return [...text.replace(/\r\n?/g, "\n").matchAll(FENCE)].map((match) => match[1] ?? "");
}

/** What the engine made of one aside block. */
export type AsideRead =
  | { readonly ok: true; readonly aside: AsideBlock }
  | { readonly ok: false; readonly message: string };

/** Pure: one aside block's body, validated by the contract's schema. */
export function readAside(body: string): AsideRead {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, message: "the aside block is not one JSON object" };
  }
  const parsed = AsideBlock.safeParse(value);
  if (parsed.success) return { ok: true, aside: parsed.data };
  const problems = parsed.error.issues.map(
    (issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
  );
  const message = `the aside block does not match its schema: ${problems.join("; ")}`;
  return {
    ok: false,
    message: message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX - 1)}…` : message,
  };
}

/** The aside text an idea is held with: the session's text and the paths it names. */
function asideText(aside: AsideBlock): string {
  const paths = aside.paths ?? [];
  return paths.length === 0 ? aside.text : `${aside.text}\nPaths: ${paths.join(", ")}`;
}

/**
 * Holds every valid aside block of one output text of the planning run `run` as an idea, and
 * returns the `engine.notice` entries of the refused ones; `held` counts the ideas this call held.
 * Inside the caller's transaction.
 */
export function holdAsides(
  office: OfficeHandle,
  input: { readonly run: RunId; readonly text: string; readonly at: number },
): { readonly held: number; readonly refused: NewEntry[] } {
  let held = 0;
  const refused: NewEntry[] = [];
  for (const body of asideBlocks(input.text)) {
    const read = readAside(body);
    if (!read.ok) {
      refused.push({
        type: "engine.notice",
        run: input.run,
        delta: {
          level: "warn",
          code: ASIDE_REFUSED_NOTICE,
          text: `dipo refused an aside of the planning session ${input.run}: ${read.message}. Nothing was held.`,
        },
      });
      continue;
    }
    const id = holdIdea(office, {
      origin: "aside",
      key: null,
      runId: input.run,
      title: read.aside.title,
      text: asideText(read.aside),
      at: input.at,
    });
    if (id !== null) held += 1;
  }
  return { held, refused };
}
