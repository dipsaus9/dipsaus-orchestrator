// CI only (0017 section 1): the slower stored run profile cases against real git (DIPO-72 test
// plan), kept out of the local suite for its time budget (DIPO-77): a rescan with nothing changed
// reports an empty diff, a rescan still fails with `scan.running` after the office loads again with
// a new handle, and a port changed in a config module a Vite config imports changes the fingerprint
// and triggers a rescan.

import { describe, expect, it } from "bun:test";

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
import { RunProfiles, SCAN_STEP } from "../../src/scan/feature";
import { currentProfile } from "../../src/scan/store";
import {
  BACKLOG_FIXTURE,
  errorOf,
  type OfficeSetup,
  officeSetup,
  resultOf,
  send,
} from "../office/helpers";
import { entriesAfter } from "../stories/helpers";

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

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("office.rescan", () => {
    it("runs detection when nothing changed and reports an empty diff", () =>
      withScannedOffice(APP, async ({ s, profiles, officeId, office, detections }) => {
        resultOf(await send(s, "office.rescan", {}, officeId));
        await profiles.whenIdle(officeId);
        expect(detections()).toBe(2);
        expect(scans(office).map((row) => [row.trigger, row.result, row.profile_id])).toEqual([
          ["start", "stored", 1],
          ["rescan", "unchanged", 1],
        ]);
        expect(scanFinished(office).at(-1)?.delta).toMatchObject({ trigger: "rescan", diff: [] });
      }));

    it("still fails with scan.running after the office loads again with a new handle", () =>
      withScannedOffice(APP, async ({ repo, s, profiles, officeId, holdIndex }) => {
        const release = holdIndex();
        resultOf(await send(s, "office.rescan", {}, officeId));
        // The office loads again (a new handle) while the rescan runs: the load step tracks it anew.
        const step = s.registry.loadSteps().find((entry) => entry.name === SCAN_STEP);
        if (!step) throw new Error(`load step ${SCAN_STEP} is not registered`);
        const reload = step.run({
          officeId,
          office: new OfficeHandle(s.state.connection, officeId),
          path: repo.dir,
          commonDir: `${repo.dir}/.git`,
          config: undefined,
          clock: s.clock,
          ids: s.ids,
        });
        expect(errorOf(await send(s, "office.rescan", {}, officeId))).toBe("scan.running");
        release();
        await reload;
        await profiles.whenIdle(officeId);
        resultOf(await send(s, "office.rescan", {}, officeId));
        await profiles.whenIdle(officeId);
      }));
  });

  describe("a config module a dev server config imports (DIPO-349)", () => {
    const CONFIG_MODULE = "packages/config/vite/index.ts";
    const workspace = (port: number): Record<string, string> => ({
      "package.json": json({
        name: "cc",
        packageManager: "pnpm@11.27.0",
        scripts: { dev: "pnpm -r --parallel run dev", test: "pnpm -r run test" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
      "apps/host/package.json": json({ name: "@cc/host", scripts: { dev: "vite" } }),
      "apps/host/vite.config.ts":
        'import { devPorts } from "@cc/config/vite";\nexport default { server: { port: devPorts.host } };\n',
      "packages/config/package.json": json({
        name: "@cc/config",
        exports: { "./*": "./*/index.ts" },
      }),
      [CONFIG_MODULE]: `export const devPorts = { host: ${port} } as const;\n`,
    });

    it("leaves the fingerprint as it is when the port changes in the module: dev ports are not detected", () =>
      withScannedOffice(
        workspace(5174),
        async ({ repo, engineGit, profiles, officeId, office, detections }) => {
          const before = currentProfile(office);

          await publish(
            repo,
            { [CONFIG_MODULE]: workspace(6100)[CONFIG_MODULE] ?? "" },
            "move the port",
          );
          await engineGit.forOffice(officeId)?.fetch();
          const outcome = await profiles.ensureFreshProfile(officeId);
          expect(detections()).toBe(1);
          expect(outcome.detected).toBe(false);
          expect(outcome.profile.profile.fingerprint).toBe(before?.profile.fingerprint ?? "");
        },
      ));
  });
}
