// The desk notification reads `office.desk` itself (DIPO-357); that is the engine's own read, so
// it asks the surface for it as internal and writes no request line (DIPO-320).

import { describe, expect, it } from "bun:test";

import type { OfficeId, ReadReply, ReadRequest } from "@dipsaus-orchestrator/contract";
import { createLogger } from "../../src/log/logger";
import { DeskNotifier, watchDesk } from "../../src/overview/desk-notify";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;

describe("the desk notification's read", () => {
  it("is asked as the engine's own read", async () => {
    const asked: { request: ReadRequest; options: unknown }[] = [];
    const listeners: ((office: OfficeId) => void)[] = [];
    const logger = createLogger({ clock: new ManualClock(), sinks: [], component: "test" });
    const stop = watchDesk({
      surface: {
        onOfficeChanged: (listener) => {
          listeners.push(listener);
          return () => undefined;
        },
        executeRead: async (request, options) => {
          asked.push({ request, options });
          return { ok: true, requestId: request.requestId, result: { items: [] } } as ReadReply;
        },
        officeSummary: () => undefined,
      },
      notifier: new DeskNotifier({ post: async () => undefined, logger }),
      logger,
      nextId: () => "01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
    });
    for (const listener of listeners) listener(OFFICE);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    stop();
    expect(asked).toEqual([
      {
        request: expect.objectContaining({ name: "office.desk", args: { office: OFFICE } }),
        options: { internal: true },
      },
    ]);
  });
});
