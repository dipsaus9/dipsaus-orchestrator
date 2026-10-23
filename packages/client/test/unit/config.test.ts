// `<state>/config.yaml` as a client reads it before an autostart (DIPO-69): parsed in
// `client/node`, validated by the contract's schema. The full error matrix is the contract's unit
// test; the daemon side is compared with this one in test/software-config/.

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { readSoftwareConfig, softwareConfigPath } from "../../src/node/index";

describe("readSoftwareConfig", () => {
  it("gives the defaults when the file is absent", () =>
    withTempDir((state) => {
      expect(readSoftwareConfig(state)).toEqual({
        ok: true,
        config: {
          version: 2,
          daemon: { autostart: true, autoRestartOnUpgrade: false },
          usage: { alerts: { level: 0.8 } },
        },
        fromFile: false,
      });
    }));

  it("reads daemon.autostart from a valid file", () =>
    withTempDir((state) => {
      writeFileSync(join(state, "config.yaml"), "version: 1\ndaemon:\n  autostart: false\n");
      expect(readSoftwareConfig(state)).toMatchObject({
        ok: true,
        config: { daemon: { autostart: false, autoRestartOnUpgrade: false } },
        fromFile: true,
      });
    }));

  it("names the full path, the key path and the expected type", () =>
    withTempDir((state) => {
      const path = softwareConfigPath(state);
      writeFileSync(path, "version: 1\ndeamon:\n  autostart: false\n");
      expect(readSoftwareConfig(state)).toEqual({
        ok: false,
        errors: [
          {
            file: path,
            path: "deamon",
            expected: "one of the keys version, daemon",
            message: `${path}: deamon: unknown key; expected one of the keys version, daemon`,
          },
        ],
      });
    }));

  it("refuses two documents, a missing version and a newer version", () =>
    withTempDir((state) => {
      const path = softwareConfigPath(state);
      writeFileSync(path, "version: 1\n---\n");
      expect(readSoftwareConfig(state)).toMatchObject({
        ok: false,
        errors: [{ path: "(top level)", expected: "exactly one YAML document" }],
      });
      writeFileSync(path, "daemon: {}\n");
      expect(readSoftwareConfig(state)).toMatchObject({
        ok: false,
        errors: [{ path: "version", expected: "integer" }],
      });
      writeFileSync(path, "version: 3\n");
      const result = readSoftwareConfig(state);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.errors[0]?.message).toContain("upgrade dipo");
    }));
});
