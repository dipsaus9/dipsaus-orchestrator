// The committed office configuration (DIPO-410; 0017): load and `office.reloadConfig` read
// `.dipo/office.yaml` from the base commit, the checkout's `office.local.yaml` stays a checkout
// read, a repository with no base ref reads the checkout until a fetch creates it, and a committed
// file that names another base is read once more at that base.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { cursorAt } from "../../src/changelog/log";
import { replay } from "../../src/changelog/replay";
import type { FeatureModule } from "../../src/commands/registry";
import { loadOfficeConfig } from "../../src/config";
import { EngineGit } from "../../src/git";
import { systemSpawn } from "../../src/platform/process";
import { BACKLOG_FIXTURE, type OfficeSetup, officeSetup, resultOf, send } from "./helpers";

const OFFICE_YAML = join(".dipo", "office.yaml");
const OFFICE_LOCAL_YAML = join(".dipo", "office.local.yaml");
const OLD = "version: 16\nreview:\n  maxRounds: 3\n";
const CLOSED = "version: 16\nreview:\n  maxRounds: 2\n";
const OPEN = "version: 16\nreview:\n  maxRounds: 4\n";
const INVALID = "version: 16\ntimeouts:\n  workerStallMinutes: soon\n";
const NAMES_DEVELOP = "version: 16\nbase: develop\nreview:\n  maxRounds: 7\n";
// On `develop` the file names its own base, as the base the poll reads must keep naming it.
const DEVELOP_CLOSED = "version: 16\nbase: develop\nreview:\n  maxRounds: 2\n";
const DEVELOP_OPEN = "version: 16\nbase: develop\nreview:\n  maxRounds: 4\n";
const NAMES_STAGING = "version: 16\nbase: staging\nreview:\n  maxRounds: 7\n";

function writeOffice(dir: string, text: string): void {
  mkdirSync(join(dir, ".dipo"), { recursive: true });
  writeFileSync(join(dir, OFFICE_YAML), text);
}

/** Writes `.dipo/office.yaml` in the checkout and commits it with the fixture. */
function commitOffice(repo: TempRepoWithRemote, text: string, message: string): Promise<string> {
  writeOffice(repo.dir, text);
  return repo.commitAll(message);
}

async function pushMain(repo: TempRepoWithRemote): Promise<void> {
  await repo.git("push", "--quiet", "-u", "origin", "main");
  await repo.git("remote", "set-head", "origin", "main");
}

async function openAndLoad(s: OfficeSetup, path: string): Promise<OfficeId> {
  const office = resultOf<{ office: OfficeId }>(await send(s, "office.open", { path })).office;
  resultOf(await send(s, "fixture.ping", {}, office));
  return office;
}

/** The configuration hash of `text` as the base file, which load and reload must record. */
async function hashOf(dir: string, text: string): Promise<string> {
  const result = await loadOfficeConfig(dir, { office: { text } });
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("; "));
  return result.configHash;
}

function noticeCodes(s: OfficeSetup, office: OfficeId): string[] {
  const result = replay(s.state.office(office), cursorAt(office, 0));
  if (!result.ok) throw new Error(result.error.message);
  return result.entries
    .filter((entry) => entry.type === "engine.notice")
    .map((entry) => (entry.delta as { code: string }).code);
}

/** Counts the config-reload listeners that run: one per configuration that changed in force. */
function countReloads(reloads: OfficeId[]): FeatureModule {
  return {
    name: "fixture/reloads",
    register(registry) {
      registry.registerConfigReload("fixture.count", (ctx) => void reloads.push(ctx.officeId));
    },
  };
}

