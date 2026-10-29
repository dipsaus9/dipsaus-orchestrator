// Secret paths (0008: the `.env*` files at any depth and the secret paths an engine step cannot
// read). The context provider never reads a file whose path matches, and the workspace refuses
// to: such a file is listed by path only, so a secret cannot reach a prompt through the context
// pack.
// Matching ignores case.

import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** A file whose name (last path segment) matches is a secret. */
const SECRET_NAMES: readonly RegExp[] = [
  /^\.env/i, // .env, .env.local, .envrc
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^_netrc$/i,
  /^\.git-credentials$/i,
  /^\.pgpass$/i,
  /^\.dockercfg$/i,
  /^credentials(\.json)?$/i,
  /^secrets\.(ya?ml|json)$/i,
  /^service-account.*\.json$/i,
  /\.(pem|key|p12|pfx|keystore|jks|p8|ppk)$/i, // p8: Apple and other signing keys; ppk: PuTTY keys
  /^id_(rsa|dsa|ecdsa|ed25519)/i, // ssh keys and their .pub siblings
  /^\.credentials\.json$/i, // Claude's login
  /^application_default_credentials\.json$/i, // Google Cloud CLI
  /^client_secret.*\.json$/i, // OAuth client secrets of Google Cloud
  /^\.pypirc$/i, // Python package-registry credentials
  /^\.vault-token$/i, // HashiCorp Vault
  /^\.dev\.vars(\.[^.]+)?$/i, // Cloudflare Wrangler: .dev.vars, .dev.vars.<environment>
  /\.tfstate(\.backup)?$/i, // Terraform and OpenTofu state
  /\.tfvars(\.json)?$/i, // Terraform and OpenTofu variables
  /^kubeconfig(\.ya?ml)?$/i, // a Kubernetes client configuration with its credentials
];

/** A directory whose name matches makes every path under it a secret. */
const SECRET_DIRS: readonly RegExp[] = [
  /^\.env/i,
  /^\.ssh$/i,
  /^\.aws$/i,
  /^\.gnupg$/i,
  /^\.docker$/i,
  /^\.kube$/i,
];

/**
 * True when the repo-relative `path` names a secret: any segment matches a secret directory name,
 * or the last segment matches a secret file name.
 */
export function isSecretPath(path: string): boolean {
  const segments = path.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => SECRET_DIRS.some((pattern) => pattern.test(segment)))) {
    return true;
  }
  const base = segments.at(-1);
  return base !== undefined && SECRET_NAMES.some((pattern) => pattern.test(base));
}

/**
 * The template files of a `.env` or a `.dev.vars`, which a repository commits with placeholder
 * values.
 */
const ENV_TEMPLATE = /^\.(env|dev\.vars)\.(example|sample)$/i;

/**
 * The secret file names of a box part (DIPO-290): `isSecretPath`, except that a `.env.example` or
 * `.env.sample` file (and the same of `.dev.vars`, DIPO-312) is no secret by its name, so a part may
 * add or change it; its content is still scanned like any file's, and a secret folder above it
 * (`.ssh/`, `.env.d/`) still makes it one. `.env`, `.env.<name>`, `.dev.vars` and
 * `.dev.vars.<name>` stay secret. The context provider and the workspace keep `isSecretPath`,
 * which follows the `.env*` read deny of 0008 and so never reads a template either.
 */
export function isSecretPartPath(path: string): boolean {
  const segments = path.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".");
  const base = segments.at(-1);
  if (base === undefined || !ENV_TEMPLATE.test(base)) return isSecretPath(path);
  return segments
    .slice(0, -1)
    .some((segment) => SECRET_DIRS.some((pattern) => pattern.test(segment)));
}

// Secret content (DIPO-273, 0021 section 8): the patterns a delivered part is scanned for before
// dipo commits it. Each names a fixed kind, so a hit can be reported without quoting what matched.
// They are the well-known shapes of keys and tokens: specific enough that ordinary code rarely
// matches, and a hit parks the story for the maintainer rather than guessing.

/** One content pattern and the fixed name its hits are reported by. */
export interface SecretPattern {
  readonly kind: string;
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: "a private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: "a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g,
  },
  { kind: "a GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "an Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "an OpenAI key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { kind: "a Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "a Stripe live key", pattern: /\b[rs]k_live_[0-9A-Za-z]{20,}/g },
  { kind: "an npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
];

// Scrubbing stored text (DIPO-312): a stored tool line (`ingest/output.ts`) and a log line
// (`log/logger.ts`) hold no value of a `SECRET_PATTERNS` shape and no URL with user information.

/** What a scrubbed value becomes. */
export const REDACTED_TEXT = "[redacted]";

/** A URL that holds user information (`https://user:token@host/path`), whole. */
const CREDENTIAL_URL = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#"'`<>]*@[^\s"'`<>]*/g;

/** A private key from its first line through its last, or to the end of the text. */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

/**
 * `text` with every URL that holds user information, every private key and every other value of a
 * `SECRET_PATTERNS` shape replaced by `[redacted]`.
 */
export function redactSecretText(text: string): string {
  let out = text.replace(CREDENTIAL_URL, REDACTED_TEXT).replace(PRIVATE_KEY_BLOCK, REDACTED_TEXT);
  for (const { pattern } of SECRET_PATTERNS) out = out.replace(pattern, REDACTED_TEXT);
  return out;
}

/** One kind of secret content found, with the matched texts (never shown, only compared). */
export interface SecretMatch {
  readonly kind: string;
  readonly texts: readonly string[];
}

