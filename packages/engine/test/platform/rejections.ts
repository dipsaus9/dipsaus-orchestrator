// Watches the test process for unhandled rejections (DIPO-110). In the daemon one is a crash: it is
// logged, the daemon drains and exits 1, and the crash loop counts it (DIPO-117). A background job
// that fails, or a pipe closed after its child exited, must leave none.

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
