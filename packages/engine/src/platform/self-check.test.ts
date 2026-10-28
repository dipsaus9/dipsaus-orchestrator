import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

import { COMPILED_WORKER_PATH, platformSelfChecks, selfCheckWorkerUrl } from "./self-check";

// Temp files only under DIPO_TMP (0017), falling back to /tmp.
const TMP_ROOT = process.env["DIPO_TMP"] || "/tmp";

describe("platform self-checks", () => {
  // The smoke jobs run every probe in the compiled binary; here they run from source.
  const fromSource = platformSelfChecks(TMP_ROOT);

  it("covers every runtime feature named by DIPO-17", () => {
    expect(platformSelfChecks(TMP_ROOT).map((check) => check.name)).toEqual([
      "sqlite-wal",
      "worker",
      "unix-websocket",
      "yaml",
    ]);
  });

  for (const check of fromSource) {
    it(`passes ${check.name} from source`, async () => {
      await check.run();
    });
  }
});

describe("selfCheckWorkerUrl", () => {
  it("points next to this module when running from source", () => {
    const url = selfCheckWorkerUrl();
    expect(existsSync(new URL(url).pathname)).toBe(true);
  });

  it("points at the worker entrypoint inside a compiled binary", () => {
    expect(selfCheckWorkerUrl("file:///$bunfs/root/dipo")).toBe(COMPILED_WORKER_PATH);
  });

  it("matches the worker's path below packages/, the build root of scripts/build.ts", () => {
    const packages = join(import.meta.dir, "..", "..", "..");
    const worker = join(import.meta.dir, "self-check-worker.ts");
    expect(COMPILED_WORKER_PATH).toBe(`/$bunfs/root/${relative(packages, worker)}`);
  });
});
