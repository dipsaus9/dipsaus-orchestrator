// Story reference resolution (DIPO-22; 0005 section 2): key, then current id, then alias; a
// conflict is `story.ambiguous`; an alias retires when its id becomes another story's current id.

import { describe, expect, it } from "bun:test";

import {
  RequestId,
  StoryId,
  storyDetail,
  workRun,
  workSteer,
  storyPark,
  gateApprove,
} from "@dipsaus-orchestrator/contract";
import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { stateOfficeDirectory } from "../../src/commands/offices";
import { buildRegistry } from "../../src/commands/registry";
import { findStoryRefFields, resolveStoryRefs } from "../../src/commands/story-refs";
import type { OfficeHandle } from "../../src/db/office";
import { executeRead } from "../../src/reads/execute";
import {
  addStory,
  isProvisionalId,
  removeStory,
  renumberStory,
  resolveStoryRef,
} from "../../src/records/story-keys";
import { fixtureFeature } from "./fixtures";
import { addOffice, openTestState, type TestState } from "./helpers";

const id = (value: string) => StoryId.parse(value);

async function withOffice(fn: (t: TestState, office: OfficeHandle) => void | Promise<void>) {
  return withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(t, addOffice(t));
    } finally {
      t.state.close();
    }
  });
}

function resolved(office: OfficeHandle, ref: string): string {
  const result = resolveStoryRef(office, ref);
  return result.ok ? result.key : result.error.code;
}

