// Watches the test process for unhandled rejections (DIPO-110): in the daemon each one is an exit
// that counts as a crash (0006 decision 7), so a background job that fails must leave none.

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
