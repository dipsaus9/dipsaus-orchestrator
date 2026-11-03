// Matching a pass against the story keys (DIPO-32; 0005, 0007): a known id keeps its key, a title
// change is an edit, a vanished id closes as Removed, a new id is a new story (nothing is matched
// by branch or date), and the change log gets `story.state` and `engine.notice` entries for what
// changed.

import { describe, expect, it } from "bun:test";

import { Event, StoryId, StoryKey } from "@dipsaus-orchestrator/contract";

import { addStory, resolveStoryRef } from "../../src/records/story-keys";
import { draft, entriesAfter, keyOf, lastSeq, pass, storyRows, task, withOffice } from "./helpers";

const BRANCH_1 = "TASK-1/add-the-csv-export-command";

describe("story index pass", () => {
  it("gives every new story a sto_ key and a story.state entry with its view", () =>
    withOffice((t, office) => {
      const stats = pass(t, office, [
        task("TASK-1", { status: "Ready", tier: "S", labels: ["tier:S"], frozenBranch: BRANCH_1 }),
        draft("DRAFT-1"),
      ]);
      expect(stats).toEqual({
        stories: 2,
        added: 2,
        removed: 0,
        changed: 2,
      });
      const key = keyOf(office, "TASK-1");
      expect(key).toMatch(/^sto_[0-9A-HJKMNP-TV-Z]{26}$/);
      const entries = entriesAfter(office);
      expect(entries.map((e) => [e.type, e.delta["story"]])).toEqual([
        ["story.state", "DRAFT-1"],
        ["story.state", "TASK-1"],
      ]);
      const ready = entries[1];
      expect(ready?.key).toBe(key);
      expect(ready?.delta).toEqual({ story: "TASK-1", key, from: "Ready", to: "Ready" });
      expect(ready?.view).toEqual({
        key,
        story: "TASK-1",
        provisional: false,
        title: "Story TASK-1",
        lifecycle: "Ready",
        tier: "S",
        column: "ready",
      });
      expect(entries[0]?.view).toMatchObject({ provisional: true, lifecycle: "Draft" });
    }));

  it("stores the frozen branch on the key", () =>
    withOffice((t, office) => {
      pass(t, office, [task("TASK-1", { frozenBranch: BRANCH_1 })]);
      expect(
        office.get<Record<string, unknown>>(
          "select frozen_branch from stories where office_id = $office_id",
        ),
      ).toEqual({ frozen_branch: BRANCH_1 });
    }));

  it("writes the mirror: hash, kind, status, title, tier, role, labels, read time and source", () =>
    withOffice((t, office) => {
      pass(t, office, [
        task("TASK-1", {
          status: "In Progress",
          tier: "M",
          role: "developer",
          labels: ["tier:M", "role:developer", "export"],
        }),
      ]);
      expect(
        office.get<Record<string, unknown>>(
          "select content_hash, kind, status, title, tier, role, labels, read_at, source from backlog_mirror where office_id = $office_id",
        ),
      ).toEqual({
        content_hash: "hash-TASK-1",
        kind: "task",
        status: "In Progress",
        title: "Story TASK-1",
        tier: "M",
        role: "developer",
        labels: JSON.stringify(["tier:M", "role:developer", "export"]),
        read_at: t.clock.now(),
        source: "base",
      });
    }));

  it("keeps every key across two passes and writes nothing when nothing changed", () =>
    withOffice((t, office) => {
      const read = [task("TASK-1"), task("TASK-2"), draft("DRAFT-1")];
      pass(t, office, read);
      const before = storyRows(office);
      const seq = lastSeq(office);
      t.clock.advance(1000);
      expect(pass(t, office, read)).toMatchObject({ added: 0, changed: 0, removed: 0 });
      expect(storyRows(office)).toEqual(before);
      expect(entriesAfter(office, seq)).toEqual([]);
    }));

  it("keeps the key when only the title changed and reports the new view", () =>
    withOffice((t, office) => {
      pass(t, office, [task("TASK-2")]);
      const key = keyOf(office, "TASK-2");
      const seq = lastSeq(office);
      pass(t, office, [task("TASK-2", { title: "Rename the export option" })]);
      expect(keyOf(office, "TASK-2")).toBe(key);
      const entries = entriesAfter(office, seq);
      expect(entries.map((e) => e.type)).toEqual(["story.state"]);
      expect(entries[0]?.delta).toMatchObject({ from: "Refined", to: "Refined" });
      expect(entries[0]?.view).toMatchObject({ title: "Rename the export option" });
    }));

  it("emits story.state with from, to and the derived view when the status changes", () =>
    withOffice((t, office) => {
      pass(t, office, [task("TASK-2")]);
      const key = keyOf(office, "TASK-2");
      const seq = lastSeq(office);
      pass(t, office, [task("TASK-2", { status: "Ready" })]);
      const [entry] = entriesAfter(office, seq);
      expect(entry?.delta).toEqual({ story: "TASK-2", key, from: "Refined", to: "Ready" });
      expect(entry?.view).toMatchObject({ lifecycle: "Ready", column: "ready" });
      const event = Event.parse({
        cursor: { stream: `office:${office.officeId}`, seq: 1 },
        at: new Date(0).toISOString(),
        type: "story.state",
        data: { ...entry?.delta, view: entry?.view },
      });
      expect(event.type).toBe("story.state");
    }));

  it("closes a vanished key as Removed with an engine.notice", () =>
    withOffice((t, office) => {
      pass(t, office, [task("TASK-1", { status: "Ready" }), task("TASK-2")]);
      const key = keyOf(office, "TASK-1");
      const seq = lastSeq(office);
      expect(pass(t, office, [task("TASK-2")])).toMatchObject({ removed: 1 });
      expect(keyOf(office, "TASK-1")).toBeNull();
      const entries = entriesAfter(office, seq);
      expect(entries.map((e) => [e.type, e.key])).toEqual([
        ["story.state", key],
        ["engine.notice", key],
      ]);
      expect(entries[0]?.delta).toEqual({ story: "TASK-1", key, from: "Ready", to: "Removed" });
      expect(entries[0]?.view).toMatchObject({ lifecycle: "Removed", column: "removed" });
      expect(entries[1]?.delta).toMatchObject({ level: "warn", code: "story.removed" });
    }));

  it("closes a key no pass mirrored from the lifecycle its stories row implies", () =>
    withOffice((t, office) => {
      const [draftKey, taskKey] = office.immediate(() => [
        addStory(office, t.ids, { story: StoryId.parse("DRAFT-7") }, t.clock.now()).key,
        addStory(office, t.ids, { story: StoryId.parse("TASK-7") }, t.clock.now()).key,
      ]);
      const seq = lastSeq(office);
      expect(pass(t, office, [])).toMatchObject({ removed: 2 });
      const states = entriesAfter(office, seq).filter((e) => e.type === "story.state");
      expect(states.map((e) => [e.key, e.delta["from"], e.delta["to"]])).toEqual([
        [draftKey, "Draft", "Removed"],
        [taskKey, "Refined", "Removed"],
      ]);
    }));

  it("closes a draft promoted by hand as Removed and gives its new id a new key", () =>
    withOffice((t, office) => {
      pass(t, office, [task("TASK-1"), draft("DRAFT-1")]);
      const key = keyOf(office, "DRAFT-1");
      const seq = lastSeq(office);
      const stats = pass(t, office, [task("TASK-1"), task("TASK-4", { title: "Story DRAFT-1" })]);
      expect(stats).toMatchObject({ added: 1, removed: 1 });
      const fresh = keyOf(office, "TASK-4");
      expect(fresh).not.toBe(key);
      const entries = entriesAfter(office, seq);
      expect(entries.some((e) => e.type === "story.renumbered")).toBe(false);
      expect(entries.find((e) => e.key === key && e.type === "story.state")?.delta).toMatchObject({
        from: "Draft",
        to: "Removed",
      });
      expect(entries.find((e) => e.key === key && e.type === "engine.notice")?.delta).toMatchObject(
        {
          level: "warn",
          code: "story.removed",
        },
      );
      expect(entries.find((e) => e.key === fresh && e.type === "story.state")?.delta).toMatchObject(
        {
          story: "TASK-4",
          to: "Refined",
        },
      );
      // The former id is gone: no alias leads to the old story.
      expect(resolveStoryRef(office, "DRAFT-1")).toMatchObject({ ok: false });
    }));

  it("never matches a vanished story by its frozen branch: a renamed story is a new story", () =>
    withOffice((t, office) => {
      pass(t, office, [task("TASK-1", { frozenBranch: BRANCH_1 })]);
      const key = keyOf(office, "TASK-1");
      const seq = lastSeq(office);
      const stats = pass(t, office, [task("TASK-7", { frozenBranch: BRANCH_1 })]);
      expect(stats).toMatchObject({ added: 1, removed: 1 });
      expect(keyOf(office, "TASK-7")).not.toBe(key);
      // Only the removal's notice: no notice says the stories could not be told apart.
      expect(
        entriesAfter(office, seq)
          .filter((e) => e.type === "engine.notice")
          .map((e) => e.delta["code"]),
      ).toEqual(["story.removed"]);
    }));

  it("keeps the key of a known id whatever its frozen branch says", () =>
    withOffice((t, office) => {
      pass(t, office, [task("TASK-1", { frozenBranch: BRANCH_1 })]);
      const key = keyOf(office, "TASK-1");
      const stats = pass(t, office, [task("TASK-1", { frozenBranch: "TASK-1/another" })]);
      expect(stats).toMatchObject({ added: 0, removed: 0 });
      expect(keyOf(office, "TASK-1")).toBe(key);
    }));

  it("keeps the key when the story gets its frozen branch at refine", () =>
    withOffice((t, office) => {
      pass(t, office, [task("TASK-1")]);
      const key = keyOf(office, "TASK-1");
      pass(t, office, [task("TASK-1", { frozenBranch: BRANCH_1 })]);
      expect(keyOf(office, "TASK-1")).toBe(key);
      expect(
        office.get<{ frozen_branch: string }>(
          "select frozen_branch from stories where office_id = $office_id and key = $key",
          { key },
        )?.frozen_branch,
      ).toBe(BRANCH_1);
    }));

  it("keeps each id's key when two stories swap ids", () =>
    withOffice((t, office) => {
      pass(t, office, [
        task("TASK-1", { frozenBranch: "TASK-1/a" }),
        task("TASK-2", { frozenBranch: "TASK-2/b" }),
      ]);
      const a = keyOf(office, "TASK-1");
      const b = keyOf(office, "TASK-2");
      pass(t, office, [
        task("TASK-2", { frozenBranch: "TASK-1/a" }),
        task("TASK-1", { frozenBranch: "TASK-2/b" }),
      ]);
      expect(keyOf(office, "TASK-1")).toBe(a);
      expect(keyOf(office, "TASK-2")).toBe(b);
      expect(resolveStoryRef(office, StoryKey.parse(a))).toMatchObject({
        ok: true,
        story: "TASK-1",
      });
    }));

  it("notices a status outside dipo's once and shows it as Refined", () =>
    withOffice((t, office) => {
      pass(t, office, [task("TASK-1", { status: "Blocked" })]);
      const entries = entriesAfter(office);
      expect(entries.map((e) => [e.type, e.delta["code"] ?? e.delta["to"]])).toEqual([
        ["engine.notice", "story.statusUnknown"],
        ["story.state", "Refined"],
      ]);
      const seq = lastSeq(office);
      pass(t, office, [task("TASK-1", { status: "Blocked" })]);
      expect(entriesAfter(office, seq)).toEqual([]);
      pass(t, office, [task("TASK-1", { status: "Blocked" }), task("TASK-2", { status: "To Do" })]);
      expect(entriesAfter(office, seq).some((e) => e.type === "engine.notice")).toBe(false);
    }));

  it("writes nothing of a pass that fails part way", () =>
    withOffice((t, office) => {
      pass(t, office, [task("TASK-1")]);
      const before = storyRows(office);
      const seq = lastSeq(office);
      expect(() =>
        pass(t, office, [
          task("TASK-1", { status: "Ready" }),
          task("TASK-2", { kind: "folder" as never }),
        ]),
      ).toThrow();
      expect(storyRows(office)).toEqual(before);
      expect(entriesAfter(office, seq)).toEqual([]);
    }));
});
