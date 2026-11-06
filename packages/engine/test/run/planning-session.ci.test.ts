// CI only (0017): a planning session (DIPO-447) through the command executor, with the real Claude
// worker port and a scripted worker: `planning.start`, three `planning.message` and `planning.end`
// on one session. Each answer streams as `planning.output` with the session's view, each turn end
// as `planning.updated` with its usage so far, though the session has no story; the watchdog writes
// nothing while the session waits for the next message. Fast versions of the rules are in
// planning-session.test.ts.

import { describe, expect, it } from "bun:test";

import { type OfficeId, RequestId } from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { executeCommand } from "../../src/commands/execute";
import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import { openTestState } from "../commands/helpers";
import { entriesAfter } from "../stories/helpers";
import { answerTokens, planningRun, planningWorld, until } from "./planning-world";

const MINUTE = 60_000;

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("a planning session talked to turn by turn (DIPO-447)", () => {
    it("gives three answers to three messages on one session, each streamed with its usage, and trips no watchdog while it waits", () =>
      withTempDir(async (dir) => {
        const t = await openTestState(dir);
        try {
          const w = planningWorld(t, dir);
          const registry = buildRegistry([w.sessions.feature]);
          let n = 0;
          const send = (name: string, args: Record<string, unknown>) => {
            n += 1;
            return executeCommand(
              {
                registry,
                offices: stateOfficeDirectory(t.state),
                clock: t.clock,
                ids: t.ids,
                softwareRequests: new MemoryRequestTable(t.clock),
              },
              {
                requestId: RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${String(n).padStart(8, "0")}`),
                name,
                args,
                origin: "cli",
                confirmed: false,
                office: w.office.officeId as OfficeId,
              },
            );
          };
          const office = w.office.officeId as OfficeId;
          const turns = () => w.sessions.view(office)?.turns ?? -1;
          const signals = () =>
            w.office.all("select signal from run_signals where office_id = $office_id");

          const started = await send("planning.start", { kind: "plan", goal: "Plan M3" });
          expect(started.ok).toBe(true);
          const run = (started as { result: { run: string } }).result.run;
          await until(() => turns() === 1);

          for (const [i, text] of ["First?", "Second?", "Third?"].entries()) {
            // The session waits for the maintainer longer than the stuck wait: nothing fires.
            t.clock.advance(30 * MINUTE);
            expect(signals()).toEqual([]);
            const sent = await send("planning.message", { text });
            expect(sent).toMatchObject({ ok: true, result: { run, delivered: "next-turn" } });
            t.clock.advance(1_000);
            await until(() => turns() === i + 2);
          }
          expect(w.answers).toBe(4);
          // The three messages went to the one session's stdin, as user messages.
          const writes = w.sent.flatMap((ops) =>
            ops.flatMap((op) => ("write" in op ? [JSON.parse(op.write) as unknown] : [])),
          );
          expect(writes).toMatchObject(
            ["First?", "Second?", "Third?"].map((content) => ({
              type: "user",
              message: { role: "user", content },
            })),
          );

          const entries = entriesAfter(w.office);
          // Every answer streamed as output of the session, with no story and no work ref.
          const output = entries
            .filter((entry) => entry.type === "planning.output")
            .map((entry) => (entry.delta as { run: string; text: string }).text)
            .join("");
          for (const answer of [1, 2, 3, 4]) expect(output).toContain(`Answer ${answer}.`);
          expect(entries.some((entry) => entry.type.startsWith("work."))).toBe(false);
          // Each turn end is an update with the usage the model proxy counted so far; a usage update
          // of the same turn may follow it.
          const waiting = new Map<unknown, Record<string, unknown>>();
          for (const entry of entries) {
            if (entry.type !== "planning.updated") continue;
            const { view } = entry.delta as { view: Record<string, unknown> };
            if (view["state"] === "waiting") waiting.set(view["turns"], view);
          }
          expect([...waiting.keys()]).toEqual([1, 2, 3, 4]);
          let input = 0;
          for (const [turn, view] of waiting) {
            input += answerTokens(Number(turn)).input;
            expect((view["usage"] as { inputTokens: number }).inputTokens).toBe(input);
          }
          expect(signals()).toEqual([]);

          const ended = await send("planning.end", {});
          expect(ended).toMatchObject({ ok: true, result: { run, ended: "maintainer" } });
          t.clock.advance(1_000);
          await until(() => planningRun(w.office, run)?.end_kind !== null);
          expect(planningRun(w.office, run)?.end_kind).toBe("done");
          expect(entriesAfter(w.office).at(-1)?.type).toBe("planning.ended");
        } finally {
          t.state.close();
        }
      }));
  });
}
