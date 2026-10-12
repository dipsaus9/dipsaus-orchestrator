// Usage facts (0007 section 4, 0008 section 4). Each counted assistant message is one
// `usage_messages` row, unique per office, agent and message id; its tokens join the agent's
// `usage_totals` row for that model in the same transaction. At a turn end the adapter's
// cumulative totals replace the live numbers. `usage_daily` is fed only when a totals row
// becomes final. Budget tokens are input plus output plus cache creation; cache reads are stored
// and shown, never counted.
//
// Every function here writes or reads through the office handle and must run inside the caller's
// transaction.

import type { Usage, UsageTotals } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { ModelUsageTotals, UsageTotalsByModel } from "../workers/types";

/** The run and agent usage is counted for, with what `runs` holds for it. */
export interface UsageScope {
  readonly run: string;
  readonly agent: string;
  readonly role: string;
  readonly tier: string;
  /** The run's budget limit in tokens (0008 section 9). */
  readonly budgetLimit: number;
}

/** Budget tokens of one set of numbers (0008 section 4). */
export function budgetOf(usage: ModelUsageTotals): number {
  return usage.input + usage.output + usage.cacheCreate;
}

function ensureRow(office: OfficeHandle, scope: UsageScope, model: string, at: number): void {
  office.run(
    `insert or ignore into usage_totals (office_id, run_id, agent_id, model, role, tier,
       budget_limit, updated_at)
     values ($office_id, $run, $agent, $model, $role, $tier, $limit, $at)`,
    {
      run: scope.run,
      agent: scope.agent,
      model,
      role: scope.role,
      tier: scope.tier,
      limit: scope.budgetLimit,
      at,
    },
  );
}

const BUDGET_UPDATE = "budget_used = input + output + cache_create";

/** One counted assistant message. Returns false when it was already counted. */
export function recordUsageMessage(
  office: OfficeHandle,
  scope: UsageScope,
  message: {
    readonly messageId: string;
    readonly model: string;
    readonly input: number;
    readonly cacheCreate: number;
    readonly cacheRead: number;
  },
  at: number,
): boolean {
  const inserted = office.run(
    `insert or ignore into usage_messages (office_id, agent_id, message_id, run_id, model, input,
       output, cache_create, cache_read, at)
     values ($office_id, $agent, $message, $run, $model, $input, 0, $create, $read, $at)`,
    {
      agent: scope.agent,
      message: message.messageId,
      run: scope.run,
      model: message.model,
      input: message.input,
      create: message.cacheCreate,
      read: message.cacheRead,
      at,
    },
  );
  if (inserted.changes === 0) return false;
  ensureRow(office, scope, message.model, at);
  office.run(
    `update usage_totals set input = input + $input, cache_create = cache_create + $create,
       cache_read = cache_read + $read, updated_at = $at
     where office_id = $office_id and run_id = $run and agent_id = $agent and model = $model`,
    {
      input: message.input,
      create: message.cacheCreate,
      read: message.cacheRead,
      at,
      run: scope.run,
      agent: scope.agent,
      model: message.model,
    },
  );
  setBudget(office, scope);
  return true;
}

function setBudget(office: OfficeHandle, scope: UsageScope): void {
  office.run(
    `update usage_totals set ${BUDGET_UPDATE}
     where office_id = $office_id and run_id = $run and agent_id = $agent`,
    { run: scope.run, agent: scope.agent },
  );
}

/**
 * A turn end: the adapter's cumulative totals for this agent replace the live numbers of every
 * model, and the turn count joins the agent's main model row.
 */
export function applyTurnTotals(
  office: OfficeHandle,
  scope: UsageScope,
  totals: UsageTotalsByModel,
  turns: { readonly model: string; readonly count: number },
  at: number,
): void {
  for (const model of Object.keys(totals)) ensureRow(office, scope, model, at);
  ensureRow(office, scope, turns.model, at);
  const models = office.all<{ model: string }>(
    `select model from usage_totals
     where office_id = $office_id and run_id = $run and agent_id = $agent`,
    { run: scope.run, agent: scope.agent },
  );
  for (const { model } of models) {
    const usage = totals[model] ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    office.run(
      `update usage_totals set input = $input, output = $output, cache_create = $create,
         cache_read = $read, turns = turns + $turns, updated_at = $at
       where office_id = $office_id and run_id = $run and agent_id = $agent and model = $model`,
      {
        input: usage.input,
        output: usage.output,
        create: usage.cacheCreate,
        read: usage.cacheRead,
        turns: model === turns.model ? turns.count : 0,
        at,
        run: scope.run,
        agent: scope.agent,
        model,
      },
    );
  }
  setBudget(office, scope);
}

