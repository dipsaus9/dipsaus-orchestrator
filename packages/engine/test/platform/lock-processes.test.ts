// The daemon lock (0005, DIPO-387) across real processes: SQLite's `fcntl` locks belong to a
// process, so the starters here are processes of their own (`fixtures/lock-starter.ts`). Two
// starters at the same moment leave exactly one holder, again and again, and a holder killed with
// SIGKILL frees the lock at once.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

const STARTER = join(import.meta.dir, "fixtures", "lock-starter.ts");
const ROUNDS = 10;

interface Starter {
  readonly process: Bun.Subprocess<"pipe", "pipe", "ignore">;
  /** The next line the starter prints. */
  line(): Promise<string>;
}

async function spawnStarter(dir: string): Promise<Starter> {
  const child = Bun.spawn({
    cmd: [process.execPath, STARTER, dir],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const starter: Starter = {
    process: child,
    async line() {
      while (!buffered.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`starter exited with ${await child.exited} before its line`);
        buffered += decoder.decode(value, { stream: true });
      }
      const end = buffered.indexOf("\n");
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      return line;
    },
  };
  expect(await starter.line()).toBe("ready");
  return starter;
}

/** Lets the starter try, and returns its outcome's kind. */
async function go(starter: Starter): Promise<string> {
  starter.process.stdin.write("go\n");
  await starter.process.stdin.flush();
  return starter.line();
}

async function killAll(starters: readonly Starter[]): Promise<void> {
  for (const starter of starters) starter.process.kill("SIGKILL");
  await Promise.all(starters.map((starter) => starter.process.exited));
}

describe("the daemon lock across processes", () => {
  it(`leaves exactly one holder when two starters try at the same moment, ${ROUNDS} times`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await withTempDir(async (dir) => {
        // Both are loaded and waiting before either tries.
        const starters = await Promise.all([spawnStarter(dir), spawnStarter(dir)]);
        try {
          const kinds = await Promise.all(starters.map(go));
          expect(kinds.toSorted()).toEqual(["acquired", "held"]);
        } finally {
          await killAll(starters);
        }
      });
    }
  }, 30_000);

  it("frees the lock at once when its holder is killed with SIGKILL", async () => {
    await withTempDir(async (dir) => {
      const holder = await spawnStarter(dir);
      const starters = [holder];
      try {
        expect(await go(holder)).toBe("acquired");
        const refused = await spawnStarter(dir);
        starters.push(refused);
        expect(await go(refused)).toBe("held");
        holder.process.kill("SIGKILL");
        await holder.process.exited;
        const next = await spawnStarter(dir);
        starters.push(next);
        expect(await go(next)).toBe("acquired");
      } finally {
        await killAll(starters);
      }
    });
  }, 10_000);
});
