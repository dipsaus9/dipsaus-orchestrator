// Secret paths (0008: `Read(./**/.env*)` and the secret paths an engine step cannot read). The
// context provider never reads a file whose path matches, and the workspace refuses to: such a
// file is listed by path only, so a secret cannot reach a prompt through the context pack.
// Matching ignores case.

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
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i, // ssh keys and their .pub siblings
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
