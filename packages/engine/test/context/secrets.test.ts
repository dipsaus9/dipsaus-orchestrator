// Secret paths (0008): file names, and directories that make everything under them secret.

import { describe, expect, it } from "bun:test";

import { isSecretPath } from "../../src/context";
import { isSecretPartPath, redactSecretText, SECRET_PATTERNS } from "../../src/context/secrets";

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

// DIPO-312: the common credential files, by name, for the context provider and for a box part.
describe("credential file names (DIPO-312)", () => {
  const CREDENTIAL_FILES: readonly (readonly [string, string])[] = [
    ["Claude's login", ".claude/.credentials.json"],
    ["Claude's login at the root", ".credentials.json"],
    ["Google Cloud CLI credentials", "gcloud/application_default_credentials.json"],
    ["an OAuth client secret", "client_secret.json"],
    [
      "an OAuth client secret with its id",
      "auth/client_secret_1234-abc.apps.googleusercontent.com.json",
    ],
    ["Python registry credentials", ".pypirc"],
    ["a Vault token", "home/.vault-token"],
    ["Wrangler's local variables", ".dev.vars"],
    ["Wrangler's variables of an environment", "worker/.dev.vars.staging"],
    ["infrastructure state", "infra/terraform.tfstate"],
    ["infrastructure state backup", "infra/terraform.tfstate.backup"],
    ["infrastructure variables", "infra/prod.tfvars"],
    ["infrastructure variables in JSON", "infra/prod.auto.tfvars.json"],
    ["a Kubernetes client configuration", "ops/kubeconfig"],
    ["a Kubernetes client configuration in YAML", "ops/kubeconfig.yaml"],
    ["a .p8 key", "keys/AuthKey_ABC123.p8"],
    ["a PuTTY key", "keys/deploy.PPK"],
  ];

  for (const [what, path] of CREDENTIAL_FILES) {
    it(`matches ${what} in isSecretPath and isSecretPartPath`, () => {
      expect([path, isSecretPath(path), isSecretPartPath(path)]).toEqual([path, true, true]);
    });
  }

  it("takes a .dev.vars template as no secret name in a part, as a .env template", () => {
    for (const path of [".dev.vars.example", "worker/.dev.vars.sample"]) {
      expect([path, isSecretPartPath(path), isSecretPath(path)]).toEqual([path, false, true]);
    }
    expect(isSecretPartPath(".ssh/.dev.vars.example")).toBe(true);
  });

  it("leaves code and documents that only share a word alone", () => {
    for (const path of [
      "src/credentials-form.tsx",
      "docs/kubeconfig.md",
      "src/kubeconfig.ts",
      "src/tfstate.ts",
      "docs/client_secret.md",
      "src/vault-token.ts",
      "docs/pypirc.md",
      "src/app.p8.ts",
      ".yarnrc.yml",
    ]) {
      expect([path, isSecretPath(path), isSecretPartPath(path)]).toEqual([path, false, false]);
    }
  });
});

describe("redactSecretText (DIPO-312)", () => {
  const GITHUB = `ghp_${"a1B2".repeat(9)}`;
  const AWS = "AKIAIOSFODNN7EXAMPLE";

  it("replaces each SECRET_PATTERNS shape", () => {
    const samples: Readonly<Record<string, string>> = {
      "a private key": "-----BEGIN PRIVATE KEY-----",
      "an AWS access key": AWS,
      "a GitHub token": GITHUB,
      "a GitLab token": `glpat-${"x".repeat(20)}`,
      "an Anthropic key": `sk-ant-${"x".repeat(20)}`,
      "an OpenAI key": `sk-proj-${"x".repeat(32)}`,
      "a Slack token": "xoxb-1234567890",
      "a Google API key": `AIza${"x".repeat(35)}`,
      "a Stripe live key": `sk_live_${"x".repeat(20)}`,
      "an npm token": `npm_${"A".repeat(36)}`,
    };
    expect(SECRET_PATTERNS.map((p) => p.kind).toSorted()).toEqual(Object.keys(samples).toSorted());
    for (const [kind, sample] of Object.entries(samples)) {
      expect([kind, redactSecretText(`value: ${sample} end`)]).toEqual([
        kind,
        "value: [redacted]" + (kind === "a private key" ? "" : " end"),
      ]);
    }
    expect(redactSecretText(`token ${GITHUB} and key ${AWS}.`)).toBe(
      "token [redacted] and key [redacted].",
    );
    expect(redactSecretText(`ANTHROPIC_API_KEY=sk-ant-${"x".repeat(30)}`)).toBe(
      "ANTHROPIC_API_KEY=[redacted]",
    );
    expect(redactSecretText(`npm_${"A".repeat(36)} xoxb-1234567890-abc`)).toBe(
      "[redacted] [redacted]",
    );
  });

  it("replaces a private key whole, to its end line or the end of the text", () => {
    const key =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactSecretText(`before ${key} after`)).toBe("before [redacted] after");
    expect(redactSecretText("cat -----BEGIN RSA PRIVATE KEY----- MIIEow cut")).toBe(
      "cat [redacted]",
    );
  });

  it("replaces every URL that holds user information, and keeps one that holds none", () => {
    expect(
      redactSecretText(
        "fatal: unable to access 'https://x-access-token:s3cr3t@github.com/o/r.git/': 403",
      ),
    ).toBe("fatal: unable to access '[redacted]': 403");
    expect(redactSecretText("git push https://user@example.com/r.git main")).toBe(
      "git push [redacted] main",
    );
    expect(redactSecretText("psql postgres://app:p%40ss@db.example.com:5432/app")).toBe(
      "psql [redacted]",
    );
    expect(redactSecretText("fetch https://example.com/a?b=c@d and mail@example.com")).toBe(
      "fetch https://example.com/a?b=c@d and mail@example.com",
    );
  });

  it("leaves ordinary text alone", () => {
    const text = "bun test packages/engine && git log --format=%H@%s";
    expect(redactSecretText(text)).toBe(text);
  });
});