/** Wall time of the agent, kept on its main model row. */
export function setElapsed(
  office: OfficeHandle,
  scope: UsageScope,
  model: string,
  elapsedMs: number,
  at: number,
): void {
  ensureRow(office, scope, model, at);
  office.run(
    `update usage_totals set elapsed_ms = $elapsed
     where office_id = $office_id and run_id = $run and agent_id = $agent and model = $model`,
    { elapsed: Math.max(0, elapsedMs), run: scope.run, agent: scope.agent, model },
  );
}

interface TotalsRow {
  run_id: string;
  model: string;
  role: string;
  tier: string;
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  turns: number;
  elapsed_ms: number;
  budget_used: number;
  budget_limit: number;
  est_cost_micros: number | null;
}

/** `yyyy-mm-dd` in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Marks the agent's totals final and feeds each row into `usage_daily` (0007 section 7: the
 * daily rollup has this one source). A row already final is never fed twice. Returns the number
 * of rows that became final.
 */
export function finalizeAgentUsage(
  office: OfficeHandle,
  run: string,
  agent: string,
  at: number,
): number {
  const rows = office.all<TotalsRow>(
    `select run_id, model, role, tier, input, output, cache_create, cache_read, turns, elapsed_ms,
       budget_used, budget_limit, est_cost_micros
     from usage_totals
     where office_id = $office_id and run_id = $run and agent_id = $agent and final = 0`,
    { run, agent },
  );
  const day = utcDay(at);
  for (const row of rows) {
    // A run counts once per day, role, tier and model, however many agents it had.
    const counted = office.get(
      `select 1 as found from usage_totals
       where office_id = $office_id and run_id = $run and final = 1 and role = $role
         and tier = $tier and model = $model`,
      { run: row.run_id, role: row.role, tier: row.tier, model: row.model },
    );
    const newRun = counted === null ? 1 : 0;
    office.run(
      `update usage_totals set final = 1, updated_at = $at
       where office_id = $office_id and run_id = $run and agent_id = $agent and model = $model`,
      { at, run, agent, model: row.model },
    );
    office.run(
      `insert into usage_daily (office_id, day, role, tier, model, input, output, cache_create,
         cache_read, turns, runs, est_cost_micros, budget_used, budget_limit_sum)
       values ($office_id, $day, $role, $tier, $model, $input, $output, $create, $read, $turns,
         $runs, $cost, $used, $limit)
       on conflict (office_id, day, role, tier, model) do update set
         input = input + excluded.input,
         output = output + excluded.output,
         cache_create = cache_create + excluded.cache_create,
         cache_read = cache_read + excluded.cache_read,
         turns = turns + excluded.turns,
         runs = runs + excluded.runs,
         est_cost_micros = case
           when excluded.est_cost_micros is null then est_cost_micros
           else coalesce(est_cost_micros, 0) + excluded.est_cost_micros end,
         budget_used = budget_used + excluded.budget_used,
         budget_limit_sum = budget_limit_sum + excluded.budget_limit_sum`,
      {
        day,
        role: row.role,
        tier: row.tier,
        model: row.model,
        input: row.input,
        output: row.output,
        create: row.cache_create,
        read: row.cache_read,
        turns: row.turns,
        runs: newRun,
        cost: row.est_cost_micros,
        used: row.budget_used,
        limit: newRun === 1 ? row.budget_limit : 0,
      },
    );
  }
  return rows.length;
}

const SUMS = `coalesce(sum(input), 0) as input, coalesce(sum(output), 0) as output,
  coalesce(sum(cache_create), 0) as cache_create, coalesce(sum(cache_read), 0) as cache_read,
  coalesce(sum(turns), 0) as turns, coalesce(sum(elapsed_ms), 0) as elapsed_ms`;

interface SumRow {
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  turns: number;
  elapsed_ms: number;
}

function toTotals(row: SumRow | null): UsageTotals {
  return {
    inputTokens: row?.input ?? 0,
    outputTokens: row?.output ?? 0,
    cacheCreateTokens: row?.cache_create ?? 0,
    cacheReadTokens: row?.cache_read ?? 0,
    turns: row?.turns ?? 0,
    elapsedMs: row?.elapsed_ms ?? 0,
  };
}

/** The contract `Usage` of an agent within its run (0005 section 5). */
export function readUsage(office: OfficeHandle, scope: UsageScope): Usage {
  const agent = toTotals(
    office.get<SumRow>(
      `select ${SUMS} from usage_totals
       where office_id = $office_id and run_id = $run and agent_id = $agent`,
      { run: scope.run, agent: scope.agent },
    ),
  );
  const run = toTotals(
    office.get<SumRow>(
      `select ${SUMS} from usage_totals where office_id = $office_id and run_id = $run`,
      { run: scope.run },
    ),
  );
  const used = run.inputTokens + run.outputTokens + run.cacheCreateTokens;
  const limit = Math.max(0, scope.budgetLimit);
  return {
    agent,
    run,
    budget: { unit: "tokens", limit, used },
    budgetShare: limit > 0 ? used / limit : 0,
  };
}
