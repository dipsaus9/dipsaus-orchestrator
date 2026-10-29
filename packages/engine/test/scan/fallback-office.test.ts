// The run profile's fallback and confirmations through an office against real git (DIPO-310
// criteria 5 to 9), with a scripted session runner: no model is called.
//
// - The fallback starts only on `office.infer`, never at the load scan or after a rescan.
// - `office.profile` lists each capability with its source, confidence, confirmed, pending and
//   stale, and the deviations with their fix; `office.desk` lists the pending proposal and the
//   stale confirmation as hand-action rows with their `dipo office confirm` line.
// - `office.confirm` writes only the database, recomputes the run refusal and emits
//   `scan.finished` with the diff.
// - A rescan keeps confirmations at an unchanged fingerprint, marks them stale on a change (they
//   keep working for `run`), and replaces one whose capability code now resolves, with a diff line.

import { describe, expect, it } from "bun:test";

import {
  type DeskItem,
  type OfficeId,
  type ProfileView,
  RequestId,
} from "@dipsaus-orchestrator/contract";
import {
  applyFixture,
  type FixtureTree,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import type { OfficeHandle } from "../../src/db/office";
import { EngineGit } from "../../src/git";
import { createRepoFiles } from "../../src/git/repo-files";
import { systemSpawn } from "../../src/platform/process";
import { executeRead } from "../../src/reads/execute";
import { RunProfiles } from "../../src/scan/feature";
import type { ScanSessionRequest } from "../../src/scan/fallback";
import { readMarks } from "../../src/scan/marks";
import { currentProfile, verifyResolved } from "../../src/scan/store";
import { viewsFeature } from "../../src/views/feature";
import { BACKLOG_FIXTURE, type OfficeSetup, officeSetup, resultOf, send } from "../office/helpers";
import { entriesAfter, lastSeq } from "../stories/helpers";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A product code cannot get verify from: a Makefile runs its checks. */
const MAKE_APP: FixtureTree = {
  "package.json": json({ name: "app", scripts: { dev: "vite" } }),
  "bun.lock": "{}\n",
  Makefile: "check:\n\tbun test\n",
};

const ANSWER = {
  proposals: [
    {
      capability: "verify",
      commands: [["make", "check"]],
      cwd: ".",
      evidence: ["Makefile: target check runs bun test"],
      confidence: "medium",
    },
  ],
};

interface Office {
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly profiles: RunProfiles;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly requests: ScanSessionRequest[];
}

async function publish(repo: TempRepoWithRemote, files: FixtureTree, message: string) {
  applyFixture(repo.dir, files);
  await repo.commitAll(message);
  await repo.git("push", "--quiet", "origin", "main");
}

function withOffice(files: FixtureTree, fn: (o: Office) => Promise<void>): Promise<void> {
  return withBareRemote(
    async (repo) => {
      applyFixture(repo.dir, files);
      await repo.commitAll("fixture");
      await repo.git("push", "--quiet", "-u", "origin", "main");
      await repo.git("remote", "set-head", "origin", "main");
      const requests: ScanSessionRequest[] = [];
      const engineGit = new EngineGit({ spawn: systemSpawn, env: repo.env });
      const profiles = new RunProfiles({
        git: engineGit,
        files: (dir) => createRepoFiles(dir, { env: repo.env }),
        fallback: () => ({
          run: async (request) => {
            requests.push(request);
            return { kind: "answered", runId: "run_scripted", answer: ANSWER };
          },
        }),
        scanSettings: () => ({
          model: "haiku",
          effort: "low",
          budgetTokens: 50_000,
          maxMinutes: 2,
        }),
      });
      const s = await officeSetup(repo.root, {
        features: [engineGit.feature, profiles.feature, viewsFeature],
      });
      try {
        const { office: officeId } = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        );
        const access = await s.manager.load(officeId);
        if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);
        await fn({ repo, s, profiles, officeId, office: access.office, requests });
      } finally {
        await profiles.close();
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}

async function read<T>(o: Office, name: string): Promise<T> {
  const reply = await executeRead(
    { registry: o.s.registry, offices: o.s.manager, clock: o.s.clock },
    {
      requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z00000310"),
      name,
      args: { office: o.officeId },
    },
  );
  if (!reply.ok) throw new Error(`${name} failed: ${reply.error.code} ${reply.error.message}`);
  return reply.result as T;
}

async function rescan(o: Office): Promise<string[]> {
  const seq = lastSeq(o.office);
  resultOf(await send(o.s, "office.rescan", {}, o.officeId));
  await o.profiles.whenIdle(o.officeId);
  const finished = entriesAfter(o.office, seq).filter((entry) => entry.type === "scan.finished");
  return (finished.at(-1)?.delta["diff"] as string[] | undefined) ?? [];
}

const capability = (view: ProfileView, name: string) =>
  view.capabilities.find((entry) => entry.name === name);

describe("the fallback through an office", () => {
  it("starts only on office.infer, never at load or after a rescan", () =>
    withOffice(MAKE_APP, async (o) => {
      await rescan(o);
      expect(o.requests).toHaveLength(0);
      expect(verifyResolved(o.office)).toContain("`dipo office infer`");
      const reply = resultOf<{ infer: string; capabilities: string[] }>(
        await send(o.s, "office.infer", {}, o.officeId),
      );
      expect(reply.infer).toBe("started");
      expect(reply.capabilities).toContain("verify");
      expect(reply.capabilities).not.toContain("dev");
      await o.profiles.fallback.whenIdle(o.officeId);
      expect(o.requests).toHaveLength(1);
      expect(o.requests[0]?.settings).toMatchObject({ model: "haiku", maxTurns: 2 });
      // The evidence came from dipo's base copy.
      expect(o.requests[0]?.taskMessage).toContain("check:");
      expect(readMarks(o.office).proposals.map((p) => p.capability)).toEqual(["verify"]);
      // A rescan after it asks no model either.
      await rescan(o);
      expect(o.requests).toHaveLength(1);
    }));

  it("lists the profile with pending, confirmed and stale, and the desk rows with their command", () =>
    withOffice(MAKE_APP, async (o) => {
      // Before any infer, the desk names the fallback for the verify run refuses on.
      const unresolved = (await read<DeskItem[]>(o, "office.desk")).filter(
        (item) => item.kind === "PROFILE",
      );
      expect(unresolved.map((item) => item.detail)).toEqual([
        "verify is unresolved, so dipo run refuses stories",
      ]);
      expect(unresolved[0]?.actions.map((action) => action.cli)).toEqual([
        "dipo office infer",
        "dipo office confirm set verify -- <command>",
      ]);
      resultOf(await send(o.s, "office.infer", {}, o.officeId));
      await o.profiles.fallback.whenIdle(o.officeId);
      const view = await read<ProfileView>(o, "office.profile");
      expect(view).toMatchObject({ office: o.officeId, scanned: true, inferring: false });
      expect(view.runRefusal).toContain("Verify is unresolved");
      const verify = capability(view, "verify");
      expect(verify).toMatchObject({ status: "unresolved", confirmed: false, stale: false });
      expect(verify?.pending).toMatchObject({
        command: "make check",
        confidence: "low",
        modelConfidence: "medium",
        evidence: ["Makefile: target check runs bun test"],
        stale: false,
      });
      expect(verify?.cli).toEqual([
        "dipo office confirm accept verify",
        "dipo office confirm edit verify -- <command>",
        "dipo office confirm reject verify",
        "dipo office confirm set verify -- <command>",
      ]);
      expect(verify?.fix).toContain('add a "verify" script');
      expect(capability(view, "dev")).toMatchObject({
        status: "resolved",
        command: "bun run dev",
        source: "standard",
        confidence: "high",
        cli: [],
      });
      expect(view.deviations).toContainEqual({
        code: "missing-test",
        message: 'No "test" script. Add one: it is required.',
        conflict: false,
        fix: 'add a "test" script',
      });

      let desk = await read<DeskItem[]>(o, "office.desk");
      const pending = desk.filter((item) => item.kind === "PROFILE");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.detail).toContain("verify · proposed make check · confidence low");
      expect(pending[0]?.story).toBeUndefined();
      expect(pending[0]?.actions.map((action) => action.cli)).toEqual([
        "dipo office confirm accept verify",
        "dipo office confirm edit verify -- <command>",
        "dipo office confirm reject verify",
      ]);

      // Accepted, then the repository's run inputs change: the confirmation is stale.
      const seq = lastSeq(o.office);
      const accepted = resultOf<{ source: string; confirmed: boolean; diff: string[] }>(
        await send(o.s, "office.confirm", { action: "accept", capability: "verify" }, o.officeId),
      );
      expect(accepted).toMatchObject({ source: "inferred", confirmed: true });
      const finished = entriesAfter(o.office, seq).filter((e) => e.type === "scan.finished");
      expect(finished.map((e) => e.delta["trigger"])).toEqual(["confirm"]);
      expect(finished[0]?.delta["diff"]).toEqual(accepted.diff);
      expect(verifyResolved(o.office)).toBeNull();
      await publish(
        o.repo,
        { "package.json": json({ name: "app", scripts: { dev: "vite --host" } }) },
        "change dev",
      );
      const diff = await rescan(o);
      expect(diff).toContain(
        "! verify confirmation is stale: the repository's run inputs changed since it was confirmed; it keeps working until `dipo office confirm keep verify`",
      );
      const stale = capability(await read<ProfileView>(o, "office.profile"), "verify");
      expect(stale).toMatchObject({
        status: "resolved",
        source: "inferred",
        confirmed: true,
        stale: true,
      });
      expect(stale?.cli).toContain("dipo office confirm keep verify");
      // A stale confirmed verify keeps working for run.
      expect(verifyResolved(o.office)).toBeNull();
      desk = await read<DeskItem[]>(o, "office.desk");
      const row = desk.find((item) => item.kind === "PROFILE");
      expect(row?.detail).toContain("verify · confirmed make check is stale");
      expect(row?.actions.map((action) => action.cli)).toEqual([
        "dipo office confirm keep verify",
        "dipo office confirm set verify -- <command>",
      ]);
    }));

  it("keeps a confirmation at an unchanged fingerprint and replaces it once code resolves it", () =>
    withOffice(MAKE_APP, async (o) => {
      resultOf(
        await send(
          o.s,
          "office.confirm",
          { action: "set", capability: "verify", commands: [["make", "check"]] },
          o.officeId,
        ),
      );
      const fingerprint = currentProfile(o.office)?.code.fingerprint;
      expect(await rescan(o)).toEqual([]);
      expect(currentProfile(o.office)?.code.fingerprint).toBe(fingerprint);
      expect(currentProfile(o.office)?.marks.verify).toMatchObject({
        confirmed: true,
        stale: false,
      });

      await publish(
        o.repo,
        { "package.json": json({ name: "app", scripts: { dev: "vite", verify: "make check" } }) },
        "add verify",
      );
      const diff = await rescan(o);
      expect(diff).toContainEqual(
        "~ verify confirmation: make check [maintainer] -> code resolves it: bun run verify [standard, package.json scripts.verify]; the confirmation is removed",
      );
      expect(readMarks(o.office).confirmations).toEqual([]);
      const verify = currentProfile(o.office)?.profile.capabilities.verify;
      expect(verify?.status === "resolved" && verify.source).toBe("standard");
      expect(currentProfile(o.office)?.marks.verify.confirmed).toBe(false);
    }));
});