/**
 * The secret patterns `content` matches, in `SECRET_PATTERNS` order, each with the texts it
 * matched. Bytes are read as Latin-1, so binary content is scanned too.
 */
export function secretMatches(content: Uint8Array | string): SecretMatch[] {
  const text = typeof content === "string" ? content : Buffer.from(content).toString("latin1");
  const found: SecretMatch[] = [];
  for (const { kind, pattern } of SECRET_PATTERNS) {
    const texts = [...new Set([...text.matchAll(pattern)].map((match) => match[0]))];
    if (texts.length > 0) found.push({ kind, texts });
  }
  return found;
}

/**
 * The kinds of secret content `after` holds that `before` (the file as last delivered, or null for
 * a new file) did not: a key or token the change brings in, not one the file already had.
 */
export function newSecretKinds(
  after: Uint8Array | string,
  before: Uint8Array | string | null,
): string[] {
  const now = secretMatches(after);
  if (now.length === 0 || before === null) return now.map((match) => match.kind);
  const had = new Set(secretMatches(before).flatMap((match) => match.texts));
  return now.filter((match) => match.texts.some((text) => !had.has(text))).map((m) => m.kind);
}

// The streamed scan of a part's files (DIPO-273): a file is read in chunks that overlap, so a match
// that crosses a chunk border is found whole, and the daemon's event loop is free between chunks.
// A match is keyed by its kind and its first `SECRET_KEY_CHARS` characters, so the same key found in
// two chunks, or in the file before and after a change, is one key.

/** The characters of a match that key it. */
export const SECRET_KEY_CHARS = 64;
/** How much of a file one chunk reads. */
export const SECRET_SCAN_CHUNK = 1024 * 1024;
/** How much two chunks overlap; at least the longest literal value scanned for. */
const SECRET_SCAN_OVERLAP = 4096;

/** Literal values a scan also looks for, with the kind their hits are reported by. */
export interface SecretValues {
  readonly kind: string;
  /** The values as UTF-8 text; each is matched as its bytes. */
  readonly values: readonly string[];
}

/** The keys found, by kind. */
export type SecretKeys = Map<string, Set<string>>;

function addKey(keys: SecretKeys, kind: string, text: string): void {
  let set = keys.get(kind);
  if (set === undefined) {
    set = new Set();
    keys.set(kind, set);
  }
  set.add(text.slice(0, SECRET_KEY_CHARS));
}

/** The values of `literals` as Latin-1 text, the form a scanned chunk has. */
function latin1Values(literals: SecretValues | undefined): string[] {
  return (literals?.values ?? []).map((value) => Buffer.from(value, "utf8").toString("latin1"));
}

function scanInto(keys: SecretKeys, text: string, values: readonly string[], kind: string): void {
  for (const { kind: patternKind, pattern } of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) addKey(keys, patternKind, match[0]);
  }
  for (const value of values) if (text.includes(value)) addKey(keys, kind, value);
}

/** The secret keys of `text`: the content patterns, and the literal values when given. */
export function secretKeys(text: string, literals?: SecretValues): SecretKeys {
  const keys: SecretKeys = new Map();
  scanInto(keys, text, latin1Values(literals), literals?.kind ?? "");
  return keys;
}

/** The secret keys of `bytes` (read as Latin-1), chunk by chunk as a file is. */
export function secretKeysOfBytes(bytes: Uint8Array, literals?: SecretValues): SecretKeys {
  const keys: SecretKeys = new Map();
  const values = latin1Values(literals);
  const overlap = Math.max(SECRET_SCAN_OVERLAP, ...values.map((value) => value.length));
  for (let at = 0; at < bytes.length || at === 0; at += SECRET_SCAN_CHUNK) {
    const end = Math.min(bytes.length, at + SECRET_SCAN_CHUNK + overlap);
    scanInto(
      keys,
      Buffer.from(bytes.subarray(at, end)).toString("latin1"),
      values,
      literals?.kind ?? "",
    );
    if (end >= bytes.length) break;
  }
  return keys;
}

/**
 * The secret keys of the file at `path`, read in overlapping chunks (O_NOFOLLOW), or `tooBig` when
 * it holds more than `maxBytes`: dipo does not take a file it does not scan whole.
 */
export async function secretKeysOfFile(
  path: string,
  maxBytes: number,
  literals?: SecretValues,
): Promise<SecretKeys | "tooBig"> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await file.stat();
    if (size > maxBytes) return "tooBig";
    const keys: SecretKeys = new Map();
    const values = latin1Values(literals);
    const overlap = Math.max(SECRET_SCAN_OVERLAP, ...values.map((value) => value.length));
    const buffer = new Uint8Array(SECRET_SCAN_CHUNK + overlap);
    for (let at = 0; at < size; at += SECRET_SCAN_CHUNK) {
      const want = Math.min(buffer.length, size - at);
      const { bytesRead } = await file.read(buffer, 0, want, at);
      const text = Buffer.from(buffer.subarray(0, bytesRead)).toString("latin1");
      scanInto(keys, text, values, literals?.kind ?? "");
      if (at + want >= size) break;
    }
    return keys;
  } finally {
    await file.close();
  }
}

/** The kinds with a key in `after` that `before` (null: nothing before) does not hold. */
export function newKeyKinds(after: SecretKeys, before: SecretKeys | null): string[] {
  const kinds: string[] = [];
  for (const [kind, texts] of after) {
    const had = before?.get(kind);
    if ([...texts].some((text) => had?.has(text) !== true)) kinds.push(kind);
  }
  return kinds;
}
