// Secret paths (0008): file names, and directories that make everything under them secret.

import { describe, expect, it } from "bun:test";

import { isSecretPath } from "../../src/context";

describe("isSecretPath", () => {
  it("matches secret file names in any directory, ignoring case", () => {
    for (const path of [
      ".env",
      "config/.env.production",
      ".envrc",
      ".npmrc",
      ".netrc",
      "_netrc",
      ".git-credentials",
      "certs/server.pem",
      "home/id_ed25519.pub",
      "credentials",
      "aws/CREDENTIALS",
      "gcp/credentials.json",
      "deploy/secrets.yaml",
      "deploy/Secrets.YML",
      "deploy/secrets.json",
      "tls/server.key",
      "tls/client.P12",
      "tls/client.pfx",
      ".pgpass",
      ".dockercfg",
      "gcp/service-account.json",
      "gcp/Service-Account-prod.json",
      "android/release.keystore",
      "android/release.JKS",
    ]) {
      expect([path, isSecretPath(path)]).toEqual([path, true]);
    }
  });

  it("marks everything under a secret directory", () => {
    for (const path of [
      ".ssh/config",
      "home/.ssh/known_hosts",
      ".aws/config",
      "deploy/.gnupg/pubring.kbx",
      ".docker/config.json",
      "ops/.kube/config",
      ".env/notes.txt",
      "config/.env.d/app.yaml",
      "HOME/.SSH/config",
      "./.ssh/config",
    ]) {
      expect([path, isSecretPath(path)]).toEqual([path, true]);
    }
  });

  it("leaves ordinary files alone", () => {
    for (const path of [
      "src/secrets.ts",
      "src/credentials.ts",
      "docs/keys.md",
      "src/key.ts",
      "env/config.ts",
      "ssh/config",
      "docs/service-account.md",
      "src/environment.ts",
      "packages/engine/src/context/secrets.ts",
    ]) {
      expect([path, isSecretPath(path)]).toEqual([path, false]);
    }
  });
});
