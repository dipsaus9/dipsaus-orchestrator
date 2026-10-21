// The post-run token check (DIPO-269) against a fake box: the token in neither, the environment or
// the files; a check that cannot read the box holds too; and the token never goes into the box or
// into a result.

import { readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { BoxExecOptions, BoxExecResult, BoxPort } from "../../src/box/port";
import { BoxError } from "../../src/box/port";
import { SecretToken } from "../../src/box/token";
import {
  checkBoxForToken,
  TOKEN_CHECK_ARCHIVE,
  TOKEN_CHECK_ARCHIVE_COMMAND,
  TOKEN_CHECK_ENV_COMMAND,
} from "../../src/box/token-check";

const TOKEN_TEXT = "fake-box-login-for-tests-0123456789";
const TOKEN = new SecretToken(TOKEN_TEXT);
const BOX = "dipo-run_01J9ZK5Q8W3V4X6Y7Z00000001";

interface FakeBoxScript {
  readonly env?: BoxExecResult | Error;
  readonly archive?: BoxExecResult | Error;
  /** The archive's bytes as copied out, or an error. */
  readonly files?: Uint8Array | Error;
}

interface FakeBox {
  readonly box: Pick<BoxPort, "exec" | "copyOut">;
  readonly execs: { command: readonly string[]; options: BoxExecOptions | undefined }[];
  readonly copies: { from: string; to: string }[];
}

function ok(stdout = ""): BoxExecResult {
  return { code: 0, stdout, stderr: "" };
}

function fakeBox(script: FakeBoxScript): FakeBox {
  const execs: FakeBox["execs"] = [];
  const copies: FakeBox["copies"] = [];
  const box: FakeBox["box"] = {
    exec: async (name, command, options) => {
      expect(name).toBe(BOX);
      execs.push({ command, options });
      const reply =
        command === TOKEN_CHECK_ENV_COMMAND
          ? (script.env ?? ok("PATH=/usr/bin\nHOME=/root\n"))
          : command === TOKEN_CHECK_ARCHIVE_COMMAND
            ? (script.archive ?? ok())
            : ok();
      if (reply instanceof Error) throw reply;
      return reply;
    },
    copyOut: async (name, from, to) => {
      expect(name).toBe(BOX);
      copies.push({ from, to });
      const files = script.files ?? new TextEncoder().encode("nothing here");
      if (files instanceof Error) throw files;
      await writeFile(to, files);
    },
  };
  return { box, execs, copies };
}

/** Every command the check ran in the box, flattened: the token may never be in one. */
function expectTokenNeverSent(fake: FakeBox): void {
  for (const { command, options } of fake.execs) {
    expect(command.join(" ")).not.toContain(TOKEN_TEXT);
    expect(JSON.stringify(options ?? {})).not.toContain(TOKEN_TEXT);
  }
}

describe("checkBoxForToken", () => {
  it("reports the token absent and does not hold", async () => {
    await withTempDir(async (dir) => {
      const fake = fakeBox({});
      const result = await checkBoxForToken({ box: fake.box, token: TOKEN, tmpRoot: dir }, BOX);
      expect(result).toEqual({ ok: true, code: "box.tokenAbsent", hold: false });
      expect(fake.execs.map((exec) => exec.command)).toEqual([
        TOKEN_CHECK_ENV_COMMAND,
        TOKEN_CHECK_ARCHIVE_COMMAND,
        ["rm", "-f", TOKEN_CHECK_ARCHIVE],
      ]);
      expect(fake.copies.map((copy) => copy.from)).toEqual([TOKEN_CHECK_ARCHIVE]);
      expectTokenNeverSent(fake);
      // The copied archive is gone from the host.
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("finds the token in the environment and holds", async () => {
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

  it("finds the token deep in the files and holds", async () => {
    await withTempDir(async (dir) => {
      // Past the first read chunk of the file stream, so the scan carries over chunk boundaries.
      const padding = "x".repeat(65_536 - 10);
      const fake = fakeBox({
        files: new TextEncoder().encode(`${padding}${TOKEN_TEXT}${padding}`),
      });
      const result = await checkBoxForToken({ box: fake.box, token: TOKEN, tmpRoot: dir }, BOX);
      expect(result).toEqual({ ok: false, code: "box.tokenFound", hold: true, foundIn: ["files"] });
      expectTokenNeverSent(fake);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("reports both places", async () => {
    await withTempDir(async (dir) => {
      const fake = fakeBox({
        env: { code: 0, stdout: `T=${TOKEN_TEXT}\n`, stderr: "" },
        files: new TextEncoder().encode(TOKEN_TEXT),
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

  it("holds when the environment cannot be read: an empty read proves nothing", async () => {
    await withTempDir(async (dir) => {
      for (const env of [
        { code: 1, stdout: "", stderr: "sh: not found" },
        { code: 0, stdout: "", stderr: "" },
        new BoxError("box.timedOut", "container exec did not finish"),
      ]) {
        const result = await checkBoxForToken(
          { box: fakeBox({ env }).box, token: TOKEN, tmpRoot: dir },
          BOX,
        );
        expect(result.code).toBe("box.tokenCheckFailed");
        expect(result.hold).toBe(true);
      }
    });
  });

  it("holds when the files cannot be archived or copied out", async () => {
    await withTempDir(async (dir) => {
      for (const script of [
        { archive: { code: 2, stdout: "", stderr: "tar: /: Cannot open\n" } },
        { archive: new BoxError("box.timedOut", "container exec did not finish") },
        { files: new BoxError("box.failed", "container copy failed") },
      ] satisfies FakeBoxScript[]) {
        const result = await checkBoxForToken(
          { box: fakeBox(script).box, token: TOKEN, tmpRoot: dir },
          BOX,
        );
        expect(result.code).toBe("box.tokenCheckFailed");
        expect(result.hold).toBe(true);
      }
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("never puts the token in a failure's reason", async () => {
    await withTempDir(async (dir) => {
      const fake = fakeBox({
        archive: { code: 2, stdout: "", stderr: `tar: ./${TOKEN_TEXT}: Cannot open\n` },
      });
      const result = await checkBoxForToken({ box: fake.box, token: TOKEN, tmpRoot: dir }, BOX);
      expect(result.code).toBe("box.tokenCheckFailed");
      expect(JSON.stringify(result)).not.toContain(TOKEN_TEXT);
      expect(JSON.stringify(result)).toContain("[box login]");
    });
  });

  it("archives the whole filesystem without the pseudo filesystems, itself or the cache", () => {
    expect(TOKEN_CHECK_ARCHIVE_COMMAND).toEqual([
      "tar",
      "-cf",
      TOKEN_CHECK_ARCHIVE,
      "--exclude=./proc",
      "--exclude=./sys",
      "--exclude=./dev",
      `--exclude=.${TOKEN_CHECK_ARCHIVE}`,
      "--exclude=./dipo/package-cache",
      "-C",
      "/",
      ".",
    ]);
  });
});
