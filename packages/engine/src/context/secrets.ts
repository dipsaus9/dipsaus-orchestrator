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
