// Every Backlog CLI call reads the CLI's output from regular files after it exits (DIPO-333): with
// a real CLI stand-in that prints a list of over 300 KB slowly, `runBacklog` and `listAll` get every
// entry, the stand-in sees a regular file as its stdout and stderr (never a pipe), and the output
// folder under `DIPO_TMP` is gone afterwards, also when the CLI fails. An output that cannot be
// read is a `BacklogCommandError`.

import { describe, expect, it } from "bun:test";

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { BacklogCommandError, listAll, runBacklog } from "../../src/backlog";
import type { BacklogCli } from "../../src/backlog/runner";
import { OUTPUT_DIR_PREFIX, OUTPUT_MAX_BYTES } from "../../src/platform/output-files";
import { systemSpawn } from "../../src/platform/process";

const ENTRIES = 3000;

/** A `backlog` stand-in: `task list --plain` prints ENTRIES entries in slow chunks. */
const STAND_IN = `
const fs = require("node:fs");
const args = process.argv.slice(2);
const kinds = [fs.fstatSync(1), fs.fstatSync(2)].map((s) => (s.isFile() ? "file" : s.isFIFO() ? "pipe" : "other"));
if (args.includes("huge")) {
  fs.ftruncateSync(1, ${OUTPUT_MAX_BYTES + 1});
  process.exit(0);
}
if (args.includes("fail")) {
  console.log("half a list");
  console.error("stand-in failed");
  process.exit(2);
}
if (args.includes("--count")) {
  console.log(${ENTRIES});
} else {
  console.log("Done:");
  for (let chunk = 0; chunk < ${ENTRIES} / 100; chunk++) {
    let text = "";
    for (let i = 0; i < 100; i++) {
      const id = chunk * 100 + i + 1;
      text += "  [LOW] [feature] TASK-" + id + " - " + "y".repeat(90) + " (ac: 1/1)\\n";
    }
    process.stdout.write(text);
    await Bun.sleep(10);
  }
  console.log("");
}
console.error("outputs: " + kinds.join(","));
`;

/** A project folder with a Backlog configuration, the stand-in, and a temp root for outputs. */
function project(dir: string): { cli: BacklogCli; cwd: string; tmp: string } {
  const cwd = join(dir, "repo");
  mkdirSync(join(cwd, "backlog"), { recursive: true });
  writeFileSync(join(cwd, "backlog", "config.yml"), 'project_name: "stand-in"\n');
  const standIn = join(dir, "backlog-stand-in.ts");
  writeFileSync(standIn, STAND_IN);
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  return { cli: { spawn: systemSpawn, command: [process.execPath, standIn] }, cwd, tmp };
}

/** Runs `fn` with `DIPO_TMP` set to `tmp`, the temp root `runBacklog` puts the outputs under. */
async function withDipoTmp<T>(tmp: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env["DIPO_TMP"];
  process.env["DIPO_TMP"] = tmp;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env["DIPO_TMP"];
    else process.env["DIPO_TMP"] = before;
  }
}

function leftovers(tmp: string): string[] {
  return readdirSync(tmp).filter((name) => name.startsWith(OUTPUT_DIR_PREFIX));
}

describe("runBacklog reads the CLI's output from files (DIPO-333)", () => {
  it("gets every entry of a long, slow list, and the CLI writes to regular files", async () => {
    await withTempDir(async (dir) => {
      const { cli, cwd, tmp } = project(dir);
      await withDipoTmp(tmp, async () => {
        const out = await runBacklog(cli, cwd, ["task", "list", "--plain"]);
        expect(Buffer.byteLength(out.stdout)).toBeGreaterThan(300 * 1024);
        expect(out.stdout.split("\n").filter((line) => line.includes("TASK-"))).toHaveLength(
          ENTRIES,
        );
        expect(out.stderr).toBe("outputs: file,file\n");
        expect(leftovers(tmp)).toEqual([]);
      });
    });
  }, 30_000);

  it("lets listAll agree with --count on the whole list", async () => {
    await withTempDir(async (dir) => {
      const { cli, cwd, tmp } = project(dir);
      await withDipoTmp(tmp, async () => {
        const list = await listAll(cli, cwd, "task");
        expect(list.entries).toHaveLength(ENTRIES);
        expect(list.entries.at(-1)?.id).toBe(`TASK-${ENTRIES}`);
        expect(leftovers(tmp)).toEqual([]);
      });
    });
  }, 30_000);

  it("fails with a CLI error when the output file cannot be read, and removes the folder", async () => {
    await withTempDir(async (dir) => {
      const { cli, cwd, tmp } = project(dir);
      await withDipoTmp(tmp, async () => {
        const call = runBacklog(cli, cwd, ["task", "view", "huge", "--plain"]);
        await expect(call).rejects.toBeInstanceOf(BacklogCommandError);
        await expect(call).rejects.toThrow(/output could not be read: .*more than dipo reads/);
        expect(leftovers(tmp)).toEqual([]);
      });
    });
  }, 30_000);

  it("fails with a CLI error when a stream of the output fails", async () => {
    await withTempDir(async (dir) => {
      const { cwd } = project(dir);
      const failing = new ReadableStream<Uint8Array>({
        start: (controller) => controller.error(new Error("EIO: i/o error, read")),
      });
      const spawn: BacklogCli["spawn"] = () => ({
        pid: 1,
        stdin: null,
        stdout: failing,
        stderr: new Response("").body as ReadableStream<Uint8Array>,
        exited: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      });
      const call = runBacklog({ spawn, command: ["backlog"] }, cwd, ["task", "list", "--plain"]);
      await expect(call).rejects.toBeInstanceOf(BacklogCommandError);
      await expect(call).rejects.toThrow(
        "`backlog task list --plain` output could not be read: EIO: i/o error, read",
      );
    });
  });

  it("carries a failed call's output in the error and removes the folder", async () => {
    await withTempDir(async (dir) => {
      const { cli, cwd, tmp } = project(dir);
      await withDipoTmp(tmp, async () => {
        const call = runBacklog(cli, cwd, ["task", "view", "fail", "--plain"]);
        await expect(call).rejects.toBeInstanceOf(BacklogCommandError);
        const error = (await call.catch((caught: unknown) => caught)) as BacklogCommandError;
        expect(error.exitCode).toBe(2);
        expect(error.stdout).toBe("half a list\n");
        expect(error.stderr).toContain("stand-in failed");
        expect(leftovers(tmp)).toEqual([]);
      });
    });
  }, 30_000);
});
