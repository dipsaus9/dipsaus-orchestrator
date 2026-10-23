// A crash between a waiting command's commits and its `requests` row (0005 note of 2026-10-17,
// DIPO-168 in DIPO-155): the handler runs to its end, its facts stay committed, and the process
// dies before the executor records the reply. `crashAfterHandler` gives executor deps whose command
// `name` does exactly that: the real handler runs, then the outcome is thrown away with `CRASH`,
// so no `requests` row is written and the reply is a failure. A retry with the same request id
// through the plain deps then runs the handler again, as after a daemon restart.

import type { ExecutorDeps } from "../../src/commands/execute";
import type { AsyncCommandContext, Registry, RegisteredCommand } from "../../src/commands/registry";

/** The message of the injected crash. */
export const CRASH = "the daemon stopped before the requests row";

/** `deps` whose waiting office command `name` crashes after its handler and before the record. */
export function crashAfterHandler(deps: ExecutorDeps, name: string): ExecutorDeps {
  const registry = deps.registry;
  const command = (asked: string): RegisteredCommand | undefined => {
    const found = registry.command(asked);
    if (found === undefined || asked !== name || found.level !== "office" || !found.waits) {
      return found;
    }
    return {
      ...found,
      handle: async (ctx: AsyncCommandContext, args: unknown) => {
        await found.handle(ctx, args);
        throw new Error(CRASH);
      },
    };
  };
  const crashing = new Proxy(registry, {
    get(target, property, receiver) {
      if (property === "command") return command;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as Registry;
  return { ...deps, registry: crashing };
}
