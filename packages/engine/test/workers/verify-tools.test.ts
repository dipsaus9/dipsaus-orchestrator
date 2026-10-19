// The verify tools check (DIPO-173): a program the office's verify runs whose interpreter the
// worker sandbox cannot reach refuses the run, naming sandbox.toolchainReadPaths, without holding
// the adapter for other offices. Fixture homes live under DIPO_TMP (fallback /tmp), never the real
// home.

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import {
  checkVerifyTools,
  shebangInterpreter,
  verifyPrograms,
} from "../../src/workers/claude-cli/verify-tools";
import type { VerifyCommands } from "../../src/workers/port";
import { PlanError } from "../../src/workers/types";
import { context } from "./launch-fixtures";

const VERIFY: VerifyCommands = { commands: [["bun", "run", "verify"]], cwd: "." };
/** The ways to call the root `verify` script; each runs the same programs as `bun run verify`. */
const SCRIPT_CALLS: string[][] = [
  ["bun", "run", "verify"],
  ["bun", "verify"],
  ["pnpm", "run", "verify"],
  ["pnpm", "verify"],
  ["yarn", "run", "verify"],
  ["yarn", "verify"],
];
const NPX = ["npx", "--no-install", "oxfmt", "--check"];

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

/** A checkout under `home` whose verify runs oxfmt (needs node) through two scripts. */
function checkout(home: string, scripts?: Record<string, string>): string {
  const root = join(home, "work", "shop");
  write(
    join(root, "package.json"),
    JSON.stringify({
      scripts: scripts ?? {
        verify: "oxfmt --check && bun run lint:all",
        "lint:all": "FOO=1 oxlint --deny-warnings; bun test",
      },
    }),
  );
  write(join(root, "node_modules", "oxfmt", "bin.js"), "#!/usr/bin/env node\n", 0o755);
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  symlinkSync("../oxfmt/bin.js", join(root, "node_modules", ".bin", "oxfmt"));
  write(join(root, "node_modules", ".bin", "oxlint"), "#!/usr/bin/env -S node --flag\n", 0o755);
  return root;
}

/** A node install as nvm lays it out; returns its `bin` directory. */
function nvmNode(home: string): string {
  const bin = join(home, ".nvm", "versions", "node", "v22.11.0", "bin");
  write(join(bin, "node"), "", 0o755);
  return bin;
}

function sandboxWith(...dirs: string[]) {
  return {
    ...OFFICE_DEFAULTS.sandbox,
    toolchainReadPaths: [...OFFICE_DEFAULTS.sandbox.toolchainReadPaths, ...dirs],
  };
}

function ctxFor(home: string, nodeBin: string, dirs: string[] = []) {
  return context({
    home,
    mainCheckout: join(home, "main"),
    env: { PATH: `${nodeBin}:/nonexistent/bin`, HOME: home },
    sandbox: sandboxWith(...dirs),
  });
}

const refusal = (run: Promise<unknown>) =>
  run.then(
    () => null,
    (error: unknown) => error,
  );

describe("(unit) verify programs and shebangs", () => {
  it("follows bun run and npm run through the root scripts and takes the first words", async () => {
    await withTempDir(async (home) => {
      const root = checkout(home, {
        verify: "oxfmt --check && npm run b",
        b: "bun run --silent c | cat; echo done",
        c: "tsc -b && bun run verify",
      });
      expect(await verifyPrograms(root, VERIFY)).toEqual(["oxfmt", "tsc", "cat", "echo"]);
    });
  });

  it("follows pnpm, yarn and bun script calls and npx's bin the way bun run does", async () => {
    await withTempDir(async (home) => {
      const root = checkout(home, { verify: "oxfmt --check && oxlint --deny-warnings" });
      for (const command of SCRIPT_CALLS) {
        expect(await verifyPrograms(root, { commands: [command], cwd: "." })).toEqual([
          "oxfmt",
          "oxlint",
        ]);
      }
      expect(await verifyPrograms(root, { commands: [NPX], cwd: "." })).toEqual(["oxfmt"]);
    });
  });

  it("leaves bun's own commands alone, so bun test with a test script is not followed", async () => {
    await withTempDir(async (home) => {
      const root = checkout(home, { verify: "oxfmt --check", test: "oxlint --deny-warnings" });
      expect(await verifyPrograms(root, { commands: [["bun", "test"]], cwd: "." })).toEqual([
        "bun",
      ]);
      expect(await verifyPrograms(root, { commands: [["bun", "run", "test"]], cwd: "." })).toEqual([
        "oxlint",
      ]);
    });
  });

  // The words `bun --help` of Bun 1.4.2 lists as its own commands and short forms.
  it.each(["prune", "dedupe", "i", "a", "rm", "c"])(
    "leaves bun %s alone when a script of the same name exists",
    async (word) => {
      await withTempDir(async (home) => {
        const root = checkout(home, { verify: "oxfmt --check", [word]: "oxlint --deny-warnings" });
        expect(await verifyPrograms(root, { commands: [["bun", word]], cwd: "." })).toEqual([
          "bun",
        ]);
      });
    },
  );

  it("reads env, env -S and absolute interpreter lines; others are not scripts", () => {
    expect(shebangInterpreter("#!/usr/bin/env node\nx")).toBe("node");
    expect(shebangInterpreter("#!/usr/bin/env -S node --flag\n")).toBe("node");
    expect(shebangInterpreter("#!/usr/bin/node\n")).toBe("/usr/bin/node");
    expect(shebangInterpreter("\u007fELF")).toBeNull();
  });
});

