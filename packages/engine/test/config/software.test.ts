// `<state>/config.yaml` as the daemon reads it (DIPO-69): through `platform/yaml.ts`, validated by
// the contract's schema. The full error matrix is the contract's unit test.

import { describe, expect, it } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { loadSoftwareConfig, softwareConfigPath } from "../../src/config";

describe("loadSoftwareConfig", () => {
  it("gives the defaults when the file is absent", () =>
    withTempDir(async (state) => {
      expect(await loadSoftwareConfig(state)).toEqual({
        ok: true,
        config: { version: 1, daemon: { autostart: true, autoRestartOnUpgrade: false } },
        fromFile: false,
      });
    }));

  it("reads a valid file", () =>
    withTempDir(async (state) => {
      writeFileSync(
        join(state, "config.yaml"),
        "version: 1\ndaemon:\n  autoRestartOnUpgrade: true\n",
      );
      expect(await loadSoftwareConfig(state)).toEqual({
        ok: true,
        config: { version: 1, daemon: { autostart: true, autoRestartOnUpgrade: true } },
        fromFile: true,
      });
    }));

  it("names the full path, the key path and the expected type", () =>
    withTempDir(async (state) => {
      const path = softwareConfigPath(state);
      expect(path).toBe(join(state, "config.yaml"));
      writeFileSync(path, "version: 1\ndaemon:\n  autostart: 1\n");
      expect(await loadSoftwareConfig(state)).toEqual({
        ok: false,
        errors: [
          {
            file: path,
            path: "daemon.autostart",
            expected: "boolean",
            message: `${path}: daemon.autostart: expected boolean, got integer`,
          },
        ],
      });
    }));

  it("refuses two documents and a newer version", () =>
    withTempDir(async (state) => {
      const path = softwareConfigPath(state);
      writeFileSync(path, "version: 1\n---\nversion: 1\n");
      expect(await loadSoftwareConfig(state)).toMatchObject({
        ok: false,
        errors: [{ file: path, path: "(top level)", expected: "exactly one YAML document" }],
      });
      writeFileSync(path, "version: 2\n");
      const result = await loadSoftwareConfig(state);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.errors[0]?.message).toContain("upgrade dipo");
    }));

  it.skipIf(process.getuid?.() === 0)("returns an unreadable file as an error", () =>
    withTempDir(async (state) => {
      const path = softwareConfigPath(state);
      writeFileSync(path, "version: 1\n");
      chmodSync(path, 0o000);
      expect(await loadSoftwareConfig(state)).toMatchObject({
        ok: false,
        errors: [{ file: path, path: "(top level)", expected: "readable file" }],
      });
    }),
  );
});
