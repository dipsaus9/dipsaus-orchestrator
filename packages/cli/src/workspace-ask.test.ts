// The real prompt path (DIPO-414): input that ends before an answer gives no answer and does not throw.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { withTempRepo } from "@dipsaus-orchestrator/testkit";

const WORKSPACE = join(import.meta.dir, "workspace.ts");

describe("the system workspace's ask", () => {
  it("returns an empty answer when input ends before the answer", async () => {
    await withTempRepo(async (repo) => {
      const script = join(repo.dir, "ask.ts");
      await Bun.write(
        script,
        `import { systemWorkspace } from ${JSON.stringify(WORKSPACE)};
const answer = await systemWorkspace().ask("Type DIPO-7: ");
console.log(JSON.stringify(answer));`,
      );
      // An empty stdin: the input ends before the question is answered.
      const child = Bun.spawn(["bun", script], {
        cwd: repo.dir,
        stdin: new Blob([]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe('""');
      expect(stderr).not.toContain("AbortError");
    });
  });
});
