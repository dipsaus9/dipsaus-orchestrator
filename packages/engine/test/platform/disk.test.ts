// The free-space probe (DIPO-38): `statfs` on a path, or on its nearest existing ancestor.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { formatGigabytes, systemDiskProbe } from "../../src/platform/disk";

describe("the disk probe", () => {
  it("reports free bytes for a path that does not exist yet", () =>
    withTempDir(async (dir) => {
      const existing = await systemDiskProbe.freeBytes(dir);
      const missing = await systemDiskProbe.freeBytes(join(dir, "not", "yet", "there"));
      expect(existing).toBeGreaterThan(0);
      expect(missing).toBeGreaterThan(0);
    }));

  it("formats bytes as decimal gigabytes", () => {
    expect(formatGigabytes(1_000_000_000)).toBe("1.0 GB");
    expect(formatGigabytes(2_000_000_000)).toBe("2.0 GB");
    expect(formatGigabytes(1_549_000_000)).toBe("1.5 GB");
  });
});
