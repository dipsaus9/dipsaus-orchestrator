// The stored run profile against real git (DIPO-72 test plan): the office load step scans `_base`
// and stores the profile; an unchanged fingerprint before `work.run` runs no detection; a script
// change is found by `ensureFreshProfile` and by `office.rescan`, which stores a diff and emits
// `scan.finished`; a second rescan while one runs fails with `scan.running`; an office without a
// resolvable verify gets the refusal naming `verify` in `package.json`; and a port changed in a
// config module a Vite config imports changes the fingerprint and triggers a rescan.
// The slower cases run in CI only, in profiles.ci.test.ts (DIPO-77).

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import {
  applyFixture,
  type FixtureTree,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import { OfficeHandle } from "../../src/db/office";
import { EngineGit } from "../../src/git";
import { createRepoFiles } from "../../src/platform/repo-files";
import { systemSpawn } from "../../src/platform/process";
import { detect, type Probe, type RunProfile } from "../../src/scan/detect";
import { RunProfiles } from "../../src/scan/feature";
import { currentProfile, verifyResolved } from "../../src/scan/store";
import {
  BACKLOG_FIXTURE,
  errorOf,
  type OfficeSetup,
  officeSetup,
  resultOf,
  send,
} from "../office/helpers";
import { entriesAfter, lastSeq } from "../stories/helpers";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const APP = {
  "package.json": json({
    name: "app",
    scripts: { dev: "vite", lint: "oxlint", test: "bun test", verify: "bun run lint && bun test" },
  }),
  "bun.lock": "{}\n",
  ".gitignore": ".env\n",
  ".env.example": "TOKEN=EXAMPLE\n",
};

interface Scanned {
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly profiles: RunProfiles;
  readonly engineGit: EngineGit;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  /** How often detection ran. */
  detections(): number;
  /** How often `office.rescan` indexed the stories again. */
  indexed(): number;
  /** Holds the next story index pass until the returned function is called. */
  holdIndex(): () => void;
}

/** Writes `files` in the main checkout, commits and pushes them. */
async function publish(repo: TempRepoWithRemote, files: FixtureTree, message: string) {
  applyFixture(repo.dir, files);
  await repo.commitAll(message);
  await repo.git("push", "--quiet", "origin", "main");
}

/** The Backlog fixture plus `files`, pushed to a bare `origin`, opened and loaded as an office. */
function withScannedOffice(files: FixtureTree, fn: (o: Scanned) => Promise<void>): Promise<void> {
  return withBareRemote(
    async (repo) => {
      applyFixture(repo.dir, files);
      await repo.commitAll("fixture");
      await repo.git("push", "--quiet", "-u", "origin", "main");
      await repo.git("remote", "set-head", "origin", "main");

      let detections = 0;
      let indexed = 0;
      let hold: Promise<void> | null = null;
      const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
      let setup: OfficeSetup | undefined;
      const profiles = new RunProfiles({
        git: engineGit,
        stories: {
          indexStories: async () => {
            indexed += 1;
            await hold;
          },
        },
        files: (dir) => createRepoFiles(dir, { env: repo.env }),
        detect: (probe: Probe): RunProfile => {
          detections += 1;
          return detect(probe);
        },
        reloadConfig: async (office) =>
          setup?.manager.reloadIfChanged(office, engineGit.forOffice(office)),
        onOfficeChanged: (office) => setup?.changed.push(office),
      });
      const s = await officeSetup(repo.root, { features: [engineGit.feature, profiles.feature] });
      setup = s;
      try {
        const { office: officeId } = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        );
        const access = await s.manager.load(officeId);
        if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);
        await fn({
          repo,
          s,
          profiles,
          engineGit,
          officeId,
          office: access.office,
          detections: () => detections,
          indexed: () => indexed,
          holdIndex: () => {
            const { promise, resolve } = Promise.withResolvers<void>();
            hold = promise;
            return () => {
              hold = null;
              resolve();
            };
          },
        });
      } finally {
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}

interface ScanRow {
  scan_id: number;
  trigger: string;
  result: string;
  profile_id: number | null;
  commit_sha: string | null;
  diff: string | null;
}

function scans(office: OfficeHandle): ScanRow[] {
  return office.all<ScanRow>(
    `select scan_id, trigger, result, profile_id, commit_sha, diff from scans
       where office_id = $office_id order by scan_id`,
  );
}

function scanFinished(office: OfficeHandle, afterSeq = 0) {
  return entriesAfter(office, afterSeq).filter((entry) => entry.type === "scan.finished");
}

describe("run profile at office load", () => {
  it("scans _base at load and stores the profile in the run profile tables", () =>
    withScannedOffice(APP, async ({ repo, office, detections }) => {
      expect(detections()).toBe(1);
      const head = (await repo.git("rev-parse", "HEAD")).trim();
      expect(scans(office)).toEqual([
        expect.objectContaining({
          trigger: "start",
          result: "stored",
          profile_id: 1,
          commit_sha: head,
        }),
      ]);
      const stored = currentProfile(office);
      expect(stored).toMatchObject({ profileId: 1, commit: head, previousProfileId: null });
      expect(stored?.profile.capabilities.verify).toMatchObject({
        status: "resolved",
        value: { commands: [["bun", "run", "verify"]], cwd: "." },
      });
      // Env file presence comes from the main checkout, never its contents.
      expect(stored?.profile.envFiles).toEqual([
        { example: ".env.example", path: ".env", present: false, ignored: true },
      ]);
      expect(
        office.all("select name, command from run_extra_scripts where office_id = $office_id"),
      ).toEqual([]);
      expect(
        office.get<{ n: number }>(
          "select count(*) as n from run_capabilities where office_id = $office_id",
        )?.n,
      ).toBe(8);
      const [finished] = scanFinished(office);
      expect(finished?.delta).toMatchObject({
        trigger: "start",
        level: "conforming",
        scripts: expect.objectContaining({ verify: "bun run verify", test: "bun run test" }),
      });
      expect(finished?.delta["warnings"]).toEqual([
        'No "typecheck" script (recommended).',
        ".env absent, .env.example present.",
      ]);
    }));

  it("runs no detection before work.run when the fingerprint is unchanged", () =>
    withScannedOffice(APP, async ({ profiles, officeId, office, detections }) => {
      const seq = lastSeq(office);
      const outcome = await profiles.ensureFreshProfile(officeId);
      expect(outcome).toMatchObject({ detected: false, diff: [] });
      expect(outcome.profile.profileId).toBe(1);
      expect(detections()).toBe(1);
      expect(scans(office)).toHaveLength(1);
      expect(entriesAfter(office, seq)).toEqual([]);
    }));

  it("detects again before work.run when a script changed on the base, and stores the diff", () =>
    withScannedOffice(APP, async ({ repo, engineGit, profiles, officeId, office, detections }) => {
      await publish(
        repo,
        {
          "package.json": json({
            ...JSON.parse(APP["package.json"]),
            scripts: { test: "bun test" },
          }),
        },
        "drop scripts",
      );
      // `work.run` fetches first (DIPO-48); here the test does.
      await engineGit.forOffice(officeId)?.fetch();
      const outcome = await profiles.ensureFreshProfile(officeId);
      expect(detections()).toBe(2);
      expect(outcome.detected).toBe(true);
      expect(outcome.profile).toMatchObject({ profileId: 2, previousProfileId: 1 });
      expect(outcome.diff).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^~ verify: bun run verify .* -> bun run test /),
          expect.stringMatching(/^~ dev: /),
        ]),
      );
      expect(scans(office).map((row) => [row.trigger, row.result])).toEqual([
        ["start", "stored"],
        ["run", "stored"],
      ]);
    }));
});

