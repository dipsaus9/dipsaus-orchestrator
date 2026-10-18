// The npm token check and the local toolchain read paths (DIPO-172): an npm auth key in a config
// file the worker sandbox can read refuses the run, naming the file and never the value; the
// worker's read list and PATH planning use the merged sandbox.toolchainReadPaths. Fixture homes
// live under DIPO_TMP (fallback /tmp), never the real home.

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS, resolveOfficeConfig, type OfficeConfig } from "../../src/config";
import { claudeLaunchContext } from "../../src/workers/claude-cli/adapter";
import {
  checkNpmTokens,
  findNpmTokens,
  npmAuthKey,
  npmTokenRefusal,
} from "../../src/workers/claude-cli/npm-token-check";
import { plan, SETTINGS_FILE } from "../../src/workers/claude-cli/plan";
import type { SafeChainInput } from "../../src/workers/claude-cli/safe-chain";
import type { RunLaunchPaths } from "../../src/workers/port";
import { PlanError } from "../../src/workers/types";
import {
  context,
  HOME,
  MAIN,
  RUN_DIR,
  SHORT_TMP_DIR,
  spec,
  TMP_DIR,
  WORKDIR,
} from "./launch-fixtures";

// Not a real token; the tests check that it never appears in a finding or a refusal.
const SECRET = "npm_FAKEfakeFAKEfake0123456789";
const NODE_VERSION = "v22.11.0";

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A node install as nvm lays it out under `home`, its global npmrc holding `npmrc`. */
function nvmInstall(home: string, npmrc: string | null): string {
  const prefix = join(home, ".nvm", "versions", "node", NODE_VERSION);
  write(join(prefix, "bin", "node"), "");
  if (npmrc !== null) write(join(prefix, "etc", "npmrc"), npmrc);
  return join(prefix, "etc", "npmrc");
}

describe("(unit) npmAuthKey", () => {
  it("finds _authToken, _auth and _password, bare or scoped, by key only", () => {
    expect(npmAuthKey(`//registry.npmjs.org/:_authToken=${SECRET}\n`)).toBe("_authToken");
    expect(npmAuthKey(`@acme:registry=https://npm.acme.test/\n//npm.acme.test/:_auth = x\n`)).toBe(
      "_auth",
    );
    expect(npmAuthKey(`_password="${SECRET}"\r\n`)).toBe("_password");
    expect(npmAuthKey(`  "_authToken" = ${SECRET}\n`)).toBe("_authToken");
  });

  it("ignores comments, sections and other keys", () => {
    const text = [
      `; //registry.npmjs.org/:_authToken=${SECRET}`,
      `# _auth=${SECRET}`,
      "[section]",
      "prefix=/opt/node",
      "registry=https://registry.npmjs.org/",
      "_authTokenFile=/dev/null",
      "always-auth=true",
      "email=me@example.test",
      `note=_authToken=${SECRET}`,
      "",
    ].join("\n");
    expect(npmAuthKey(text)).toBeNull();
    expect(npmAuthKey("")).toBeNull();
  });
});

