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
        config: {
          version: 4,
          daemon: { autostart: true },
          usage: { alerts: { level: 0.8 } },
          notify: { desk: true },
        },
        fromFile: false,
        warnings: [],
      });
    }));

  it("reads a valid file, dropping a retired key with a warning", () =>
    withTempDir(async (state) => {
      writeFileSync(
        join(state, "config.yaml"),
        "version: 1\ndaemon:\n  autostart: false\n  autoRestartOnUpgrade: true\n",
      );
      const path = softwareConfigPath(state);
      expect(await loadSoftwareConfig(state)).toEqual({
        ok: true,
        config: {
          version: 4,
          daemon: { autostart: false },
          usage: { alerts: { level: 0.8 } },
          notify: { desk: true },
        },
        fromFile: true,
        warnings: [
          `${path}: daemon.autoRestartOnUpgrade is no longer read and was ignored, because the daemon never restarts itself; run \`dipo daemon restart\` after an upgrade (0005). Delete it.`,
        ],
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
      writeFileSync(path, "version: 5\n");
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
