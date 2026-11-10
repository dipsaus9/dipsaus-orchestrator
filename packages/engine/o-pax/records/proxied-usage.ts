// The model proxy's ledger (DIPO-425, 0008): who sent a model request, by the box-address registry
// of `BoxWorkers` only, and the run records each answer's tokens go into. Those are the records the
// caps (`caps.ts`), the tier budget and the spend alerts (`usage_totals`, `usage_daily`) read, so
// every model request a box makes counts against its run, whatever program in the box sent it.
//
// - `open` resolves the owner's run and agent and writes the agent's row of the requested model
//   (`openProxiedRow`) before the proxy forwards anything; an office that is not loaded, a run or
//   an agent of that run it does not know, or a write that fails throws, and the proxy refuses the
//   request. So after a failed write no request of that office goes on until a write succeeds.
// - Once the run's token cap is reached (the reviewer's own cap for a reviewer, 0002), `open`
//   throws `ModelUseCapped` and the proxy refuses new requests with 429, so a program that is not
//   Claude Code cannot overrun the cap while the engine stops the session.
// - The account adds each answer's tokens to the agent's row of the answer's model. A row a run's
//   end already made final feeds only its change into `usage_daily` (`feedFinalChanges`), so an
//   answer counted after the session ended still reaches the day's spend.
// - A reviewer's tokens count against the reviewer's own caps, as its stream's did (0002): the scope
//   carries the agent's role.
// - A planning session's tokens (DIPO-447) and an idea audit's (DIPO-470) count in the office's usage
//   and spend like any run's, against no cap: a session run with no budget (`isUncapped`) has no
//   story and no run cap, and ends when its work ends.

import type { Clock, OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import {
  type ModelUsageLedger,
  CAP_REFUSAL,
  ModelUseCapped,
  type ProxyAccount,
  type ProxyOwner,
} from "../box/model-proxy";
import type { OfficeHandle } from "../db/office";

import { isUncapped, REVIEWER_ROLE, reviewTotals, runCaps, runTotals } from "./caps";
import { recordProxyRefusal } from "./proxy-refusals";
import { findRun } from "./run-records";
import {
  feedFinalChanges,
  finalRows,
  openProxiedRow,
  recordProxiedUsage,
  type UsageScope,
} from "./usage";

export interface ProxiedUsageLedgerDeps {
  /** The box-address registry (`BoxWorkers.owner`). */
  readonly owner: (address: string) => ProxyOwner | null;
  /** The loaded office of an id; undefined when it is not loaded. */
  readonly office: (office: OfficeId) => OfficeHandle | undefined;
  readonly clock: Clock;
}

/** The usage scope of `owner` in its office; throws when the office does not know its agent. */
function scopeOf(office: OfficeHandle, owner: ProxyOwner): UsageScope {
  const run = findRun(office, owner.run as RunId);
  if (run === null) throw new Error(`the office does not know run ${owner.run}`);
  const agent = office.get<{ role: string }>(
    `select role from agents
     where office_id = $office_id and agent_id = $agent and run_id = $run`,
    { agent: owner.agent, run: owner.run },
  );
  if (agent === null) throw new Error(`run ${owner.run} has no agent ${owner.agent}`);
  const role = agent.role;
  return {
    run: run.runId,
    agent: owner.agent,
    role,
    tier: run.tier ?? "",
    // A reviewer's own token cap per session (0002), as its ingestion keeps it; a run with no cap has none.
    budgetLimit: isUncapped(run)
      ? 0
      : role === REVIEWER_ROLE
        ? (run.reviewMaxTokens ?? 0)
        : runCaps(office, run).budgetTokens,
  };
}

/** True when `scope`'s token cap is reached: the run's, or a reviewer's own (0002). */
function capReached(office: OfficeHandle, scope: UsageScope): boolean {
  const run = findRun(office, scope.run as RunId);
  if (run === null) return false;
  // A session run with no budget has no token cap (DIPO-447, DIPO-470).
  if (isUncapped(run)) return false;
  if (scope.role === REVIEWER_ROLE) {
    const cap = run.reviewMaxTokens;
    if (cap === null || cap === undefined) return false;
    return reviewTotals(office, run.runId, scope.agent, 0, 0).budgetTokens >= cap;
  }
  return runTotals(office, run.runId, 0, 0).budgetTokens >= runCaps(office, run).budgetTokens;
}

/** The ledger the daemon's model proxy counts into. */
export function proxiedUsageLedger(deps: ProxiedUsageLedgerDeps): ModelUsageLedger {
  return {
    owner: (address) => deps.owner(address),
    open: (owner, model): ProxyAccount => {
      const office = deps.office(owner.office as OfficeId);
      if (office === undefined) throw new Error(`office ${owner.office} is not loaded`);
      // The refusal is written apart from the throw, so the write is not rolled back with it.
      const opened = office.immediate(() => {
        const found = scopeOf(office, owner);
        if (capReached(office, found)) {
          recordProxyRefusal(office, found.run as RunId, CAP_REFUSAL, deps.clock.now());
          return null;
        }
        openProxiedRow(office, found, model, deps.clock.now());
        return found;
      });
      if (opened === null) throw new ModelUseCapped(CAP_REFUSAL);
      const scope = opened;
      return (usage) => {
        const at = deps.clock.now();
        office.immediate(() => {
          const before = finalRows(office, scope.run, scope.agent);
          recordProxiedUsage(office, scope, usage, at);
          feedFinalChanges(office, scope.run, scope.agent, before, at);
        });
      };
    },
  };
}