describe("office.yaml is read from the base (DIPO-410)", () => {
  it("loads and reloads the base's file while the checkout sits on an older commit", () =>
    withBareRemote(
      async (repo) => {
        const older = await commitOffice(repo, OLD, "older office.yaml");
        await commitOffice(repo, CLOSED, "closed office.yaml");
        await pushMain(repo);
        await repo.git("reset", "--quiet", "--hard", older);
        expect(readFileSync(join(repo.dir, OFFICE_YAML), "utf8")).toBe(OLD);

        const s = await officeSetup(repo.root);
        const office = await openAndLoad(s, repo.dir);
        expect(s.manager.config(office)?.review.maxRounds).toBe(2);
        expect(s.manager.configHash(office)).toBe(await hashOf(repo.dir, CLOSED));
        expect(noticeCodes(s, office)).not.toContain("config.fromCheckout");

        const reply = resultOf<{ valid: boolean; configHash?: string }>(
          await send(s, "office.reloadConfig", { office }),
        );
        expect(reply.valid).toBe(true);
        expect(reply.configHash).toBe(await hashOf(repo.dir, CLOSED));
        expect(s.manager.config(office)?.review.maxRounds).toBe(2);
      },
      { fixture: BACKLOG_FIXTURE },
    ));

  it("reads office.local.yaml from the checkout, and the rest from the base", () =>
    withBareRemote(
      async (repo) => {
        await commitOffice(repo, CLOSED, "closed office.yaml");
        await pushMain(repo);
        writeFileSync(
          join(repo.dir, OFFICE_LOCAL_YAML),
          "version: 16\ntimeouts:\n  workerStallMinutes: 33\n",
        );

        const s = await officeSetup(repo.root);
        const office = await openAndLoad(s, repo.dir);
        expect(s.manager.config(office)?.timeouts.workerStallMinutes).toBe(33);
        expect(s.manager.config(office)?.review.maxRounds).toBe(2);
        expect(s.manager.localOverrideKeys(office)).toEqual(["timeouts.workerStallMinutes"]);
      },
      { fixture: BACKLOG_FIXTURE },
    ));

  it("refuses a base file that is invalid at load, with config.invalid, until a valid one", () =>
    withBareRemote(
      async (repo) => {
        await commitOffice(repo, INVALID, "invalid office.yaml");
        await pushMain(repo);

        const s = await officeSetup(repo.root);
        const office = await openAndLoad(s, repo.dir);
        expect(s.manager.configBlocksRuns(office).map((error) => error.path)).toEqual([
          "timeouts.workerStallMinutes",
        ]);
        expect(noticeCodes(s, office)).toContain("config.invalid");

        await commitOffice(repo, CLOSED, "fixed office.yaml");
        await repo.git("push", "--quiet", "origin", "main");
        const reply = resultOf<{ valid: boolean }>(
          await send(s, "office.reloadConfig", { office }),
        );
        expect(reply.valid).toBe(true);
        expect(s.manager.configBlocksRuns(office)).toEqual([]);
        expect(s.manager.config(office)?.review.maxRounds).toBe(2);
      },
      { fixture: BACKLOG_FIXTURE },
    ));

  it("keeps the configuration in force when a reload finds the base invalid", () =>
    withBareRemote(
      async (repo) => {
        await commitOffice(repo, CLOSED, "closed office.yaml");
        await pushMain(repo);

        const s = await officeSetup(repo.root);
        const office = await openAndLoad(s, repo.dir);
        const hash = s.manager.configHash(office);

        await commitOffice(repo, INVALID, "invalid office.yaml");
        await repo.git("push", "--quiet", "origin", "main");
        const reply = resultOf<{ valid: boolean }>(
          await send(s, "office.reloadConfig", { office }),
        );
        expect(reply.valid).toBe(false);
        expect(s.manager.configBlocksRuns(office)).not.toEqual([]);
        expect(s.manager.configHash(office)).toBe(hash);
        expect(s.manager.config(office)?.review.maxRounds).toBe(2);
      },
      { fixture: BACKLOG_FIXTURE },
    ));

  it("reads the checkout while no base ref exists, and the base once a fetch creates it", () =>
    withBareRemote(
      async (repo) => {
        // The checkout has a file the base does not have yet: nothing is pushed from here.
        await commitOffice(repo, OPEN, "open office.yaml, not pushed");
        const publisher = join(repo.root, "publisher");
        await repo.run(["git", "clone", "--quiet", repo.remote, publisher], repo.root);
        writeOffice(publisher, CLOSED);
        await repo.run(["git", "add", "--all"], publisher);
        await repo.run(["git", "commit", "--quiet", "-m", "closed office.yaml"], publisher);
        await repo.run(["git", "push", "--quiet", "origin", "HEAD:main"], publisher);

        const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
        const s = await officeSetup(repo.root, { features: [engineGit.feature] });
        const office = await openAndLoad(s, repo.dir);
        expect(s.manager.config(office)?.review.maxRounds).toBe(4);
        expect(noticeCodes(s, office)).toContain("config.fromCheckout");

        // The first fetch creates `origin/main`; `origin/HEAD` is set as the maintainer's clone has it.
        const git = engineGit.forOffice(office);
        const fetched = await git?.fetch();
        expect(fetched?.ok).toBe(true);
        await repo.git("remote", "set-head", "origin", "main");
        await s.manager.reloadIfChanged(office, git);
        expect(s.manager.config(office)?.review.maxRounds).toBe(2);
        expect(readFileSync(join(repo.dir, OFFICE_YAML), "utf8")).toBe(OPEN);
      },
      { fixture: BACKLOG_FIXTURE },
    ));

  it("keeps the base's file when the base it names has no ref yet, and reads no checkout", () =>
    withBareRemote(
      async (repo) => {
        await commitOffice(repo, NAMES_STAGING, "main names staging, which is not pushed");
        await pushMain(repo);
        // The checkout's own copy differs and is not committed: load must not read it.
        writeOffice(repo.dir, CLOSED);

        const s = await officeSetup(repo.root);
        const office = await openAndLoad(s, repo.dir);
        expect(s.manager.config(office)?.base).toBe("staging");
        expect(s.manager.config(office)?.review.maxRounds).toBe(7);
        expect(s.manager.configHash(office)).toBe(await hashOf(repo.dir, NAMES_STAGING));
        expect(noticeCodes(s, office)).not.toContain("config.fromCheckout");
      },
      { fixture: BACKLOG_FIXTURE },
    ));

  it("reads a base that the committed file names once, and the poll reloads only on a change", () =>
    withBareRemote(
      async (repo) => {
        await commitOffice(repo, NAMES_DEVELOP, "main names develop");
        await repo.git("checkout", "--quiet", "-b", "develop");
        await commitOffice(repo, DEVELOP_CLOSED, "develop office.yaml");
        await repo.git("push", "--quiet", "origin", "main", "develop");
        await repo.git("checkout", "--quiet", "main");
        await repo.git("remote", "set-head", "origin", "main");

        const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
        const reloads: OfficeId[] = [];
        const s = await officeSetup(repo.root, {
          features: [engineGit.feature, countReloads(reloads)],
        });
        const office = await openAndLoad(s, repo.dir);
        expect(s.manager.config(office)?.base).toBe("develop");
        expect(s.manager.config(office)?.review.maxRounds).toBe(2);

        // The first poll after load: develop is unchanged, so nothing reloads.
        const git = engineGit.forOffice(office);
        await git?.fetch();
        await s.manager.reloadIfChanged(office, git);
        expect(reloads).toEqual([]);
        expect(s.manager.config(office)?.review.maxRounds).toBe(2);

        // A fetch of a new commit on develop, from another clone, is in force after the next poll.
        const clone = join(repo.root, "clone");
        await repo.run(
          ["git", "clone", "--quiet", "--branch", "develop", repo.remote, clone],
          repo.root,
        );
        writeOffice(clone, DEVELOP_OPEN);
        await repo.run(["git", "add", "--all"], clone);
        await repo.run(["git", "commit", "--quiet", "-m", "open office.yaml"], clone);
        await repo.run(["git", "push", "--quiet", "origin", "develop"], clone);
        await git?.fetch();
        await s.manager.reloadIfChanged(office, git);
        expect(s.manager.config(office)?.review.maxRounds).toBe(4);
        expect(reloads).toEqual([office]);
      },
      { fixture: BACKLOG_FIXTURE },
    ));
});
