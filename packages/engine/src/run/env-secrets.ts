// The values of the office's env files (0002, 0008), and their redaction: a PR comment built from a
// reviewer's verdict and a web call's line in the stored worker output never show one. The files
// are the `copy` entries of `worktree.files`, read from the office's main checkout, where a story's
// box files come from; a story has no worktree of its own (0010).
// A value is looked for as written and percent-encoded, in either hex case, and in the text after
// lenient percent-decoding. A value under `MIN_SECRET_CHARS` characters is not compared: "1" or
// "true" would match everywhere.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { OfficeConfig } from "../config";

/** Values shorter than this are not compared (see the file comment). */
export const MIN_SECRET_CHARS = 4;
/** The most files read under a copied directory, and the largest file read: a bound, not a rule. */
export const MAX_ENV_FILES = 200;
export const MAX_ENV_FILE_BYTES = 256 * 1024;

/** One value of an env file, with where it came from. */
export interface EnvSecret {
  /** The file, relative to the checkout it was read from. */
  readonly file: string;
  readonly key: string;
  readonly value: string;
}

/** The first secret a target holds: its file and key, never the value. */
export interface SecretHit {
  readonly file: string;
  readonly key: string;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;

/** The `KEY=value` lines of one env file's text; quotes are removed, `#` comments are cut. */
export function parseEnvText(text: string): Array<{ key: string; value: string }> {
  const found: Array<{ key: string; value: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (match === null) continue;
    const key = match[1] ?? "";
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    if (value !== "") found.push({ key, value });
  }
  return found;
}

/** A run of `%XX` escapes. A `%` not followed by two hex digits is not part of one. */
const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * Pure: `text` percent-decoded leniently. Each run of `%XX` escapes is decoded on its own as UTF-8;
 * a run that is not valid UTF-8 (`%C0`) has its ASCII escapes decoded and its other escapes kept as
 * written; a stray `%` stays as it is. `decodeURIComponent` throws on either, which would skip the
 * decoded comparison for the whole target.
 */
export function lenientDecode(text: string): string {
  return text.replace(ESCAPE_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%[0-7][0-9A-Fa-f]/g, (escape) => decodeURIComponent(escape));
    }
  });
}

/** How often a target is decoded again, for a value encoded more than once (`%2561` is `%61`). */
export const MAX_DECODE_ROUNDS = 3;

/**
 * Pure: the forms of `target` a secret is looked for in: as written and each round of lenient
 * percent-decoding until nothing changes, each also with `+` read as a space first.
 */
export function decodedForms(target: string): string[] {
  const forms = new Set<string>([target]);
  for (const start of [target, target.replaceAll("+", " ")]) {
    let text = start;
    for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
      const next = lenientDecode(text);
      if (next === text) break;
      forms.add(next);
      text = next;
    }
  }
  return [...forms];
}

/**
 * Pure: the first of `secrets` whose value `target` holds, as written, percent-encoded (the
 * encoded form of the value in the target, in either hex case) or after the target is
 * percent-decoded leniently, up to `MAX_DECODE_ROUNDS` times (a `+` read as a space too).
 */
export function findSecret(target: string, secrets: readonly EnvSecret[]): SecretHit | null {
  const decoded = decodedForms(target);
  const lowerTarget = target.toLowerCase();
  for (const secret of secrets) {
    if (secret.value.length < MIN_SECRET_CHARS) continue;
    const written = decoded.some((text) => text.includes(secret.value));
    const encoded = encodedForms(secret.value).some((form) =>
      lowerTarget.includes(form.toLowerCase()),
    );
    if (written || encoded) return { file: secret.file, key: secret.key };
  }
  return null;
}

/** The percent-encoded forms of `value` that differ from it. */
function encodedForms(value: string): string[] {
  return [
    encodeURIComponent(value),
    encodeURI(value),
    encodeURIComponent(value).replaceAll("%20", "+"),
  ].filter((form) => form !== value);
}

/** What stored output holds in place of an env value (as 0008 redacts review comments). */
export const REDACTED_TEXT = "[redacted]";

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure: `line` with every env value of `secrets` replaced by `[redacted]`: as written and
 * percent-encoded (either hex case), then each whitespace-separated word that still holds one
 * (encoded part by part, or encoded twice) whole. A line that still holds one after that is
 * `[redacted]` whole.
 */
export function redactSecrets(line: string, secrets: readonly EnvSecret[]): string {
  const live = secrets.filter((secret) => secret.value.length >= MIN_SECRET_CHARS);
  if (live.length === 0) return line;
  let out = line;
  for (const secret of live) {
    out = out.split(secret.value).join(REDACTED_TEXT);
    for (const form of encodedForms(secret.value)) {
      out = out.replaceAll(new RegExp(escapeRegExp(form), "gi"), REDACTED_TEXT);
    }
  }
  out = out
    .split(/(\s+)/)
    .map((word) => (findSecret(word, live) === null ? word : REDACTED_TEXT))
    .join("");
  return findSecret(out, live) === null ? out : REDACTED_TEXT;
}

/** Files of a `worktree.files` entry that exists in `folder`: a file, or those under a directory. */
function filesOf(folder: string, path: string): string[] {
  const out: string[] = [];
  const walk = (absolute: string): void => {
    if (out.length >= MAX_ENV_FILES) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      if (stat.size <= MAX_ENV_FILE_BYTES) out.push(absolute);
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).toSorted()) walk(join(absolute, name));
    }
  };
  walk(join(folder, path));
  return out;
}

/** Reads the env secrets of `files` in a checkout (`readEnvSecrets` by default; tests replace it). */
export type EnvSecretsReader = (
  checkout: string,
  files: OfficeConfig["worktree"]["files"],
) => EnvSecret[];

/**
 * The env secrets of the office whose main checkout is `checkout`, through `read`; throws when the
 * checkout is not known, so the caller redacts or holds back as for a file it cannot read.
 */
export function officeEnvSecrets(
  checkout: string | undefined,
  files: OfficeConfig["worktree"]["files"],
  read: EnvSecretsReader = readEnvSecrets,
): EnvSecret[] {
  if (checkout === undefined) throw new Error("the office's main checkout is not known");
  return read(checkout, files);
}

/**
 * The values of the env files in `checkout`: the `copy` entries of `worktree.files` (a directory
 * entry contributes the files under it), read as `KEY=value` lines. An entry that is absent (an
 * optional file) contributes nothing; any other failure throws, so the caller denies.
 */
export function readEnvSecrets(
  checkout: string,
  files: OfficeConfig["worktree"]["files"],
): EnvSecret[] {
  const secrets: EnvSecret[] = [];
  for (const entry of files) {
    if (entry.mode !== "copy") continue;
    let found: string[];
    try {
      found = filesOf(checkout, entry.path.replace(/\/$/, ""));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") continue;
      throw error;
    }
    for (const absolute of found) {
      const text = readFileSync(absolute, "utf8");
      for (const { key, value } of parseEnvText(text)) {
        secrets.push({ file: relative(checkout, absolute), key, value });
      }
    }
  }
  return secrets;
}
