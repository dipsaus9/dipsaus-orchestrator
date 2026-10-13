// Secret file names (0008: `Read(./**/.env*)` and the secret paths an engine step cannot read).
// The context provider never reads a file whose name matches, and the workspace refuses to: such
// a file is listed by path only, so a secret cannot reach a prompt through the context pack.

const SECRET_NAMES: readonly RegExp[] = [
  /^\.env/i, // .env, .env.local, .envrc
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^_netrc$/i,
  /^\.git-credentials$/i,
  /\.pem$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i, // ssh keys and their .pub siblings
];

/** True when the last segment of the repo-relative `path` matches a secret pattern. */
export function isSecretPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return SECRET_NAMES.some((pattern) => pattern.test(base));
}
