// The daemon and a client must accept and refuse the same `<state>/config.yaml` (0006 amendment of
// 2026-10-12). `client` may not import `engine` (0004), so each reads the file on its own path;
// this test sits outside both packages and runs the two readers on the same files. It imports the
// source files by path because the repository root has no package links.

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { readSoftwareConfig } from "../../packages/client/src/node/config";
import { loadSoftwareConfig } from "../../packages/engine/src/config/software";
import { withTempDir } from "../../packages/testkit/src/temp";

const FILES: Record<string, string | undefined> = {
  absent: undefined,
  "only a version": "version: 1\n",
  "every key": "version: 1\ndaemon:\n  autostart: false\n  autoRestartOnUpgrade: true\n",
  "flow style": "version: 1\ndaemon: { autostart: false }\n",
  "a typo": "version: 1\ndaemon:\n  autostrat: true\n",
  "a wrong type": "version: 1\ndaemon:\n  autostart: yes\n",
  "no version": "daemon:\n  autostart: true\n",
  "a string version": 'version: "1"\n',
  "two documents": "version: 1\n---\nversion: 1\n",
  "a newer version": "version: 2\n",
  "invalid YAML": "daemon: {\n",
  "a list": "- version: 1\n",
  empty: "",
};

describe("software configuration in the daemon and in client/node", () => {
  for (const [name, text] of Object.entries(FILES)) {
    it(`gives the same result for ${name}`, () =>
      withTempDir(async (state) => {
        if (text !== undefined) writeFileSync(join(state, "config.yaml"), text);
        expect(readSoftwareConfig(state)).toEqual(await loadSoftwareConfig(state));
      }));
  }
});
