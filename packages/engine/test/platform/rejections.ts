// Watches the test process for unhandled rejections (DIPO-110). Under the binary's top-level await,
// Bun 1.4.2 reports one and keeps running; the crash counter does not count it, and the process
// exits 1 at its next stop. A background job that fails must leave none.

import { yieldToEventLoop } from "../../src/platform/clock";

export interface RejectionWatch {
  /** Lets pending rejections be reported, stops watching and returns what was seen. */
  stop(): Promise<unknown[]>;
}

export function watchRejections(): RejectionWatch {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);
  return {
    stop: async () => {
      await yieldToEventLoop();
      await yieldToEventLoop();
      process.off("unhandledRejection", listener);
      return seen;
    },
  };
}
