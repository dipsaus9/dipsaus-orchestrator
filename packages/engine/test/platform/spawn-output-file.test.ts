// `systemSpawn` with `output: { to: "file" }` (DIPO-333): on real processes, a child's stdout and
// stderr go to regular files (mode 0600) in a private folder (mode 0700) under the temp root, never
// to a pipe, and reach the caller whole once the child has exited, also over 300 KB and when the
// child writes slowly. The folder is removed after the read, also when the child fails, when
// nobody reads, and when the child cannot start.

import { describe, expect, it } from "bun:test";

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { OUTPUT_DIR_PREFIX, systemSpawn } from "../../src/platform/process";

/** Runs `script` with this Bun, output through files under `tempRoot`. */
function spawnScript(script: string, tempRoot: string) {
  return systemSpawn({
    cmd: [process.execPath, "-e", script],
    output: { to: "file", tempRoot },
  });
}

async function outputOf(child: ReturnType<typeof systemSpawn>) {
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

/** The output folders left under `root`. */
function leftovers(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.startsWith(OUTPUT_DIR_PREFIX));
}

/** Waits up to 2 s for `check` to hold. */
async function eventually(check: () => boolean): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

const LINE = `  [LOW] [feature] DIPO-1 - ${"x".repeat(90)} (ac: 1/1)`;

describe("systemSpawn with output to files (DIPO-333)", () => {
  it("hands over more than 300 KB whole, and the child's stdout is a regular file", async () => {
    await withTempDir(async (root) => {
      const script = [
        `const fs = require("node:fs");`,
        `for (let i = 0; i < 3500; i++) console.log(${JSON.stringify(LINE)} + " " + i);`,
        `const s = fs.fstatSync(1);`,
        `console.error(JSON.stringify({ file: s.isFile(), fifo: s.isFIFO(), socket: s.isSocket(), mode: s.mode & 0o777 }));`,
      ].join("\n");
      const { stdout, stderr, exit } = await outputOf(spawnScript(script, root));
      expect(exit).toEqual({ code: 0, signal: null });
      const lines = stdout.split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(3500);
      expect(lines.at(-1)).toBe(`${LINE} 3499`);
      expect(Buffer.byteLength(stdout)).toBeGreaterThan(300 * 1024);
      expect(JSON.parse(stderr)).toEqual({ file: true, fifo: false, socket: false, mode: 0o600 });
      expect(leftovers(root)).toEqual([]);
    });
  });

  it("hands over the whole output of a child that writes slowly", async () => {
    await withTempDir(async (root) => {
      const script = [
        `for (let i = 0; i < 40; i++) {`,
        `  process.stdout.write(${JSON.stringify(`${LINE}\n`)}.repeat(100));`,
        `  await Bun.sleep(15);`,
        `}`,
        `process.stdout.write("end\\n");`,
      ].join("\n");
      const { stdout, exit } = await outputOf(spawnScript(script, root));
      expect(exit.code).toBe(0);
      const lines = stdout.split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(4001);
      expect(lines.at(-1)).toBe("end");
      expect(leftovers(root)).toEqual([]);
    });
  });

  it("keeps the folder private while the child runs", async () => {
    await withTempDir(async (root) => {
      const child = spawnScript(`await Bun.sleep(300); console.log("done");`, root);
      const [dir] = leftovers(root);
      expect(dir).toBeDefined();
      const folder = join(root, dir ?? "");
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(readdirSync(folder).toSorted()).toEqual(["stderr", "stdout"]);
      for (const name of ["stdout", "stderr"]) {
        const stat = statSync(join(folder, name));
        expect(stat.isFile()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o600);
      }
      expect((await outputOf(child)).stdout).toBe("done\n");
      expect(leftovers(root)).toEqual([]);
    });
  });

  it("hands over the output of a child that fails, and removes the folder", async () => {
    await withTempDir(async (root) => {
      const script = `console.log("partial"); console.error("broke"); process.exit(3);`;
      const { stdout, stderr, exit } = await outputOf(spawnScript(script, root));
      expect(exit).toEqual({ code: 3, signal: null });
      expect(stdout).toBe("partial\n");
      expect(stderr).toBe("broke\n");
      expect(leftovers(root)).toEqual([]);
    });
  });

  it("removes the folder when nobody reads the output", async () => {
    await withTempDir(async (root) => {
      const child = spawnScript(`console.log("unread"); console.error("unread");`, root);
      await child.exited;
      expect(await eventually(() => leftovers(root).length === 0)).toBe(true);
    });
  });

  it("removes the folder when the child cannot start", async () => {
    await withTempDir(async (root) => {
      expect(() =>
        systemSpawn({
          cmd: [join(root, "no-such-program")],
          output: { to: "file", tempRoot: root },
        }),
      ).toThrow();
      expect(leftovers(root)).toEqual([]);
    });
  });

  it("makes a missing temp root private", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "missing", "root");
      const { stdout } = await outputOf(spawnScript(`console.log("ok");`, root));
      expect(stdout).toBe("ok\n");
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(leftovers(root)).toEqual([]);
    });
  });

  it("still pipes without the option", async () => {
    const child = systemSpawn({ cmd: [process.execPath, "-e", `console.log("piped")`] });
    expect((await outputOf(child)).stdout).toBe("piped\n");
  });
});
