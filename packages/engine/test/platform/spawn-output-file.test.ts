// `systemSpawn` with `output: { to: "file" }` (DIPO-333): on real processes, a child's stdout and
// stderr go to regular files (mode 0600) in a private folder (mode 0700) under the temp root, never
// to a pipe, and reach the caller whole once the child has exited, also over 300 KB and when the
// child writes slowly. The folder is removed after the read, also when the child fails, when
// nobody reads, and when the child cannot start. dipo reads through its own descriptors, so a child
// that swaps its output paths for a FIFO or a link, or its folder for a link, can neither hang nor
// redirect the read; an output over the size cap fails the read; a temp root of another user is
// refused unless it is a shared folder with the sticky bit.

import { describe, expect, it } from "bun:test";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  checkTempRoot,
  OUTPUT_DIR_PREFIX,
  OUTPUT_MAX_BYTES,
} from "../../src/platform/output-files";
import { systemSpawn } from "../../src/platform/process";

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

  it("reads its own descriptors when the child swaps its output files for a FIFO and a link", async () => {
    await withTempDir(async (root) => {
      const secret = join(root, "secret.txt");
      writeFileSync(secret, "do not read me\n");
      const script = [
        `const fs = require("node:fs");`,
        `const root = ${JSON.stringify(root)};`,
        `const dir = root + "/" + fs.readdirSync(root).find((n) => n.startsWith(${JSON.stringify(OUTPUT_DIR_PREFIX)}));`,
        `console.log("before");`,
        `fs.unlinkSync(dir + "/stdout");`,
        `if (Bun.spawnSync(["mkfifo", dir + "/stdout"]).exitCode !== 0) throw new Error("mkfifo");`,
        `fs.unlinkSync(dir + "/stderr");`,
        `fs.symlinkSync(${JSON.stringify(secret)}, dir + "/stderr");`,
        `console.log("after");`,
      ].join("\n");
      const { stdout, stderr, exit } = await outputOf(spawnScript(script, root));
      expect(exit.code).toBe(0);
      expect(stdout).toBe("before\nafter\n");
      expect(stderr).toBe("");
      expect(readFileSync(secret, "utf8")).toBe("do not read me\n");
      expect(leftovers(root)).toEqual([]);
    });
  });

  it("removes only the link when the child swaps its folder for a link", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "root");
      const decoy = join(dir, "decoy");
      mkdirSync(decoy);
      writeFileSync(join(decoy, "keep"), "kept\n");
      const script = [
        `const fs = require("node:fs");`,
        `const root = ${JSON.stringify(root)};`,
        `const out = root + "/" + fs.readdirSync(root).find((n) => n.startsWith(${JSON.stringify(OUTPUT_DIR_PREFIX)}));`,
        `console.log("written");`,
        `fs.rmSync(out, { recursive: true });`,
        `fs.symlinkSync(${JSON.stringify(decoy)}, out);`,
      ].join("\n");
      const { stdout } = await outputOf(spawnScript(script, root));
      expect(stdout).toBe("written\n");
      expect(readFileSync(join(decoy, "keep"), "utf8")).toBe("kept\n");
      expect(leftovers(root)).toEqual([]);
    });
  });

  it("fails the read of an output over the size cap, and removes the folder", async () => {
    await withTempDir(async (root) => {
      const script = `require("node:fs").ftruncateSync(1, ${OUTPUT_MAX_BYTES + 1});`;
      const child = spawnScript(script, root);
      const read = new Response(child.stdout).text();
      await expect(read).rejects.toThrow(/stdout holds \d+ bytes, more than dipo reads/);
      await expect(new Response(child.stderr).text()).rejects.toThrow();
      expect(leftovers(root)).toEqual([]);
    });
  });

  it("refuses a temp root of another user unless it is shared with the sticky bit", async () => {
    await withTempDir(async (dir) => {
      const other = (process.getuid?.() ?? 0) + 1;
      const shared = join(dir, "shared");
      mkdirSync(shared);
      chmodSync(shared, 0o1777);
      expect(() => checkTempRoot(shared, other)).not.toThrow();
      const open = join(dir, "open");
      mkdirSync(open);
      chmodSync(open, 0o777);
      expect(() => checkTempRoot(open, other)).toThrow(/belongs to another user/);
      const own = join(dir, "own");
      mkdirSync(own, { mode: 0o700 });
      expect(() => checkTempRoot(own)).not.toThrow();
    });
  });

  it("refuses a temp root that is not a folder, and makes nothing", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "file");
      writeFileSync(root, "");
      expect(() => spawnScript(`console.log("no")`, root)).toThrow();
      expect(readdirSync(dir)).toEqual(["file"]);
    });
  });

  it("still pipes without the option", async () => {
    const child = systemSpawn({ cmd: [process.execPath, "-e", `console.log("piped")`] });
    expect((await outputOf(child)).stdout).toBe("piped\n");
  });
});