describe("(unit) checkVerifyTools", () => {
  it("refuses a node outside the read paths, naming the program, node, where it is and the key", async () => {
    await withTempDir(async (home) => {
      const root = checkout(home);
      const bin = nvmNode(home);
      const error = await refusal(checkVerifyTools(ctxFor(home, bin), root, VERIFY));
      expect(error).toBeInstanceOf(PlanError);
      const message = (error as PlanError).message;
      // One failure for node, naming both programs that need it.
      expect(message.match(/verify runs/g)).toHaveLength(1);
      expect(message).toContain("oxfmt, oxlint");
      expect(message).toContain(`${bin}/node`);
      expect(message).toContain("sandbox.toolchainReadPaths in .dipo/office.local.yaml");
      expect(message).toContain("~/.nvm/versions/node/v22.11.0");
    });
  });

  it("passes the same checkout with node's directory in sandbox.toolchainReadPaths", async () => {
    await withTempDir(async (home) => {
      const root = checkout(home);
      const bin = nvmNode(home);
      const ctx = ctxFor(home, bin, ["~/.nvm/versions/node"]);
      expect(await refusal(checkVerifyTools(ctx, root, VERIFY))).toBeNull();
    });
  });

  it("passes when a node outside the home directory is on the PATH", async () => {
    await withTempDir(async (home) => {
      const root = checkout(home);
      await withTempDir(async (system) => {
        write(join(system, "node"), "", 0o755);
        // `system` is outside the home directory, so the worker can read it.
        const ctx = ctxFor(home, `${home}/.nvm/none/bin:${system}`);
        expect(await refusal(checkVerifyTools(ctx, root, VERIFY))).toBeNull();
      });
    });
  });

  it("refuses a node in a readable PATH directory that links into a directory outside the read paths", async () => {
    await withTempDir(async (home) => {
      const root = checkout(home);
      const target = nvmNode(home);
      // ~/.bun is in the default read paths; its node is a link to the nvm install.
      const bunBin = join(home, ".bun", "bin");
      mkdirSync(bunBin, { recursive: true });
      symlinkSync(join(target, "node"), join(bunBin, "node"));
      const error = await refusal(checkVerifyTools(ctxFor(home, bunBin), root, VERIFY));
      expect(error).toBeInstanceOf(PlanError);
      const message = (error as PlanError).message;
      expect(message).toContain(`finds node at ${target}/node`);
      expect(message).toContain(
        "Add ~/.nvm/versions/node/v22.11.0 to sandbox.toolchainReadPaths in .dipo/office.local.yaml",
      );
    });
  });

  it("refuses a node in a PATH entry that is a link to a directory outside the read paths", async () => {
    await withTempDir(async (home) => {
      const root = checkout(home);
      const target = nvmNode(home);
      mkdirSync(join(home, ".bun"), { recursive: true });
      symlinkSync(target, join(home, ".bun", "bin"));
      const error = await refusal(
        checkVerifyTools(ctxFor(home, join(home, ".bun", "bin")), root, VERIFY),
      );
      expect((error as PlanError).message).toContain(`finds node at ${target}/node`);
    });
  });

  it("refuses with the missing node named when the PATH finds none", async () => {
    await withTempDir(async (home) => {
      const root = checkout(home);
      const error = await refusal(checkVerifyTools(ctxFor(home, "/nonexistent/bin"), root, VERIFY));
      expect((error as PlanError).message).toContain("does not find node either");
    });
  });

  it("passes a verify that runs no node_modules/.bin program", async () => {
    await withTempDir(async (home) => {
      const root = checkout(home, { verify: "bun test && bun run typecheck", typecheck: "bun x" });
      const bin = nvmNode(home);
      expect(await refusal(checkVerifyTools(ctxFor(home, bin), root, VERIFY))).toBeNull();
    });
  });

  it.each([...SCRIPT_CALLS, NPX])(
    "refuses %j when its node is outside the read paths",
    async (...command: string[]) => {
      await withTempDir(async (home) => {
        const root = checkout(home, { verify: "oxfmt --check && oxlint --deny-warnings" });
        const bin = nvmNode(home);
        const verify: VerifyCommands = { commands: [command], cwd: "." };
        const error = await refusal(checkVerifyTools(ctxFor(home, bin), root, verify));
        expect(error).toBeInstanceOf(PlanError);
        expect((error as PlanError).message).toContain(`${bin}/node`);
        expect((error as PlanError).message).toContain("oxfmt");
      });
    },
  );

  it("passes a shorthand word that names neither a script nor a bin program", async () => {
    await withTempDir(async (home) => {
      const root = checkout(home);
      const bin = nvmNode(home);
      const verify: VerifyCommands = { commands: [["pnpm", "frobnicate"]], cwd: "." };
      expect(await refusal(checkVerifyTools(ctxFor(home, bin), root, verify))).toBeNull();
    });
  });
});
