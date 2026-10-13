// The `dipo` field block in a story description (0010 section 3; 0012 F10, F14, F15, F16).
//
// Parser: zero or one block. A line exactly ```` ```dipo ```` opens it and the next line exactly
// ```` ``` ```` closes it; a second block, an unclosed block or text after it is an R02 error. The
// content is YAML read through `platform/yaml.ts` and validated with the contract `FieldBlock`
// schema, so unknown keys and unquoted numbers fail.
//
// Emitter: fixed key order, every string double-quoted, two-space indent. Splice: replaces the
// block's content lines (or appends a block) and keeps every other byte of the description.

import { FieldBlock } from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { parseYamlDocument } from "../../platform/yaml";
import { PARSE_RULE } from "../plain";

export const BLOCK_OPEN = "```dipo";
export const BLOCK_CLOSE = "```";

/** A field block that does not parse; reported as Ready gate rule R02. */
export class FieldBlockError extends Error {
  readonly rule = PARSE_RULE;
  constructor(
    readonly detail: string,
    /** 1-based line of the description, when the error has one. */
    readonly line?: number,
  ) {
    super(`structured fields are invalid: ${detail}${line === undefined ? "" : ` (line ${line})`}`);
    this.name = "FieldBlockError";
  }
}

/** Where the block sits in a description, by character offsets. */
export interface BlockLocation {
  /** Offset of the first content line (just after the opening line and its line ending). */
  readonly contentStart: number;
  /** Offset of the closing line; the content is `description.slice(contentStart, contentEnd)`. */
  readonly contentEnd: number;
  /** 1-based line of the opening line. */
  readonly openLine: number;
  /** The opening line ends in CRLF; the splice writes the content with CRLF endings too. */
  readonly crlf: boolean;
}

/** A line without the `\r` of a CRLF ending. */
function bare(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Finds the one block, or undefined when there is none. A `\r` before the newline belongs to the
 * line ending. A line that is ```` ```dipo ```` only after trimming other trailing whitespace fails
 * R02, so a stale block is never shadowed by a block appended after it. Throws `FieldBlockError`.
 */
export function locateBlock(description: string): BlockLocation | undefined {
  const lines = description.split("\n");
  let offset = 0;
  let found: BlockLocation | undefined;
  let open: { line: number; contentStart: number; crlf: boolean } | undefined;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const next = offset + line.length + 1;
    const text = bare(line);
    if (text !== BLOCK_OPEN && line.trimEnd() === BLOCK_OPEN) {
      throw new FieldBlockError(
        "a ```dipo line with trailing whitespace; the opening line must be exactly ```dipo",
        lineNumber,
      );
    }
    if (open !== undefined) {
      if (text === BLOCK_CLOSE) {
        found = {
          contentStart: open.contentStart,
          contentEnd: offset,
          openLine: open.line,
          crlf: open.crlf,
        };
        open = undefined;
      }
    } else if (found !== undefined) {
      if (text === BLOCK_OPEN) {
        throw new FieldBlockError(
          "a second ```dipo block; a description holds at most one",
          lineNumber,
        );
      }
      if (line.trim() !== "") {
        throw new FieldBlockError("text after the ```dipo block; the block comes last", lineNumber);
      }
    } else if (text === BLOCK_OPEN) {
      open = { line: lineNumber, contentStart: next, crlf: text !== line };
    }
    offset = next;
  }
  if (open !== undefined) {
    throw new FieldBlockError("the ```dipo block is not closed by a line ```", open.line);
  }
  return found;
}