describe("office.rescan", () => {
  it("re-indexes the stories, stores the diff of a script change and emits scan.finished", () =>
    withScannedOffice(APP, async ({ repo, s, profiles, officeId, office, indexed }) => {
      const manifest = JSON.parse(APP["package.json"]) as { scripts: Record<string, string> };
      await publish(
        repo,
        {
          "package.json": json({
            ...manifest,
            scripts: { ...manifest.scripts, typecheck: "tsc --noEmit", e2e: "playwright test" },
          }),
        },
        "add typecheck and e2e",
      );
      const seq = lastSeq(office);
      const reply = await send(s, "office.rescan", {}, officeId);
      expect(resultOf<{ scan: string }>(reply)).toEqual({ scan: "started" });
      await profiles.whenIdle(officeId);

      expect(indexed()).toBe(1);
      const rows = scans(office);
      expect(rows.map((row) => [row.trigger, row.result, row.profile_id])).toEqual([
        ["start", "stored", 1],
        ["rescan", "stored", 2],
      ]);
      const diff = JSON.parse(rows[1]?.diff ?? "[]") as string[];
      expect(diff).toEqual([
        "~ typecheck: unresolved -> bun run typecheck [standard, package.json scripts.typecheck]",
        "+ script e2e: playwright test",
        '- deviation missing-typecheck: No "typecheck" script (recommended).',
      ]);

      const [finished] = scanFinished(office, seq);
      expect(finished?.delta).toMatchObject({ trigger: "rescan", level: "conforming", diff });
      const causedBy = office.get<{ caused_by: string | null }>(
        "select caused_by from change_log where office_id = $office_id and seq = $seq",
        { seq: finished?.seq ?? 0 },
      )?.caused_by;
      expect(causedBy).toBe(reply.requestId);
      expect(currentProfile(office)).toMatchObject({ profileId: 2, previousProfileId: 1 });
    }));

  it("puts a .dipo/office.yaml changed on the base in force, not the checkout's (DIPO-303)", () =>
    withScannedOffice(APP, async ({ repo, s, profiles, officeId }) => {
      expect(s.manager.config(officeId)?.scripts).toEqual({});
      // Another clone merges the file to the base; the main checkout never sees it.
      const clone = join(repo.root, "clone");
      await repo.run(["git", "clone", "--quiet", repo.remote, clone], repo.root);
      applyFixture(clone, { ".dipo/office.yaml": "version: 1\nscripts:\n  verify: bun test\n" });
      await repo.run(["git", "add", "--", ".dipo/office.yaml"], clone);
      await repo.run(["git", "commit", "--quiet", "-m", "office.yaml"], clone);
      expect((await repo.run(["git", "push", "--quiet", "origin", "main"], clone)).exitCode).toBe(
        0,
      );

      await send(s, "office.rescan", {}, officeId);
      await profiles.whenIdle(officeId);
      expect(existsSync(join(repo.dir, ".dipo", "office.yaml"))).toBe(false);
      expect(s.manager.config(officeId)?.scripts).toEqual({ verify: "bun test" });
    }));

  it("reports a failed scan as scan.finished with the error and keeps the profile", () =>
    withScannedOffice(APP, async ({ repo, s, profiles, officeId, office }) => {
      await repo.git("remote", "remove", "origin");
      resultOf(await send(s, "office.rescan", {}, officeId));
      await profiles.whenIdle(officeId);
      expect(scans(office).map((row) => [row.trigger, row.result])).toEqual([
        ["start", "stored"],
        ["rescan", "failed"],
      ]);
      const delta = scanFinished(office).at(-1)?.delta;
      expect(delta).toMatchObject({ trigger: "rescan", scripts: {} });
      expect(delta?.["error"]).toContain("base");
      expect(delta?.["warnings"]).toEqual([expect.stringContaining("Fetching origin failed")]);
      expect(currentProfile(office)?.profileId).toBe(1);
    }));

  it("fails with scan.running while a rescan runs", () =>
    withScannedOffice(APP, async ({ s, profiles, officeId, holdIndex }) => {
      const release = holdIndex();
      resultOf(await send(s, "office.rescan", {}, officeId));
      expect(errorOf(await send(s, "office.rescan", {}, officeId))).toBe("scan.running");
      release();
      await profiles.whenIdle(officeId);
      resultOf(await send(s, "office.rescan", {}, officeId));
      await profiles.whenIdle(officeId);
    }));
});

describe("verifyResolved", () => {
  it("refuses an office without a resolvable verify, naming verify in package.json", () =>
    withScannedOffice(
      {
        "package.json": json({ name: "site", scripts: { dev: "next dev" } }),
        "package-lock.json": "{}\n",
      },
      async ({ profiles, office }) => {
        const refusal = verifyResolved(office);
        expect(refusal).toContain('add a "verify" script to package.json');
        expect(profiles.verifyResolved(office)).toBe(refusal);
        expect(currentProfile(office)?.profile.conformance.level).toBe("partial");
      },
    ));

  it("returns null when verify resolved", () =>
    withScannedOffice(APP, async ({ office }) => {
      expect(verifyResolved(office)).toBeNull();
    }));
});
