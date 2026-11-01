// Shared setup for the round and place tests (DIPO-142): a migrated state database on the manual
// clock with one office, and writers for the facts the places and rounds read: claimed story runs,
// session runs, agents with their role, and usage per agent.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  AgentId,
  RunId,
  StoryId,
  type StoryKey,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import { mirrorStory } from "./park-fixture";
import type { OfficeHandle } from "../../src/db/office";
import { insertRun } from "../../src/records";
import { addStory } from "../../src/records/story-keys";
import { insertClaim } from "../../src/worktree/records";
import { addOffice, openTestState, type TestState } from "../commands/helpers";

export const MINUTE = 60_000;

export interface RoundsWorld {
  readonly dir: string;
  readonly t: TestState;
  readonly office: OfficeHandle;
  close(): void;
}

export async function roundsWorld(prefix: string): Promise<RoundsWorld> {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", prefix));
  const t = await openTestState(dir);
  const office = addOffice(t);
  return {
    dir,
    t,
    office,
    close: () => {
      t.state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface StoryRunOptions {
  readonly story: string;
  /** The story tier the run recorded at pickup; M by default. */
  readonly tier?: string | null;
  readonly model?: string;
  readonly loopCap?: number;
  readonly reviewRoundCap?: number | null;
  readonly maxMinutes?: number;
  readonly budgetLimit?: number;
  /** The review loop's snapshot (DIPO-146); none by default. */
  readonly reviewMaxTurns?: number | null;
  readonly reviewMaxMinutes?: number | null;
  readonly reviewMaxTokens?: number | null;
}

export interface StoryRun {
  readonly run: RunId;
  readonly key: StoryKey;
  readonly story: string;
}

/** A claimed story run started now, with no agent yet. */
export function storyRun(w: RoundsWorld, options: StoryRunOptions): StoryRun {
  const { office, t } = w;
  const run = RunId.parse(t.ids.next("run"));
  const { key } = office.immediate(() =>
    addStory(office, t.ids, { story: StoryId.parse(options.story) }, t.clock.now()),
  );
  const branch = `${options.story}/a-story`;
  office.immediate(() => {
    // The story as the index read it, so a park reaches the mirror (DIPO-360).
    mirrorStory(office, { key, story: options.story, status: "In Review" }, t.clock.now());
    insertRun(office, {
      runId: run,
      kind: "story",
      key,
      story: options.story,
      tier: options.tier === undefined ? "M" : options.tier,
      role: "developer",
      model: options.model ?? "sonnet",
      startSha: "b".repeat(40),
      branch,
      budgetUnit: "tokens",
      budgetLimit: options.budgetLimit ?? 1_000_000,
      loopCap: options.loopCap ?? 3,
      maxTurns: 100,
      maxMinutes: options.maxMinutes ?? 60,
      reviewRoundCap: options.reviewRoundCap ?? null,
      reviewMaxTurns: options.reviewMaxTurns ?? null,
      reviewMaxMinutes: options.reviewMaxMinutes ?? null,
      reviewMaxTokens: options.reviewMaxTokens ?? null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: t.clock.now(),
    });
    insertClaim(office, {
      runId: run,
      key,
      story: options.story,
      branch,
      base: "main",
      baseSha: "b".repeat(40),
      startSha: "b".repeat(40),
      claimSha: "d".repeat(40),
      reused: false,
      claimedAt: t.clock.now(),
    });
  });
  return { run, key, story: options.story };
}

/** A session run (M1 to M5: a model session outside a story) that has not ended. */
export function sessionRun(w: RoundsWorld): RunId {
  const run = RunId.parse(w.t.ids.next("run"));
  w.office.immediate(() =>
    insertRun(w.office, {
      runId: run,
      kind: "session",
      key: null,
      story: null,
      tier: null,
      role: "developer",
      model: "haiku",
      startSha: null,
      branch: null,
      budgetUnit: "tokens",
      budgetLimit: 1,
      loopCap: 1,
      reviewRoundCap: null,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: w.t.clock.now(),
    }),
  );
  return run;
}

/** An agent of `run` with `role`, started now; ended now unless `live`. */
export function addAgent(
  w: RoundsWorld,
  run: RunId,
  role: string,
  live: boolean,
  model = "sonnet",
): AgentId {
  const agent = AgentId.parse(w.t.ids.next("agt"));
  const at = w.t.clock.now();
  w.office.immediate(() =>
    w.office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, session_id, started_at,
         ended_at, end_reason)
       values ($office_id, $agent, $run, $role, $model, $session, $at, $ended, $reason)`,
      {
        agent,
        run,
        role,
        model,
        session: `session-${agent}`,
        at,
        ended: live ? null : at,
        reason: live ? null : "exited",
      },
    ),
  );
  return agent;
}

/** Ends the live agent `agent` now. */
export function endAgent(w: RoundsWorld, agent: AgentId): void {
  w.office.immediate(() =>
    w.office.run(
      `update agents set ended_at = $at, end_reason = 'exited'
        where office_id = $office_id and agent_id = $agent`,
      { agent, at: w.t.clock.now() },
    ),
  );
}

/** The usage an agent of `run` spent: its turns and its budget tokens (all as input). */
export function addUsage(
  w: RoundsWorld,
  run: RunId,
  agent: AgentId,
  role: string,
  usage: { readonly turns: number; readonly tokens: number },
): void {
  w.office.immediate(() =>
    w.office.run(
      `insert into usage_totals (office_id, run_id, agent_id, model, role, tier, input, turns,
         updated_at)
       values ($office_id, $run, $agent, 'sonnet', $role, 'M', $tokens, $turns, $at)`,
      { run, agent, role, tokens: usage.tokens, turns: usage.turns, at: w.t.clock.now() },
    ),
  );
}

/** The work ref of a story run's agent, as worker outcomes hold it. */
export function workOf(story: StoryRun, agent: AgentId, role = "developer"): WorkRef {
  return {
    story: story.story,
    key: story.key,
    run: story.run,
    agent,
    role,
    tier: "M",
    model: "sonnet",
  } as WorkRef;
}
