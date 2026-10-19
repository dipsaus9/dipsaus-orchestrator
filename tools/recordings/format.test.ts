import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeTempDir, removeTempDir } from "../../packages/testkit/src/index";
import { META_FILE, readRecording, REPO_ROOT, serializeMeta } from "./format";

const OXFMT = join(REPO_ROOT, "node_modules/.bin/oxfmt");
const OXFMT_CONFIG = join(REPO_ROOT, ".oxfmtrc.json");

describe("serializeMeta", () => {
  it("reproduces the committed model-switch meta.json, so derive leaves it unchanged (DIPO-209)", () => {
    const recording = readRecording("model-switch");
    expect(serializeMeta(recording.meta)).toBe(recording.metaText);
  });

  it("writes meta.json in the formatter's layout (DIPO-209)", () => {
    const recording = readRecording("model-switch");
    const dir = makeTempDir();
    try {
      const file = join(dir, META_FILE);
      writeFileSync(file, serializeMeta(recording.meta));
      const check = Bun.spawnSync([OXFMT, "--check", "-c", OXFMT_CONFIG, file], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(check.exitCode).toBe(0);
    } finally {
      removeTempDir(dir);
    }
  });
});
