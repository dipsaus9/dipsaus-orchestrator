// CI only (0017 section 1): run temp directories at run end (DIPO-102) on real git with the pinned
// Backlog CLI and DIPO-44's worker host in this process, the sweeps wired as the daemon wires
// them (after each ingested worker exit and each exit decision). A `needs-permission` park ends
// the run and its directory goes; the answer reopens the run and its next session gets a fresh
// directory, which goes when the run ends at In Review. A crashed worker's run goes on with a
// next session and keeps its directory. Each case needs a claim, an office load and several CLI
// calls, well over the local per-test budget; the sweep's rules run locally in temp-dirs.test.ts.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type CommandReply, RequestId, type RunId } from "@dipsaus-orchestrator/contract";

import { executeCommand } from "../../src/commands/execute";
import { buildRegistry } from "../../src/commands/registry";
import { PermissionAsks } from "../../src/hooks/permissions";
import { openQuestions } from "../../src/hooks/questions";
import { createSystemIds } from "../../src/platform/ids";
import { findRun, openPark, runTempDir } from "../../src/run";
import { detect } from "../../src/scan/detect";
import { encode } from "../../src/workers/claude-cli/encode";
import { needsPermissionRecording } from "../hooks/needs-permission";
import { type Running, withRunOffice } from "./run-office";

const PROFILE = detect({
  texts: { "package.json": JSON.stringify({ name: "fixture", scripts: { verify: "bun test" } }) },
  lockfiles: ["bun.lock"],
  workspaceDirs: [],
  configImports: {},
  envFiles: [],
});

let count = 0;
function requestId(): RequestId {
  count += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${(91_000 + count).toString().padStart(8, "0")}`);
}

function command(
  r: Running,
  name: string,
  args: Record<string, unknown>,
  extra: { registry?: ReturnType<typeof buildRegistry>; confirmed?: boolean } = {},
): Promise<CommandReply> {
  return executeCommand(
    {
      ...r.s.deps,
      ids: createSystemIds(r.s.clock),
      ...(extra.registry === undefined ? {} : { registry: extra.registry }),
    },
    {
      requestId: requestId(),
      name,
      args,
      origin: "cli",
      confirmed: extra.confirmed ?? true,
      office: r.officeId,
    },
  );
}

async function startRun(r: Running): Promise<RunId> {
  const reply = await command(r, "work.run", { from: r.repo.dir });
  if (!reply.ok) throw new Error(`work.run failed: ${JSON.stringify(reply)}`);
  const run = (reply.result as { started: { run: string }[] }).started[0]?.run;
  if (run === undefined) throw new Error("work.run started nothing");
  return run as RunId;
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("run temp directories at run end (DIPO-102)", () => {
    it(
      "go when a park ends the run, come back fresh for the reopened run and go at In Review",
      () =>
        withRunOffice(
          {
            host: "replay",
            recordings: [needsPermissionRecording(), "success-single"],
            checks: { ok: true },
            control: {},
            outcomes: true,
            resumeParks: true,
            tempDirs: true,
            finisher: {
              profile: PROFILE,
              beforeWorker: (worktree) => {
                mkdirSync(join(worktree, "packages", "export"), { recursive: true });
                writeFileSync(
                  join(worktree, "packages", "export", "csv.ts"),
                  "export const csv = 1;\n",
                );
              },
            },
          },
          async (r) => {
            const run = await startRun(r);
            const tmpDir = runTempDir(r.tmpRoot, run);
            await r.control?.idle();
            await r.tempDirs?.settled();

            // Parked needs-permission: the run ended and its worker exited, so the directory went.
            expect(openPark(r.office, findRun(r.office, run)?.key ?? "")?.reason).toBe(
              "needs-permission",
            );
            expect(findRun(r.office, run)?.endedAt).not.toBeNull();
            expect(r.tempDirs?.atHostStart).toEqual([true]);
            expect(existsSync(tmpDir)).toBe(false);

            // The answer reopens the same run; its next session starts with a fresh directory.
            const [question] = openQuestions(r.office);
            const asks = new PermissionAsks({
              clock: r.s.clock,
              ids: createSystemIds(r.s.clock),
              offices: {
                get: (office) => r.s.manager.get(office),
                config: (office) => r.s.manager.config(office),
              },
              steering: { send: async () => ({ ok: true }) },
              encode,
              presence: { connected: () => false, lastRequestAt: () => null },
              parks: {
                resume: (office, id, request) =>
                  r.outcomes?.resumePark(office, id, request) ??
                  Promise.resolve({ kind: "failed", reason: "no outcomes" }),
              },
            });
            const reply = await command(
              r,
              "work.answer",
              { question: question?.questionId, text: "", decision: "allow" },
              { registry: buildRegistry([asks.feature]), confirmed: false },
            );
            expect(reply).toMatchObject({ ok: true, result: { delivered: "on-resume", run } });
            await r.outcomes?.idle();
            await r.control?.idle();
            await r.tempDirs?.settled();

            // The second session ran in a fresh directory; the run ended at In Review, so it went.
            expect(r.hosts.map((host) => host.runId)).toEqual([run, run]);
            expect(r.tempDirs?.atHostStart).toEqual([true, true]);
            // The launch and the resumed session both wrote this daemon's owner file, so a
            // daemon-start sweep can tell the fresh directory is its own.
            const owner = r.tempDirs?.owner() ?? null;
            expect(owner).not.toBeNull();
            expect(r.tempDirs?.ownerAtHostStart).toEqual([owner, owner]);
            expect(findRun(r.office, run)?.endKind).toBe("in-review");
            expect(existsSync(tmpDir)).toBe(false);
          },
        ),
      90_000,
    );

    it(
      "stays while a crashed worker's run goes on with its next session",
      () =>
        withRunOffice(
          {
            host: "replay",
            recordings: ["terminated", "success-single"],
            checks: { ok: true },
            control: {},
            outcomes: true,
            tempDirs: true,
          },
          async (r) => {
            const run = await startRun(r);
            await r.control?.idle();
            await r.tempDirs?.settled();

            // Two sessions of the same run, which has not ended: its directory stays.
            expect(r.hosts.map((host) => host.runId)).toEqual([run, run]);
            expect(findRun(r.office, run)?.endedAt).toBeNull();
            expect(r.tempDirs?.atHostStart).toEqual([true, true]);
            // The next session keeps the directory and writes the owner file again.
            const owner = r.tempDirs?.owner() ?? null;
            expect(r.tempDirs?.ownerAtHostStart).toEqual([owner, owner]);
            expect(existsSync(runTempDir(r.tmpRoot, run))).toBe(true);
          },
        ),
      60_000,
    );
  });
}
