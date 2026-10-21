// The post-run token check (DIPO-269) against a fake box: the token in neither, the environment or
// the host-made export; a check that cannot read the box, or a too-small export, fails and holds;
// no failure rejects; the adapter hold is raised on a find and on a failure, never on absent; and
// the token never goes into the box or into a result or hold.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import type { BoxExecOptions, BoxExecResult, BoxPort } from "../../src/box/port";
import { BoxError } from "../../src/box/port";
import { SecretToken } from "../../src/box/token";
import {
  BOX_TOKEN_CHECK,
  checkBoxAfterRun,
  checkBoxForToken,
  sweepTokenCheckLeftovers,
  TOKEN_CHECK_DIR_PREFIX,
  TOKEN_CHECK_ENV_COMMAND,
  TOKEN_CHECK_EXPORT_FILE,
} from "../../src/box/token-check";
import { AdapterHolds, type HoldNotice } from "../../src/workers/hold";

const TOKEN_TEXT = "fake-box-login-for-tests-0123456789";
const TOKEN = new SecretToken(TOKEN_TEXT);
const BOX = "dipo-run_01J9ZK5Q8W3V4X6Y7Z00000001";
const encoder = new TextEncoder();

/** A plausible export: past one tar header, with no token. */
const CLEAN_EXPORT = encoder.encode("x".repeat(2048));

interface FakeBoxScript {
  readonly env?: BoxExecResult | Error;
  /** The export's bytes as the host writes them, null for no file, or an error. */
  readonly files?: Uint8Array | null | Error;
}

interface FakeBox {
  readonly box: Pick<BoxPort, "exec" | "exportFiles">;
  readonly execs: { command: readonly string[]; options: BoxExecOptions | undefined }[];
  readonly exports: string[];
}

function fakeBox(script: FakeBoxScript): FakeBox {
  const execs: FakeBox["execs"] = [];
  const exports: string[] = [];
  const box: FakeBox["box"] = {
    exec: async (name, command, options) => {
      expect(name).toBe(BOX);
      execs.push({ command, options });
      const reply = script.env ?? { code: 0, stdout: "PATH=/usr/bin\nHOME=/root\n", stderr: "" };
      if (reply instanceof Error) throw reply;
      return reply;
    },
    exportFiles: async (name, to) => {
      expect(name).toBe(BOX);
      exports.push(to);
      const files = script.files === undefined ? CLEAN_EXPORT : script.files;
      if (files instanceof Error) throw files;
      if (files !== null) await writeFile(to, files);
    },
  };
  return { box, execs, exports };
}

/** The token is never in a command or option sent into the box. */
function expectTokenNeverSent(fake: FakeBox): void {
  for (const { command, options } of fake.execs) {
    expect(command.join(" ")).not.toContain(TOKEN_TEXT);
    expect(JSON.stringify(options ?? {})).not.toContain(TOKEN_TEXT);
  }
}

