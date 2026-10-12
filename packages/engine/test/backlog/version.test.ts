// The Backlog.md version check (DIPO-28; 0010 section 1): a load step registered through the
// DIPO-27 seam runs `backlog --version`; anything outside 1.53.x refuses the office with a notice
// naming the version and `bun add -g backlog.md@1.53.0`.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { withTempRepo } from "@dipsaus-orchestrator/testkit";

import { backlogFeature, checkVersion, INSTALL_COMMAND } from "../../src/backlog";
import { engineRegistry, FEATURES } from "../../src/features";
import { BACKLOG_FIXTURE, errorOf, officeSetup, resultOf, send } from "../office/helpers";
import { stubSpawn } from "./helpers";

describe("checkVersion", () => {
  it("refuses 1.52.0 and 1.54.0 with the install command", () => {
    for (const version of ["1.52.0", "1.54.0"]) {
      const result = checkVersion(`${version}\n`);
      expect(result.ok).toBe(false);
      const reason = result.ok ? "" : result.reason;
      expect(reason).toContain(`Backlog.md ${version} is not supported`);
      expect(reason).toContain("bun add -g backlog.md@1.53.0");
    }
  });

  it("accepts any 1.53 patch", () => {
    expect(checkVersion("1.53.4\n")).toEqual({ ok: true, version: "1.53.4" });
    expect(checkVersion("1.53.0")).toEqual({ ok: true, version: "1.53.0" });
  });

  it("refuses output that is not a version", () => {
    const result = checkVersion("command not found\n");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain(INSTALL_COMMAND);
  });
});

describe("the backlog.version load step", () => {
  it("is registered by the engine's features", () => {
    const steps = engineRegistry(FEATURES).loadSteps();
    expect(steps.map((step) => [step.module, step.name])).toContainEqual([
      "backlog",
      "backlog.version",
    ]);
  });

  for (const [version, loads] of [
    ["1.52.0", false],
    ["1.54.0", false],
    ["1.53.4", true],
  ] as const) {
    it(`${loads ? "loads" : "refuses"} an office with Backlog.md ${version}`, async () => {
      await withTempRepo(
        async (repo) => {
          const stub = stubSpawn(`${version}\n`);
          const s = await officeSetup(repo.root, {
            features: [backlogFeature({ spawn: stub.spawn })],
          });
          const office = resultOf<{ office: OfficeId }>(
            await send(s, "office.open", { path: repo.dir }),
          ).office;
          const reply = await send(s, "fixture.ping", {}, office);
          expect(stub.calls.map((call) => call.cmd)).toEqual([["backlog", "--version"]]);
          expect(stub.calls[0]?.cwd).toBe(`${repo.dir}/.git`);
          if (loads) {
            resultOf(reply);
            expect(s.manager.loadedOffices()).toEqual([office]);
            return;
          }
          expect(errorOf(reply)).toBe("office.refused");
          expect(!reply.ok && reply.error.details).toMatchObject({ step: "backlog.version" });
          const notice = s.events.at(-1);
          expect(notice?.type).toBe("engine.notice");
          const text = (notice?.data as { text?: string } | undefined)?.text ?? "";
          expect(text).toContain(`Backlog.md ${version} is not supported`);
          expect(text).toContain("`bun add -g backlog.md@1.53.0`");
          expect(s.manager.loadedOffices()).toEqual([]);
        },
        { fixture: BACKLOG_FIXTURE },
      );
    });
  }

  it("refuses an office when the CLI cannot start, naming the install command", async () => {
    await withTempRepo(
      async (repo) => {
        const s = await officeSetup(repo.root, {
          features: [
            backlogFeature({
              spawn: () => {
                throw new Error("Executable not found in $PATH: backlog");
              },
            }),
          ],
        });
        const office = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        ).office;
        const reply = await send(s, "fixture.ping", {}, office);
        expect(errorOf(reply)).toBe("office.refused");
        const text = (s.events.at(-1)?.data as { text?: string } | undefined)?.text ?? "";
        expect(text).toContain("could not start");
        expect(text).toContain(INSTALL_COMMAND);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