function issueText(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/** The block's content, NFC-normalised, parsed and validated. Empty content is an empty block. */
export function parseBlockContent(content: string, line?: number): FieldBlock {
  const yaml = parseYamlDocument(content.normalize("NFC"));
  if (!yaml.ok) throw new FieldBlockError(yaml.message, line);
  const result = FieldBlock.safeParse(yaml.value ?? {});
  if (!result.success) {
    throw new FieldBlockError(result.error.issues.map(issueText).join("; "), line);
  }
  return result.data;
}

export interface ParsedDescription {
  /** The block's value; an empty object when there is no block. */
  readonly fields: FieldBlock;
  readonly block: BlockLocation | undefined;
}

/** Reads the field block of a description. Throws `FieldBlockError` (R02). */
export function parseFieldBlock(description: string): ParsedDescription {
  const block = locateBlock(description);
  if (block === undefined) return { fields: {}, block };
  return {
    fields: parseBlockContent(
      description.slice(block.contentStart, block.contentEnd),
      block.openLine,
    ),
    block,
  };
}

const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/** A YAML double-quoted string. JSON's escapes are valid YAML; U+2028 and U+2029 are escaped too. */
function quote(text: string): string {
  return JSON.stringify(text).replace(
    LINE_SEPARATORS,
    (char) => `\\u${char.charCodeAt(0).toString(16)}`,
  );
}

/** `key: "value"` lines at `indent`, for the keys that are set, in the given order. */
function scalars(
  indent: string,
  record: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): string[] {
  return keys.flatMap((key) => {
    const value = record[key];
    return value === undefined ? [] : [`${indent}${key}: ${quote(value)}`];
  });
}

/** A block list of mappings under `indent`: the first key after `- `, the rest aligned under it. */
function list(
  indent: string,
  items: readonly Readonly<Record<string, string | undefined>>[],
  keys: readonly string[],
): string[] {
  return items.flatMap((item) =>
    scalars(`${indent}  `, item, keys).map((line, i) =>
      i === 0 ? `${indent}- ${line.slice(indent.length + 2)}` : line,
    ),
  );
}

/** The block's YAML content in canonical form, each line ending in a newline. */
export function emitFieldBlock(fields: FieldBlock): string {
  const lines: string[] = [];
  if (fields.branch !== undefined) lines.push(`branch: ${quote(fields.branch)}`);
  if (fields.unknowns !== undefined) {
    if (fields.unknowns.length === 0) lines.push("unknowns: []");
    else lines.push("unknowns:", ...list("  ", fields.unknowns, ["q", "status", "answer"]));
  }
  if (fields.test_plan !== undefined) {
    lines.push("test_plan:");
    const { entries, not_applicable } = fields.test_plan;
    if (entries !== undefined) {
      if (entries.length === 0) lines.push("  entries: []");
      else lines.push("  entries:", ...list("    ", entries, ["kind", "check", "expect"]));
    }
    lines.push(...scalars("  ", { not_applicable }, ["not_applicable"]));
  }
  if (fields.park !== undefined) {
    lines.push("park:", ...scalars("  ", fields.park, ["reason", "from", "note"]));
  }
  return lines.map((line) => `${line}\n`).join("");
}

/** `text` with CRLF line endings when `crlf` is set. */
function withEnding(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * The description with its block set to `fields`, every byte outside the block's content unchanged.
 * Without a block, one is appended after a blank line; an empty value then adds nothing.
 * A block opened with a CRLF line gets CRLF content lines; a block appended to a description
 * holding CRLF uses CRLF throughout. The description is used as given, never normalised.
 * Throws `FieldBlockError` when the description's block structure is invalid.
 */
export function spliceFieldBlock(description: string, fields: FieldBlock): string {
  const content = emitFieldBlock(fields);
  const block = locateBlock(description);
  if (block !== undefined) {
    return (
      description.slice(0, block.contentStart) +
      withEnding(content, block.crlf) +
      description.slice(block.contentEnd)
    );
  }
  if (content === "") return description;
  const crlf = description.includes("\r\n");
  const lf = description.replace(/\r\n/g, "\n");
  const separator = lf === "" || lf.endsWith("\n\n") ? "" : lf.endsWith("\n") ? "\n" : "\n\n";
  return description + withEnding(`${separator}${BLOCK_OPEN}\n${content}${BLOCK_CLOSE}`, crlf);
}