describe("checkBoxForToken", () => {
  it("reports the token absent, reads the environment in the box and the files from the host", async () => {
    await withTempDir(async (dir) => {
      const fake = fakeBox({});
      const result = await checkBoxForToken({ box: fake.box, token: TOKEN, tmpRoot: dir }, BOX);
      expect(result).toEqual({ ok: true, code: "box.tokenAbsent", hold: false });
      // The only command run in the box reads its environment; the files come from the host.
      expect(fake.execs.map((exec) => exec.command)).toEqual([TOKEN_CHECK_ENV_COMMAND]);
      expect(fake.exports).toHaveLength(1);
      const [exported] = fake.exports;
      expect(exported?.startsWith(join(dir, TOKEN_CHECK_DIR_PREFIX))).toBe(true);
      expect(exported?.endsWith(`/${TOKEN_CHECK_EXPORT_FILE}`)).toBe(true);
      expectTokenNeverSent(fake);
      // The export is gone from the host.
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("finds the token in the environment", async () => {
    await withTempDir(async (dir) => {
      const fake = fakeBox({
        env: {
          code: 0,
          stdout: `PATH=/usr/bin\0CLAUDE_CODE_OAUTH_TOKEN=${TOKEN_TEXT}\0`,
          stderr: "",
        },
      });
      const result = await checkBoxForToken({ box: fake.box, token: TOKEN, tmpRoot: dir }, BOX);
      expect(result).toEqual({
        ok: false,
        code: "box.tokenFound",
        hold: true,
        foundIn: ["environment"],
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN_TEXT);
      expectTokenNeverSent(fake);
    });
  });

  it("finds the token deep in the export, across read chunks", async () => {
    await withTempDir(async (dir) => {
      const padding = "x".repeat(65_536 - 10);
      const fake = fakeBox({ files: encoder.encode(`${padding}${TOKEN_TEXT}${padding}`) });
      const result = await checkBoxForToken({ box: fake.box, token: TOKEN, tmpRoot: dir }, BOX);
      expect(result).toEqual({ ok: false, code: "box.tokenFound", hold: true, foundIn: ["files"] });
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("reports both places", async () => {
    await withTempDir(async (dir) => {
      const fake = fakeBox({
        env: { code: 0, stdout: `T=${TOKEN_TEXT}\n`, stderr: "" },
        files: encoder.encode(`${"y".repeat(600)}${TOKEN_TEXT}`),
      });
      const result = await checkBoxForToken({ box: fake.box, token: TOKEN, tmpRoot: dir }, BOX);
      expect(result).toEqual({
        ok: false,
        code: "box.tokenFound",
        hold: true,
        foundIn: ["environment", "files"],
      });
    });
  });

  it("fails and holds when the environment cannot be read: an empty read proves nothing", async () => {
    await withTempDir(async (dir) => {
      for (const env of [
        { code: 1, stdout: "", stderr: "sh: not found" },
        { code: 0, stdout: "", stderr: "" },
        new BoxError("box.timedOut", `container exec did not finish ${TOKEN_TEXT}`),
      ]) {
        const result = await checkBoxForToken(
          { box: fakeBox({ env }).box, token: TOKEN, tmpRoot: dir },
          BOX,
        );
        expect(result.code).toBe("box.tokenCheckFailed");
        expect(result.hold).toBe(true);
        expect(JSON.stringify(result)).not.toContain(TOKEN_TEXT);
      }
    });
  });

  it("fails and holds on an export that fails, is missing, empty or smaller than a tar header", async () => {
    await withTempDir(async (dir) => {
      for (const files of [
        new BoxError("box.failed", `container export failed near ${TOKEN_TEXT}`),
        new BoxError("box.timedOut", "container export did not finish"),
        null,
        new Uint8Array(0),
        encoder.encode("x".repeat(511)),
      ]) {
        const result = await checkBoxForToken(
          { box: fakeBox({ files }).box, token: TOKEN, tmpRoot: dir },
          BOX,
        );
        expect(result.code).toBe("box.tokenCheckFailed");
        expect(result.hold).toBe(true);
        expect(JSON.stringify(result)).not.toContain(TOKEN_TEXT);
      }
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("returns a failure, never rejects, when the host folder cannot be made", async () => {
    await withTempDir(async (dir) => {
      const result = await checkBoxForToken(
        { box: fakeBox({}).box, token: TOKEN, tmpRoot: join(dir, "missing", "deeper") },
        BOX,
      );
      expect(result.code).toBe("box.tokenCheckFailed");
      expect(result.hold).toBe(true);
    });
  });

  it("returns a failure, never rejects, when the box port throws something odd", async () => {
    await withTempDir(async (dir) => {
      const box: FakeBox["box"] = {
        exec: async () => {
          throw "not even an error";
        },
        exportFiles: async () => {},
      };
      const result = await checkBoxForToken({ box, token: TOKEN, tmpRoot: dir }, BOX);
      expect(result.code).toBe("box.tokenCheckFailed");
    });
  });
});

describe("sweepTokenCheckLeftovers", () => {
  it("removes only the check's export folders and never rejects", async () => {
    await withTempDir(async (dir) => {
      for (const leftover of [`${TOKEN_CHECK_DIR_PREFIX}a1`, `${TOKEN_CHECK_DIR_PREFIX}b2`]) {
        mkdirSync(join(dir, leftover));
        writeFileSync(join(dir, leftover, TOKEN_CHECK_EXPORT_FILE), TOKEN_TEXT);
      }
      mkdirSync(join(dir, "dipo-other"));
      writeFileSync(join(dir, "keep.txt"), "x");
      expect(await sweepTokenCheckLeftovers(dir)).toBe(2);
      expect(readdirSync(dir).toSorted()).toEqual(["dipo-other", "keep.txt"]);
      expect(await sweepTokenCheckLeftovers(join(dir, "missing"))).toBe(0);
    });
  });
});

function holds(): { holds: AdapterHolds; notices: HoldNotice[] } {
  const notices: HoldNotice[] = [];
  return {
    notices,
    holds: new AdapterHolds({ clock: new ManualClock(), notify: (n) => notices.push(n) }),
  };
}

describe("checkBoxAfterRun", () => {
  it("raises no hold when the token is absent", async () => {
    await withTempDir(async (dir) => {
      const { holds: adapterHolds, notices } = holds();
      const outcome = await checkBoxAfterRun(
        {
          box: fakeBox({}).box,
          token: TOKEN,
          tmpRoot: dir,
          holds: adapterHolds,
          adapter: "claude",
        },
        BOX,
      );
      expect(outcome.result.code).toBe("box.tokenAbsent");
      expect(outcome.hold).toBeNull();
      expect(adapterHolds.adapterHeld("claude")).toBeNull();
      expect(notices).toEqual([]);
    });
  });

  it("holds the adapter when the token is found, with no token in the hold", async () => {
    await withTempDir(async (dir) => {
      const { holds: adapterHolds, notices } = holds();
      const fake = fakeBox({ env: { code: 0, stdout: `T=${TOKEN_TEXT}\n`, stderr: "" } });
      const outcome = await checkBoxAfterRun(
        { box: fake.box, token: TOKEN, tmpRoot: dir, holds: adapterHolds, adapter: "claude" },
        BOX,
      );
      expect(outcome.result.code).toBe("box.tokenFound");
      const held = adapterHolds.adapterHeld("claude");
      expect(held?.check).toBe(BOX_TOKEN_CHECK);
      expect(held?.detail).toContain("environment");
      expect(outcome.hold).toEqual(held);
      expect(notices.map((notice) => notice.code)).toEqual(["adapter.held"]);
      expect(JSON.stringify([held, notices])).not.toContain(TOKEN_TEXT);
    });
  });

  it("holds the adapter when the check cannot finish, with no token or fragment in the hold", async () => {
    await withTempDir(async (dir) => {
      const { holds: adapterHolds, notices } = holds();
      const fragment = TOKEN_TEXT.slice(0, 12);
      const fake = fakeBox({ files: new BoxError("box.failed", `export failed: ${fragment}`) });
      const outcome = await checkBoxAfterRun(
        { box: fake.box, token: TOKEN, tmpRoot: dir, holds: adapterHolds, adapter: "claude" },
        BOX,
      );
      expect(outcome.result.code).toBe("box.tokenCheckFailed");
      const held = adapterHolds.adapterHeld("claude");
      expect(held?.check).toBe(BOX_TOKEN_CHECK);
      expect(held?.detail).toContain("box.failed");
      expect(JSON.stringify([outcome, held, notices])).not.toContain(fragment);
    });
  });
});
