// `office.setPrivacy` (DIPO-136; 0007 section 8): writes `.dipo/office.local.yaml`, reloads the
// configuration and answers with the new hash; a refused change leaves the file unchanged.

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { ConfigError, OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import { OFFICE_CONFIG_VERSION } from "../../src/config";
import { summarySettings } from "../../src/views";
import { BACKLOG_FIXTURE, officeSetup, resultOf, send } from "./helpers";

interface SetResult {
  readonly office: OfficeId;
  readonly key: string;
  readonly value: boolean;
  readonly valid: boolean;
  readonly errors: ConfigError[];
  readonly configHash?: string;
}

describe("office.setPrivacy", () => {
  it("writes the file, reloads the configuration and replies with the new hash", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root);
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;
        const file = join(repo.dir, ".dipo", "office.local.yaml");

        const first = resultOf<SetResult>(
          await send(s, "office.setPrivacy", { office, key: "storeCommandBodies", value: false }),
        );
        expect(first.valid).toBe(true);
        expect(first.configHash).toBe(s.manager.configHash(office));
        expect(s.manager.config(office)?.privacy.storeCommandBodies).toBe(false);
        const text = readFileSync(file, "utf8");
        expect(text).toContain("comments are not kept");
        expect(text).toContain(`version: ${OFFICE_CONFIG_VERSION}`);
        expect(s.manager.localOverrideKeys(office)).toEqual(["privacy.storeCommandBodies"]);
        const settings = summarySettings(
          s.manager.config(office),
          s.manager.localOverrideKeys(office),
        );
        expect(settings.privacy).toEqual([
          { key: "privacy.storePrompts", value: true, source: "default" },
          { key: "privacy.storeCommandBodies", value: false, source: "office.local.yaml" },
          { key: "privacy.keepRawEvents", value: false, source: "default" },
        ]);

        const reply = await send(s, "office.setPrivacy", {
          office,
          key: "storeCommandBodies",
          value: true,
        });
        expect(reply.ok && reply.changed).toBe(true);
        const second = resultOf<SetResult>(reply);
        expect(second.configHash).not.toBe(first.configHash);
        expect(s.manager.config(office)?.privacy.storeCommandBodies).toBe(true);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("keeps the other keys of an existing file", async () => {
    await withTempRepo(
      async (repo) => {
        mkdirSync(join(repo.dir, ".dipo"), { recursive: true });
        const file = join(repo.dir, ".dipo", "office.local.yaml");
        writeFileSync(file, "# note\nversion: 4\nretention:\n  shortDays: 3\n");
        const s = await officeSetup(repo.root);
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;
        resultOf(await send(s, "office.setPrivacy", { office, key: "keepRawEvents", value: true }));
        const text = readFileSync(file, "utf8");
        expect(text).toContain("version: 4");
        expect(text).toContain("shortDays: 3");
        expect(text).not.toContain("# note");
        expect(s.manager.config(office)?.retention.shortDays).toBe(3);
        expect(s.manager.config(office)?.privacy.keepRawEvents).toBe(true);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("refuses an unknown key, a non-boolean value and an invalid file, leaving the file alone", async () => {
    await withTempRepo(
      async (repo) => {
        mkdirSync(join(repo.dir, ".dipo"), { recursive: true });
        const file = join(repo.dir, ".dipo", "office.local.yaml");
        const s = await officeSetup(repo.root);
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;

        const unknown = await send(s, "office.setPrivacy", { office, key: "nope", value: true });
        expect(!unknown.ok && unknown.error.message).toContain("privacy.nope");
        expect(!unknown.ok && unknown.error.message).toContain(".dipo/office.local.yaml");
        const bad = await send(s, "office.setPrivacy", {
          office,
          key: "storePrompts",
          value: "yes",
        });
        expect(!bad.ok && bad.error.message).toContain("privacy.storePrompts");
        expect(existsSync(file)).toBe(false);

        const invalid = "version: 4\ntimeouts:\n  workerStallMinutes: soon\n";
        writeFileSync(file, invalid);
        const refused = await send(s, "office.setPrivacy", {
          office,
          key: "storePrompts",
          value: false,
        });
        expect(!refused.ok && refused.error.message).toContain("timeouts.workerStallMinutes");
        expect(!refused.ok && refused.error.message).toContain(".dipo/office.local.yaml");
        expect(readFileSync(file, "utf8")).toBe(invalid);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });

  it("refuses a write that fails, naming the file and leaving no temp file", async () => {
    await withTempRepo(
      async (repo) => {
        const dipo = join(repo.dir, ".dipo");
        mkdirSync(dipo, { recursive: true });
        const s = await officeSetup(repo.root);
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;
        chmodSync(dipo, 0o555);
        try {
          const reply = await send(s, "office.setPrivacy", {
            office,
            key: "storePrompts",
            value: false,
          });
          expect(!reply.ok && reply.error.code).toBe("office.refused");
          expect(!reply.ok && reply.error.message).toContain(".dipo/office.local.yaml");
        } finally {
          chmodSync(dipo, 0o755);
        }
        expect(readdirSync(dipo).filter((name) => name.endsWith(".tmp"))).toEqual([]);
        expect(existsSync(join(dipo, "office.local.yaml"))).toBe(false);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