describe("(unit) findNpmTokens", () => {
  it("refuses a node install under a read path whose etc/npmrc holds _authToken, naming the file", async () => {
    await withTempDir(async (home) => {
      const file = nvmInstall(home, `//registry.npmjs.org/:_authToken=${SECRET}\n`);
      const findings = await findNpmTokens({
        home,
        readPaths: ["~/.bun", "~/.nvm/versions/node"],
        searchPath: "/usr/bin:/bin",
      });
      expect(findings).toEqual([{ file, key: "_authToken", readPath: "~/.nvm/versions/node" }]);
      const refusal = npmTokenRefusal(findings);
      expect(refusal).toContain(file);
      expect(refusal).toContain("~/.npmrc");
      expect(JSON.stringify(findings)).not.toContain(SECRET);
      expect(refusal).not.toContain(SECRET);
    });
  });

  it("passes the same install without the key, and an install with no npmrc", async () => {
    await withTempDir(async (home) => {
      nvmInstall(home, "prefix=/opt/elsewhere\nregistry=https://registry.npmjs.org/\n");
      const input = { home, readPaths: ["~/.nvm/versions/node"], searchPath: "" };
      expect(await findNpmTokens(input)).toEqual([]);
    });
    await withTempDir(async (home) => {
      nvmInstall(home, null);
      expect(
        await findNpmTokens({ home, readPaths: ["~/.nvm/versions/node"], searchPath: "" }),
      ).toEqual([]);
    });
  });

  it("finds a .npmrc at the root of a read path, an install at a read path and an nvm root", async () => {
    await withTempDir(async (home) => {
      write(join(home, "tools", ".npmrc"), `_auth=${SECRET}\n`);
      write(join(home, "prefix", "etc", "npmrc"), `_password=${SECRET}\n`);
      const nvm = nvmInstall(home, `//r.test/:_authToken=${SECRET}\n`);
      const findings = await findNpmTokens({
        home,
        readPaths: ["~/tools", `${home}/prefix`, "~/.nvm"],
        searchPath: "",
      });
      expect(findings).toEqual([
        { file: join(home, "tools", ".npmrc"), key: "_auth", readPath: "~/tools" },
        {
          file: join(home, "prefix", "etc", "npmrc"),
          key: "_password",
          readPath: `${home}/prefix`,
        },
        { file: nvm, key: "_authToken", readPath: "~/.nvm" },
      ]);
    });
  });

  it("finds the global npmrc of a node on PATH that lies deeper under a read path", async () => {
    await withTempDir(async (home) => {
      const prefix = join(home, "opt", "runtimes", "node", "22");
      write(join(prefix, "bin", "node"), "");
      write(join(prefix, "etc", "npmrc"), `//registry.npmjs.org/:_authToken=${SECRET}\n`);
      const input = { home, readPaths: ["~/opt"], searchPath: `/usr/bin:${prefix}/bin` };
      expect(await findNpmTokens(input)).toEqual([
        { file: join(prefix, "etc", "npmrc"), key: "_authToken", readPath: "~/opt" },
      ]);
      // The same node outside every read path is not the sandbox's to read.
      expect(await findNpmTokens({ ...input, readPaths: ["~/.bun"] })).toEqual([]);
    });
  });

  it("reads sandbox.allowRead as a read path too", async () => {
    await withTempDir(async (home) => {
      const file = nvmInstall(home, `_authToken=${SECRET}\n`);
      const ctx = context({
        home,
        sandbox: { ...OFFICE_DEFAULTS.sandbox, allowRead: ["~/.nvm/versions/node"] },
      });
      const refusal = await checkNpmTokens(ctx).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(PlanError);
      expect((refusal as PlanError).message).toContain(file);
      expect((refusal as PlanError).refused).toBeUndefined();
    });
  });
});

const PATHS: RunLaunchPaths = {
  workdir: WORKDIR,
  mainCheckout: MAIN,
  runDir: RUN_DIR,
  hostSocket: `${RUN_DIR}/host.sock`,
  tmpDir: TMP_DIR,
  shortTmpDir: SHORT_TMP_DIR,
};

function configOf(office: string, local: string): OfficeConfig {
  const result = resolveOfficeConfig({ office, local });
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
  return result.config;
}

describe("(unit) the worker uses the merged toolchain read paths", () => {
  it("puts the local entries in the sandbox read list and the Safe-Chain PATH planning", () => {
    const config = configOf(
      "version: 2\nsandbox: { toolchainReadPaths: [~/.bun, ~/.npm, ~/.cache] }\n",
      "version: 4\nsandbox: { toolchainReadPaths: [~/.nvm/versions/node, ~/.bun] }\n",
    );
    const seen: SafeChainInput[] = [];
    const ctx = claudeLaunchContext(
      {
        claudePath: `${HOME}/.local/bin/claude`,
        home: HOME,
        env: { PATH: `${HOME}/.nvm/versions/node/${NODE_VERSION}/bin:/usr/bin:/bin` },
        detectSafeChain: (input) => {
          seen.push(input);
          return null;
        },
        pluginFiles: { read: () => undefined, dirs: () => [] },
      },
      PATHS,
      config,
    );
    expect(ctx.sandbox.toolchainReadPaths).toEqual([
      "~/.bun",
      "~/.npm",
      "~/.cache",
      "~/.nvm/versions/node",
    ]);
    expect(seen[0]?.readPaths).toEqual([
      `${HOME}/.bun`,
      `${HOME}/.npm`,
      `${HOME}/.cache`,
      `${HOME}/.nvm/versions/node`,
    ]);

    const launch = plan(spec(), ctx);
    const file = launch.files.find((entry) => entry.name === SETTINGS_FILE);
    const settings = JSON.parse(file?.content ?? "{}") as {
      sandbox: { filesystem: { allowRead: string[] } };
    };
    expect(settings.sandbox.filesystem.allowRead).toEqual([
      `${HOME}/.bun`,
      `${HOME}/.npm`,
      `${HOME}/.cache`,
      `${HOME}/.nvm/versions/node`,
    ]);
  });
});
