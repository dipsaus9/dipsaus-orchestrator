// Shared setup for the view tests: an office with indexed stories and a story run as `work.run`
// records it (a live claim, the run row, its agent, the `setup` phase) plus its worker host, so
// views, the watchdog and ingestion see the same facts a daemon writes.

import { join } from "node:path";

import {
  AgentId,
  RoleId,
  RunId,
  StoryId,
  StoryKey,
  type WorkRef,
} from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../src/db/office";
import { type RunCriteria, recordRunCriteria } from "../../src/run/criteria";
import { appendRunStep, insertRun } from "../../src/run/records";
import { recordWorkerHost } from "../../src/runs/worker-hosts";
import type { TestState } from "../commands/helpers";

export interface StartedRun {
  readonly key: StoryKey;
  readonly run: RunId;
  readonly agent: AgentId;
  readonly work: WorkRef;
  readonly eventFile: string;
}

/** The key the index gave `story`. */
export function keyOf(office: OfficeHandle, story: string): StoryKey {
  const row = office.get<{ key: string }>(
    "select key from stories where office_id = $office_id and story_id = $story",
    { story },
  );
  if (row === null) throw new Error(`${story} is not indexed`);
  return StoryKey.parse(row.key);
}

/** Records a claimed story run of `story` (indexed already) with its agent and worker host. */
export function startRun(
  t: TestState,
  office: OfficeHandle,
  story: string,
  dir: string,
  options: {
    readonly loopCap?: number;
    readonly budget?: number;
    /** The story criteria the run starts with (DIPO-85). */
    readonly criteria?: RunCriteria;
  } = {},
): StartedRun {
  const key = keyOf(office, story);
  const run = RunId.parse(t.ids.next("run"));
  const agent = AgentId.parse(t.ids.next("agt"));
  const at = t.clock.now();
  office.immediate(() => {
    office.run(
      `insert into claims (office_id, run_id, key, story_id, branch, base, base_sha, start_sha,
         reused, claimed_at)
       values ($office_id, $run, $key, $story, $branch, 'main', 'b', 's', 0, $at)`,
      { run, key, story, branch: `${story}/work`, at },
    );
    insertRun(office, {
      runId: run,
      kind: "story",
      key,
      story,
      tier: "S",
      role: "developer",
      model: "haiku",
      startSha: "s",
      branch: `${story}/work`,
      budgetUnit: "tokens",
      budgetLimit: options.budget ?? 400_000,
      loopCap: options.loopCap ?? 3,
      reviewRoundCap: null,
      configHash: "hash",
      overrideKeys: null,
      runProfileId: null,
      startedAt: at,
    });
    office.run(
      `insert into agents (office_id, agent_id, run_id, role, model, started_at)
       values ($office_id, $agent, $run, 'developer', 'haiku', $at)`,
      { agent, run, at },
    );
    if (options.criteria !== undefined) recordRunCriteria(office, run, options.criteria);
    appendRunStep(office, run, "phase", "setup", at);
  });
  const eventFile = join(dir, `${run}.ndjson`);
  recordWorkerHost(
    office,
    {
      pid: 4242,
      startTimeMs: 0,
      runId: run,
      agentId: agent,
      socketPath: join(dir, "host.sock"),
      protocolVersion: 1,
      runDir: dir,
      eventFile,
    },
    t.clock,
  );
  const work: WorkRef = {
    story: StoryId.parse(story),
    key,
    run,
    agent,
    role: RoleId.parse("developer"),
    tier: "S",
    model: "haiku",
  };
  return { key, run, agent, work, eventFile };
}