describe("story references", () => {
  it("resolves a key directly and an id as the current id", () =>
    withOffice((t, office) => {
      const story = office.immediate(() => addStory(office, t.ids, { story: id("DIPO-1") }, 0));
      expect(story.key).toMatch(/^sto_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(resolveStoryRef(office, story.key)).toEqual({ ok: true, ...story });
      expect(resolveStoryRef(office, "DIPO-1")).toEqual({ ok: true, ...story });
      expect(resolved(office, "DIPO-2")).toBe("story.unknown");
      expect(resolved(office, "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D")).toBe("story.unknown");
    }));

  it("resolves a former id through its alias after promotion", () =>
    withOffice((t, office) => {
      const draft = office.immediate(() => addStory(office, t.ids, { story: id("DRAFT-1") }, 0));
      office.immediate(() => renumberStory(office, draft.key, id("DIPO-5"), 10));
      expect(resolveStoryRef(office, "DRAFT-1")).toEqual({
        ok: true,
        key: draft.key,
        story: id("DIPO-5"),
      });
      expect(resolved(office, "DIPO-5")).toBe(draft.key);
      expect(
        office.get<{ provisional: number }>(
          "select provisional from stories where office_id = $office_id and key = $key",
          { key: draft.key },
        ),
      ).toEqual({ provisional: 0 });
    }));

  it("retires the alias when a reused DRAFT-n becomes another story's current id", () =>
    withOffice((t, office) => {
      const old = office.immediate(() => addStory(office, t.ids, { story: id("DRAFT-1") }, 0));
      office.immediate(() => renumberStory(office, old.key, id("DIPO-5"), 10));
      const reused = office.immediate(() => addStory(office, t.ids, { story: id("DRAFT-1") }, 20));
      expect(reused.key).not.toBe(old.key);
      expect(resolved(office, "DRAFT-1")).toBe(reused.key);
      expect(
        office.get<{ retired_at: number | null }>(
          "select retired_at from story_aliases where office_id = $office_id and key = $key",
          { key: old.key },
        ),
      ).toEqual({ retired_at: 20 });

      // Renumbering onto a former id of another story retires that alias too.
      const other = office.immediate(() => addStory(office, t.ids, { story: id("DRAFT-2") }, 30));
      office.immediate(() => renumberStory(office, other.key, id("DIPO-6"), 40));
      office.immediate(() => renumberStory(office, reused.key, id("DRAFT-2"), 50));
      expect(resolved(office, "DRAFT-2")).toBe(reused.key);
    }));

  it("fails with story.ambiguous when an id names a current story and another's alias", () =>
    withOffice((t, office) => {
      const a = office.immediate(() => addStory(office, t.ids, { story: id("DIPO-1") }, 0));
      const b = office.immediate(() => addStory(office, t.ids, { story: id("DIPO-2") }, 0));
      // A live alias that the engine's writers would have retired, as reconcile might find it.
      office.immediate(() =>
        office.run(
          "insert into story_aliases (office_id, key, story_id, valid_from) values ($office_id, $key, 'DIPO-1', 0)",
          { key: b.key },
        ),
      );
      const result = resolveStoryRef(office, "DIPO-1");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("story.ambiguous");
      expect(result.error.details).toEqual({ story: "DIPO-1", keys: [a.key, b.key].toSorted() });

      // Two aliases of different stories.
      office.immediate(() =>
        office.run(
          `insert into story_aliases (office_id, key, story_id, valid_from)
           values ($office_id, $a, 'DIPO-9', 0), ($office_id, $b, 'DIPO-9', 0)`,
          { a: a.key, b: b.key },
        ),
      );
      expect(resolved(office, "DIPO-9")).toBe("story.ambiguous");
    }));

  it("does not resolve a removed story's id, but still resolves its key", () =>
    withOffice((t, office) => {
      const gone = office.immediate(() => addStory(office, t.ids, { story: id("DIPO-3") }, 0));
      office.immediate(() => removeStory(office, gone.key, 5));
      expect(resolved(office, "DIPO-3")).toBe("story.unknown");
      expect(resolved(office, gone.key)).toBe(gone.key);
      const next = office.immediate(() => addStory(office, t.ids, { story: id("DIPO-3") }, 6));
      expect(resolved(office, "DIPO-3")).toBe(next.key);
    }));

  it("marks DRAFT-n ids provisional", () => {
    expect(isProvisionalId("DRAFT-3")).toBe(true);
    expect(isProvisionalId("DIPO-3")).toBe(false);
  });

  it("finds story reference fields from the contract args schemas", () => {
    expect(findStoryRefFields(workSteer.args)).toEqual([{ field: "story", many: false }]);
    expect(findStoryRefFields(storyPark.args)).toEqual([{ field: "story", many: false }]);
    expect(findStoryRefFields(workRun.args)).toEqual([{ field: "stories", many: true }]);
    expect(findStoryRefFields(storyDetail.args)).toEqual([{ field: "story", many: false }]);
    expect(findStoryRefFields(gateApprove.args)).toEqual([]);
  });

  it("replaces every reference in a list with its key and stops at the first unknown", () =>
    withOffice((t, office) => {
      const a = office.immediate(() => addStory(office, t.ids, { story: id("DIPO-1") }, 0));
      const b = office.immediate(() => addStory(office, t.ids, { story: id("DIPO-2") }, 0));
      const fields = findStoryRefFields(workRun.args);
      const ok = resolveStoryRefs(office, fields, { stories: ["DIPO-1", b.key], maxAgents: 2 });
      expect(ok.ok && ok.args).toEqual({ stories: [a.key, b.key], maxAgents: 2 });
      expect(ok.ok && [...ok.stories.keys()]).toEqual([a.key, b.key]);
      const bad = resolveStoryRefs(office, fields, { stories: ["DIPO-1", "DIPO-8"] });
      expect(!bad.ok && bad.error.code).toBe("story.unknown");
      expect(resolveStoryRefs(office, fields, {}).ok).toBe(true);
    }));

  it("resolves story references in an office read", () =>
    withOffice(async (t, office) => {
      const draft = office.immediate(() => addStory(office, t.ids, { story: id("DRAFT-4") }, 0));
      const deps = {
        registry: buildRegistry([fixtureFeature({ touch: 0, peek: 0, level: 0 })]),
        offices: stateOfficeDirectory(t.state),
        clock: t.clock,
      };
      const requestId = RequestId.parse("01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");
      const reply = await executeRead(deps, {
        requestId,
        name: "fixture.detail",
        args: { office: office.officeId, story: "DRAFT-4" },
      });
      expect(reply).toMatchObject({
        ok: true,
        result: { view: { key: draft.key, story: "DRAFT-4", provisional: true } },
      });
      const unknown = await executeRead(deps, {
        requestId,
        name: "fixture.detail",
        args: { office: office.officeId, story: "DIPO-77" },
      });
      expect(!unknown.ok && unknown.error.code).toBe("story.unknown");
      const bad = await executeRead(deps, { requestId, name: "fixture.detail", args: {} });
      expect(!bad.ok && bad.error.code).toBe("args.invalid");
      const nope = await executeRead(deps, { requestId, name: "office.nope", args: {} });
      expect(!nope.ok && nope.error.code).toBe("capability.missing");
    }));
});
