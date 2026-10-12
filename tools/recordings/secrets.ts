// The secret guard (0017 section 2, "Secret scan"). It runs over the scrubbed output before
// anything is written, and as a unit test over every committed recording, so neither the scrubber
// nor a hand edit can put a token or a real path into the repository.

import { homedir, userInfo } from "node:os";

export interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
  /** Matches that are placeholders, not secrets. */
  readonly allow?: RegExp;
}

/** Token shapes and markers that never belong in a recording. */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "anthropic key", pattern: /sk-ant-/ },
  { name: "github token", pattern: /\bgh[pousr]_[A-Za-z0-9]{8,}/ },
  { name: "github fine-grained token", pattern: /github_pat_/ },
  { name: "aws access key id", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { name: "aws secret key name", pattern: /aws_secret_access_key/i },
  { name: "bearer token", pattern: /Bearer / },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // A real home directory, on any machine: the normaliser turns every one into ${HOME}.
  // Any email address, so a committed recording cannot carry one even where the capture-time
  // needle (the maintainer's git email) is unknown, as in CI. Documentation domains are allowed.
  {
    name: "email address",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    allow: /@example\.(?:org|com)$/i,
  },
  { name: "home path", pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+/ },
];

export interface SecretHit {
  readonly name: string;
  /** 1-based line of the scanned text. The matched text itself is never reported. */
  readonly line: number;
}

/** Literal strings a capture must also refuse: the home path, the user name, the git email. */
export interface Needle {
  readonly name: string;
  readonly value: string;
}

export function machineNeedles(extra: readonly Needle[] = []): Needle[] {
  const needles: Needle[] = [{ name: "home directory", value: homedir() }];
  const user = userInfo().username;
  // Short or generic account names ("ci", "root") would match ordinary words.
  if (user.length >= 5 && !["runner", "admin"].includes(user)) {
    needles.push({ name: "user name", value: user });
  }
  for (const needle of extra) {
    if (needle.value.length >= 5) needles.push(needle);
  }
  return needles;
}

/** Every secret shape or needle in `text`, by line. */
export function scanForSecrets(text: string, needles: readonly Needle[] = []): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const { name, pattern, allow } of SECRET_PATTERNS) {
      const matches = pattern.global ? [...line.matchAll(pattern)].map((match) => match[0]) : [];
      const hit = pattern.global
        ? matches.some((match) => allow === undefined || !allow.test(match))
        : pattern.test(line);
      if (hit) hits.push({ name, line: index + 1 });
    }
    const lower = line.toLowerCase();
    for (const needle of needles) {
      if (lower.includes(needle.value.toLowerCase()))
        hits.push({ name: needle.name, line: index + 1 });
    }
  });
  return hits;
}

export class SecretFoundError extends Error {
  override readonly name = "SecretFoundError";
  constructor(
    readonly file: string,
    readonly hits: readonly SecretHit[],
  ) {
    super(
      `secret guard: ${file} holds ${hits.map((hit) => `${hit.name} (line ${hit.line})`).join(", ")}; nothing was written`,
    );
  }
}

/** Throws `SecretFoundError` when `text` holds a secret shape or needle. */
export function guardSecrets(file: string, text: string, needles: readonly Needle[] = []): void {
  const hits = scanForSecrets(text, needles);
  if (hits.length > 0) throw new SecretFoundError(file, hits);
}
