// The desk notification (DIPO-357): one macOS notification when an item is added to an office's
// desk, naming the office, the story and the kind of wait. The daemon reads `office.desk` after a
// change of the office and passes the items here; the notifier posts each item once. An item is
// identified by what it is (its kind, story, key, question, gate, reason and proposal), not by its
// detail or its time, which change on every read. The first read of an office shows nothing: those
// items were on the desk before, and a restart must not announce them again. A failed post is
// logged and never reaches the caller.

import {
  type DeskItem,
  officeDesk,
  type OfficeId,
  RequestId,
} from "@dipsaus-orchestrator/contract";

import type { EngineSurface } from "../create/surface";
import type { Logger } from "../log/logger";
import type { PostNotification } from "../platform/notify";

/** The identity of a desk item across reads: what it is, not how it reads now. */
export function deskItemKey(item: DeskItem): string {
  return JSON.stringify([
    item.kind,
    item.story ?? null,
    item.key ?? null,
    item.question ?? null,
    item.gate ?? null,
    item.reason ?? null,
    item.proposal?.id ?? null,
  ]);
}

/** The notification of one desk item: the office's name, the story and the kind of wait. */
export function deskNotice(
  officeName: string,
  item: DeskItem,
): { readonly title: string; readonly body: string } {
  const story = item.story === undefined ? "office" : item.story;
  return {
    title: `dipo: ${officeName}`,
    body: `${story} · ${item.kind}: ${item.detail}`,
  };
}

export interface DeskNotifierDeps {
  readonly post: PostNotification;
  readonly logger: Logger;
}

/** Posts a notification for each desk item an office gains; see the file comment. */
export class DeskNotifier {
  readonly #deps: DeskNotifierDeps;
  /** The keys of the items each office's desk has shown in this run of the daemon. */
  readonly #shown = new Map<OfficeId, Set<string>>();

  constructor(deps: DeskNotifierDeps) {
    this.#deps = deps;
  }

  /** Posts the items of `office`'s desk that were not shown before; `officeName` names it. */
  async observe(office: OfficeId, officeName: string, items: readonly DeskItem[]): Promise<void> {
    const first = !this.#shown.has(office);
    const shown = this.#shown.get(office) ?? new Set<string>();
    this.#shown.set(office, shown);
    for (const item of items) {
      const key = deskItemKey(item);
      if (shown.has(key)) continue;
      shown.add(key);
      if (first) continue;
      try {
        await this.#deps.post(deskNotice(officeName, item));
      } catch (error) {
        this.#deps.logger.warn("desk notification failed", {
          office,
          kind: item.kind,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/**
 * Reads the desk of every office that changes and passes it to `notifier`, through the engine's own
 * `office.desk` read. Returns the call that stops the watch. A failed read is logged, never thrown.
 */
export function watchDesk(deps: {
  readonly surface: Pick<EngineSurface, "onOfficeChanged" | "executeRead" | "officeSummary">;
  readonly notifier: DeskNotifier;
  readonly logger: Logger;
  /** A new request id for each read, as the lock's own reads make them. */
  readonly nextId: () => string;
}): () => void {
  const { surface, notifier, logger, nextId } = deps;
  return surface.onOfficeChanged((office) => {
    void (async () => {
      const reply = await surface.executeRead({
        requestId: RequestId.parse(nextId()),
        name: officeDesk.name,
        args: { office },
      });
      if (!reply.ok) return;
      const parsed = officeDesk.result.safeParse(reply.result);
      if (!parsed.success) {
        logger.warn("desk read has an unexpected shape", { office });
        return;
      }
      const name = surface.officeSummary(office)?.name ?? office;
      await notifier.observe(office, name, parsed.data);
    })().catch((error: unknown) => {
      logger.warn("desk notification failed", {
        office,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  });
}
