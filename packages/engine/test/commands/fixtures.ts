// A fixture feature module for the executor tests. Its commands reuse contract schemas under
// their own names, so the tests exercise the executor without depending on a built feature.

import {
  type CommandDefinition,
  type Lifecycle,
  daemonSetLogLevel,
  defineCommand,
  defineRead,
  type ReadDefinition,
  storyDetail,
  type StoryKey,
  workSteer,
} from "@dipsaus-orchestrator/contract";

import type { CommandContext, FeatureModule } from "../../src/commands/registry";
import { CommandError } from "../../src/commands/errors";

function shipped<D extends CommandDefinition>(definition: D, name: string) {
  const { name: _name, ...rest } = definition;
  return defineCommand({ ...rest, name });
}

function shippedRead<D extends ReadDefinition>(definition: D, name: string) {
  const { name: _name, ...rest } = definition;
  return defineRead({ ...rest, name });
}

/** `{ story, text }` -> `{ run, delivered }`: writes a fact and emits `story.state`. */
export const touchCommand = shipped(workSteer, "fixture.touch");
/** The same args, but it writes nothing and emits nothing. */
export const peekCommand = shipped(workSteer, "fixture.peek");
/** A software-level command: `{ level }` -> `{ level }`. */
export const levelCommand = shipped(daemonSetLogLevel, "fixture.level");
/** An office read with a story reference: `{ office, story }`. */
export const detailRead = shippedRead(storyDetail, "fixture.detail");

/** A valid `StoryView` for a story at the given key and id. */
export function fixtureView(key: string, story: string, lifecycle: Lifecycle = "Ready") {
  return {
    key,
    story,
    provisional: story.startsWith("DRAFT-"),
    title: "Export stories as CSV",
    lifecycle,
    column: "ready",
  };
}

export interface FixtureCalls {
  touch: number;
  peek: number;
  level: number;
  /** When set, `fixture.touch` throws it after writing its fact and emitting its entry. */
  failWith?: Error;
}

function touch(calls: FixtureCalls, ctx: CommandContext, args: { story: string; text: string }) {
  calls.touch += 1;
  const story = ctx.stories.get(args.story);
  if (story === undefined) throw new Error("the executor passes resolved keys");
  const n =
    (ctx.office.get<{ n: number }>("select count(*) as n from facts where office_id = $office_id")
      ?.n ?? 0) + 1;
  ctx.office.run("insert into facts (office_id, n, note) values ($office_id, $n, $note)", {
    n,
    note: args.text,
  });
  ctx.emit({
    type: "story.state",
    key: story.key as StoryKey,
    delta: { story: story.story, key: story.key, from: "Refined", to: "Ready" },
    view: fixtureView(story.key, story.story),
  });
  if (calls.failWith !== undefined) throw calls.failWith;
  return { result: { run: ctx.ids.next("run"), delivered: "next-turn" as const } };
}

export function fixtureFeature(calls: FixtureCalls, name = "test/fixture"): FeatureModule {
  return {
    name,
    register(registry) {
      registry.addOfficeCommand({
        definition: touchCommand,
        handle: (ctx, args) => touch(calls, ctx, args),
      });
      registry.addOfficeCommand({
        definition: peekCommand,
        handle: (ctx) => {
          calls.peek += 1;
          return { result: { run: ctx.ids.next("run"), delivered: "next-turn" as const } };
        },
      });
      registry.addSoftwareCommand({
        definition: levelCommand,
        handle: async (_ctx, args) => {
          calls.level += 1;
          if (args.level === "trace") throw new CommandError("not.permitted", "No tracing here.");
          return { result: { level: args.level }, changed: true };
        },
      });
      registry.addRead({
        definition: detailRead,
        handle: (ctx, args) => {
          const story = ctx.stories.get(args.story);
          if (story === undefined) throw new Error("the executor passes resolved keys");
          return { view: fixtureView(story.key, story.story), runs: [], verdicts: [] };
        },
      });
    },
  };
}
