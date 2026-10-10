# 0005 Command and event model

Status: Accepted (maintainer, 2026-10-10). Proposed in spike DIPO-2.

## Context

The engine is headless. Every client (CLI, TUI, conversation layer, a later web, desktop or visual client) acts only through commands and learns only through events (0001, 0011 items 5 and 10). The contract lives in `packages/contract` as zod 4 schemas with no I/O; non-TypeScript clients use its JSON Schema export (0004). Daemon lifecycle, transport and connection auth are 0006 (DIPO-3); storage schema is DIPO-4; the story lifecycle and Ready gate are 0012 (DIPO-8). This ADR defines the transport-independent shapes between them.

Requirements from the backlog and research:

- Commands for: office open and switch, rescan, run, approve, reject, answer, steer, pause, resume, reassign, stop, drop, and test pass or fail with a note.
- Events for: state changed, worker output, gate reached, parked, usage. Enough to show who (agent, role) works on which story, in which phase, with what progress and usage.
- Facts stored, status derived; a change log feeds the stream; reconnecting clients replay what they missed (research idea 1).
- A small read surface with capability flags (idea 10).
- Debounced deltas, never full state on the stream (idea 21).

External patterns checked: SSE stores the last event id and sends it back as `Last-Event-ID` on reconnect, but defines no replay; the server must resend [1]. WebSocket has no resume either; the usual design is a monotonic sequence, a bounded server buffer and a client cursor [2]. Kubernetes watches answer a too-old cursor with `410 Gone`, after which the client must re-list and watch from the returned version, and send `BOOKMARK` events that only advance the cursor [3]. CloudEvents makes `source` + `id` unique per event so consumers can drop duplicates [4]. The IETF idempotency key draft has the client pick a unique key per request and forbids reusing it with a different payload [5]. We restate these ideas in our own terms (0015).

## Decision

### 1. Three kinds of message

| Kind | Direction | Changes facts | Purpose |
|---|---|---|---|
| **Command** | client to engine | yes | The only way to act. Gets exactly one reply |
| **Read** | client to engine | never | Small read surface: handshake, snapshots, detail, output ranges, command descriptions, daemon status, subscriptions |
| **Event** | engine to client | no (reports facts already stored) | Ordered, replayable stream per office, plus one software stream |

Rule: a command writes facts and change-log entries in one transaction, then replies. Effects that take time (a worker running) arrive later as events. No client ever reads engine tables, imports `engine`, or derives status itself.

### 2. Ids

All ids are branded zod strings. Engine-made ids are a prefix plus a ULID (sortable by time). Story ids are the Backlog.md ids unchanged.

```ts
OfficeId    = "off_<ulid>"         // assigned when an office is first opened
StoryId     = "DIPO-2" | "DRAFT-3" // Backlog.md id, scoped by office; DRAFT-n is provisional (below)
StoryKey    = "sto_<ulid>"         // engine-made, stable for the story's whole life
RunId       = "run_<ulid>"         // one attempt at one story
AgentId     = "agt_<ulid>"         // one worker session; a reassign makes a new one
RoleId      = "developer"          // role name from the office roster (one built-in role until M4)
GateId      = "gat_<ulid>"         // one occurrence of a gate on a run
QuestionId  = "qst_<ulid>"         // one question a worker asked
TestId      = "tst_<ulid>"         // one acceptance-test session
RequestId   = "<ulid>"             // client-made, one per command or read (idempotency key for commands)
Cursor      = { stream: "office:<OfficeId>" | "software", epoch: string, seq: number }
```

`epoch` is random per change log. If an office's state is recreated or restored, its epoch changes and old cursors are rejected instead of silently matching new positions.

**Provisional story ids.** A draft uses Backlog.md's draft feature and has a temporary `DRAFT-n` id. `refine` promotes it to a real `DIPO-n` id, rewrites `DRAFT-n` references and assigns the branch (0012 section 2). A `StoryId` is stable only from Refined on.

- The engine gives each story a `StoryKey` when it first sees it, draft or not. The key never changes; facts, the change log and idempotency records refer to it. `StoryView` and every event that names a story carry both `story` (the Backlog.md id at the time of the fact) and `key`. Clients index stories by `key`; `story` is for display and for typing commands.
- **Resolving `story` in a command:** a key resolves directly. An id resolves first as a current id, then through the alias table of former ids. If an id matches a current story and a different story's alias, or two aliases, the command fails with `story.ambiguous`. An alias is retired as soon as its id becomes the current id of another story, so a reused `DRAFT-n` never reaches the old story.
- Promotion through the engine writes the fact and emits `story.renumbered { key, from, to, detectedBy: "engine" }` in the same transaction, before `story.state` Draft to Refined.
- **Changes outside the engine** are found by reconcile or `office.rescan`. Whenever reconcile sees a known id it checks identity: the StoryKey from the state database (0010: the key is never stored in the repository), then, after a database loss, the frozen branch (0012 F15, from Refined on), then the created date (the only check for a draft). A title change alone is an edit, never a new identity. A vanished id matched to a new one (hand promotion, or a hand demotion, which 0012 forbids the engine to do) emits `story.renumbered { ..., detectedBy: "reconcile" }`. A known id whose identity no longer matches, or a vanished id with no match, closes the old key (`story.state` to `Removed`), gives the story now under that id a new key, and emits `engine.notice`. The engine never guesses silently (0001).
- **Removed observed by reconcile** may come from any state, including In Progress or In Review. It is an observation of what happened in Backlog.md, not an engine transition, so the 0012 transition table does not limit it. If the story had a run, the engine stops its worker as in 0006 decision 8 and the run ends.

### 3. Envelopes and frames

```ts
const CommandRequest = z.object({
  requestId: RequestId,
  office: OfficeId.optional(),           // required on office-level commands; software-level ones
                                         // (office.open, office.forget, daemon.*) omit it and name an office in args
  name: CommandName,                     // e.g. "work.pause"
  args: z.unknown(),                     // validated against the schema for `name`
  origin: z.enum(["cli", "tui", "conversation", "web", "other"]),
  confirmed: z.boolean().default(false), // see section 9
});
const ReadRequest = z.object({ requestId: RequestId, name: ReadName, args: z.unknown() });

const CommandReply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true),  requestId: RequestId, result: z.unknown(),
             changed: z.boolean(), cursor: Cursor.optional() }),   // position of the last entry written
  z.object({ ok: z.literal(false), requestId: RequestId, error: EngineError }),
]);
const ReadReply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true),  requestId: RequestId, result: z.unknown() }),
  z.object({ ok: z.literal(false), requestId: RequestId, error: EngineError }),
]);

const Event = z.object({
  cursor: Cursor,                        // ordered within the stream; unique except for derived events (section 5)
  at: z.iso.datetime(),                  // when the fact was stored
  type: EventType,                       // e.g. "work.phase"
  causedBy: RequestId.optional(),        // command that led to it, if any
  data: z.unknown(),                     // schema chosen by `type`
});
```

`changed: false` means the command was valid but the state already matched (pausing a paused story). A client that wants read-your-writes waits until its stream passes the reply's `cursor`. The engine keeps no per-connection state: a missing `office` on an office-level command is `args.invalid`, never a fallback to an "active" office.

**Frames.** The contract defines one frame envelope that any transport carries, one frame per message (0006 section 9 maps it onto WebSocket):

```ts
const ClientFrame = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auth"), requestId: RequestId,      // first frame on the browser listener (0006 decision 11)
             code: z.string().optional(),                        // single-use bootstrap code, exchanged for a session token
             token: z.string().optional() })                     // session token on later connections
    .refine((f) => (f.code === undefined) !== (f.token === undefined),
            { message: "auth needs exactly one of code or token" }),
  z.object({ kind: z.literal("command"), ...CommandRequest.shape }),
  z.object({ kind: z.literal("read"), ...ReadRequest.shape }),
  z.object({ kind: z.literal("subscribe"), requestId: RequestId, stream: Cursor.shape.stream,
             after: Cursor.optional(), filter: z.array(z.string()).optional() }),   // filter = event type prefixes
  z.object({ kind: z.literal("unsubscribe"), stream: Cursor.shape.stream }),
]);
const ServerFrame = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reply"), reply: z.union([CommandReply, ReadReply]) }),   // matched by requestId, any order
  z.object({ kind: z.literal("events"), events: z.array(Event).min(1) }),              // routed by cursor.stream
]);
```

`subscribe` gets a `reply`: ok with `{ stream, from: Cursor }`, or an error `stream.resetRequired` with `details: { oldest: Cursor }` (section 8). `auth` gets a `reply`: ok with `{ session?: { token: string } }`, or the error `auth.failed` (not retryable), after which 0006 closes the connection. After a code exchange the ok reply always carries the new session token; this reply frame is the only place the token travels to a browser (0006 decision 11). After a token `auth` it carries no `session`. The code (from `daemon.webBootstrap`) is revoked on first use; token lifetime (memory only, revoked on daemon restart or after 12 h unused) is 0006's.

### 4. Commands

Every command below is in contract 1.0. `StoryRef = { story: StoryId | StoryKey }` (section 2). Transitions follow 0012 section 2; the engine refuses any other.

| Command | Args | Result | Specific errors |
|---|---|---|---|
| `office.open` | `{ path: string }` | `{ office: OfficeId, registered: boolean }` (`registered` true when new) | `office.notProject`, `office.pathMissing` |
| `office.forget` | `{ office: OfficeId }` | `{ office }` removes it from the office list; never deletes repository data (0006) | `office.unknown`, `office.busy` (active runs) |
| `office.switch` | `{ office: OfficeId }` | Switching changes no engine fact, so it is a **read** (section 7), listed here for completeness. The client keeps the chosen office and sends it on every command | `office.unknown` |
| `office.rescan` | `{}` | `{ scan: "started" }` | `scan.running` |
| `work.run` | `{ stories?: (StoryId \| StoryKey)[], maxAgents?: number }` (omit `stories` = engine picks from the Ready queue) | `{ started: { story, key, run }[], skipped: { story, key, reason: SkipReason }[] }`. Per-story problems are skips, not command errors. A failed pickup re-check (R01b) also emits `story.state` to Refined with the gate output | `scheduling.off` (retryable) |
| `gate.approve` | `{ gate: GateId, note?: string }` | `{ gate, decision: "approved" }` | `gate.closed` |
| `gate.reject` | `{ gate: GateId, note: string }` (note becomes worker input) | `{ gate, decision: "rejected" }` | `gate.closed` |
| `work.answer` | `{ question: QuestionId, text: string }` | `{ question, delivered: "now" \| "on-resume" }` | `question.closed` |
| `work.steer` | `StoryRef & { text: string }` | `{ run, delivered: "next-turn" }` | `story.notRunning` |
| `work.pause` | `StoryRef` | `{ run }` worker held at its next safe point | `story.notRunning` |
| `work.resume` | `StoryRef & { note?: string }` | `{ story, key, to: Lifecycle, run?: RunId }`. A paused run continues. A parked story returns to `park.from`: to In Progress or In Review it starts or re-attaches a run, returns `run` and emits `work.assigned`; to Refined or Ready (for example after `on-hold`) no run starts, and a story back in Ready is re-checked at pickup (R01b) by `work.run` | `story.notPausedOrParked`, `run.hostAlive` (retryable), `scheduling.off` (retryable) |
| `story.hold` | `StoryRef & { note: string }` | `{ story, key }` parks a Refined or Ready story with reason `on-hold` (0012); `work.run` skips it; it shows in the triage list | `story.notHoldable` |
| `work.reassign` | `StoryRef & { role?: RoleId, tier?: Tier }` | `{ run, agent: AgentId }` new agent, bounded handoff (idea 15). Reassign first stops the old agent through the adapter; if the old worker host has not exited (exit file written, 0006 decision 8) within 30 s (proposed default; 0006 states the same timeout) the command fails with `run.hostAlive` and the new agent is not started | `role.unknown`, `story.notRunning`, `run.hostAlive` (retryable) |
| `work.stop` | `StoryRef & { note?: string }` | `{ run }` worker ends; branch and worktree kept; the story parks with reason `stopped` and `park.from` In Progress or In Review. `work.resume` continues it (open question 1, answered) | `story.notRunning` |
| `work.discard` | `StoryRef & { note: string }` | `{ story, key }`: ends the run if one is active (as `work.stop`), removes the worktree and deletes the story branch, keeps the story and returns it to Refined, so it must pass the Ready gate again. Allowed from In Progress, In Review and Parked | `story.notDiscardable`, `run.hostAlive` |
| `story.drop` | `StoryRef & { deleteBranch: boolean }` | `{ story, key }` archives a Draft, Refined, Ready or Parked story (`backlog task archive`, or archive the draft), removes its worktree if any, deletes the branch only when asked; `story.state` to `Removed` | `story.hasDependents`, `story.active` (In Progress or In Review: stop first) |
| `test.start` | `StoryRef` | `{ test: TestId, checkout: string, script: string[] }` | `story.notTestable` (no manual test plan entry, 0002, 0012 F14) |
| `test.record` | `{ test: TestId, result: "pass" \| "fail", note?: string }` (note required on fail) | `{ test, result }`; a fail sends the story from In Review back to In Progress with the note as worker input | `test.closed` |
| `daemon.stop` | `{ stopWorkers: boolean }` | `{ state: "draining" }` (0006 section 5) | none |
| `daemon.setLogLevel` | `{ level: "error" \| "warn" \| "info" \| "debug" \| "trace" }` | `{ level }` until restart | none |
| `daemon.resumeScheduling` | `{}` | `{ state: DaemonState }` leaves `safe` | `daemon.notSafe` |
| `daemon.webBootstrap` | `{}` | `{ url: string, code: string }`: a random single-use bootstrap code valid for 60 s, and the loopback URL to open with it (0006 decision 11). Starts the loopback listener if it is off. Accepted only on the Unix socket connection; on the loopback listener it fails with `not.permitted` | `not.permitted` |

`SkipReason = "parked" | "notReady" | "notRunnable" | "dependency" | "collision" | "capacity" | "pickupCheckFailed"` (closed enum; `notRunnable` covers states run never picks, such as Draft, In Progress or Done; `capacity` means `maxAgents` or the office cap was reached). An unknown story in `stories` is `story.unknown` for the whole command.

Commands marked `confirm: true` in `commands.describe`, so every client asks first: `gate.reject`, `work.stop`, `work.discard`, `story.drop`, `work.reassign`, `office.forget`, `daemon.stop`. Later minor additions under the same envelope: in M3 `plan`, `refine`, `ready`, `unready`, `amend`, `estimate`, `review`, `retro` (0001, 0012), in M4 roster commands. Once `story.amend` exists, `story.parked.actions` includes it.

### 5. Events

Every event about running work carries one `WorkRef`, so the overview shows who works on what without extra reads (AC 6).

```ts
// Owned elsewhere, restated minimally so the contract is complete:
const Lifecycle  = z.enum(["Draft", "Refined", "Ready", "In Progress", "In Review", "Done", "Parked", "Removed"]);
  // 0012 states. Draft stories carry provisional DRAFT-n ids. Removed is engine-only, not a Backlog.md status:
  // the terminal state of an archived or deleted story. Joint decision with DIPO-8: 0012 records it as
  // an engine-only terminal state. Closed enum
const ParkReason = z.enum(["ambiguous-spec", "verify-failing", "conflict", "scope-violation",
                           "review-blocked", "budget-exceeded", "on-hold", "stopped", "interrupted",
                           "needs-permission", "worker-failed"]);   // 0001, 0012, plus stopped (maintainer ended the worker), interrupted (worker lost while the daemon was down, 0006), needs-permission and worker-failed (0008). Closed enum
const Tier       = z.enum(["S", "M", "L"]);                                    // 0012 F11 (office config). Closed enum
const DaemonState = z.enum(["starting", "recovering", "running", "draining", "safe"]);   // 0006 section 7

const WorkRef  = z.object({ story: StoryId, key: StoryKey, run: RunId, agent: AgentId, role: RoleId, tier: Tier, model: z.string() });
const Phase    = z.string();  // provisional open enum: "preparing", "implementing", "verifying", "reviewing",
                              // "awaiting-test", "merging". DIPO-6 sets the final names
const Progress = z.object({ criteriaMet: z.int(), criteriaTotal: z.int(), loop: z.int(), loopCap: z.int(),
                            verify: z.enum(["none", "passing", "failing"]), reviewRound: z.int() });
const UsageTotals = z.object({ inputTokens: z.int(), outputTokens: z.int(),
                               cacheCreateTokens: z.int(), cacheReadTokens: z.int(), turns: z.int(),
                               elapsedMs: z.int(), estimatedCost: z.number().optional() });
const Usage    = z.object({ agent: UsageTotals,  // cumulative for this agent within this run
                            run: UsageTotals,    // cumulative for the run across all its agents
                            budget: z.object({ unit: z.string(), limit: z.number(), used: z.number() }) });
                            // unit "tokens": used = input + output + cache creation; cache reads do not count (0008)

const StoryView = z.object({ key: StoryKey, story: StoryId, provisional: z.boolean(), title: z.string(),
                             lifecycle: Lifecycle, tier: Tier.optional(), column: z.string(),   // derived
                             work: WorkRef.optional(),
                             parked: z.object({ reason: ParkReason, detail: z.string(), from: Lifecycle,
                                                since: z.iso.datetime() }).optional() });
const WorkView  = z.object({ work: WorkRef, phase: Phase, progress: Progress, usage: Usage,
                             health: z.string(), startedAt: z.iso.datetime() });   // health names: DIPO-6
const GateKind  = z.enum(["review", "test", "merge"]);   // open enum
const GateView  = z.object({ gate: GateId, work: WorkRef, kind: GateKind, waitingOn: z.enum(["maintainer", "rule"]), summary: z.string() });
const QuestionView = z.object({ question: QuestionId, work: WorkRef, text: z.string(), askedAt: z.iso.datetime() });
const TestView  = z.object({ test: TestId, story: StoryId, key: StoryKey, checkout: z.string(), startedAt: z.iso.datetime() });
const OfficeSummary = z.object({ office: OfficeId, name: z.string(), path: z.string(),
                                 running: z.int(), parked: z.int(),   // parked includes on-hold
                                 onHold: z.int(),                     // subset of parked
                                 waitingOnMaintainer: z.int() });     // open gates, questions, tests, parked other than on-hold
```

There is no budget gate: a budget overrun parks the story with `budget-exceeded` (0001, 0011). Usage carries agent and run totals, so after `work.reassign` usage stays attributable per story, role and tier.

| Event | Stream | Data | Notes |
|---|---|---|---|
| `office.registered` | software | `{ office, path, name }` | |
| `office.forgotten` | software | `{ office }` | |
| `office.summary` | software | `OfficeSummary` | derived, see below |
| `daemon.state` | software | `{ from: DaemonState, to: DaemonState, reason?: string }` | e.g. `safe` after a crash loop (0006) |
| `scan.finished` | office | `{ scripts: Record<string, string>, warnings: string[] }` | run knowledge, shape owned by DIPO-9 |
| `story.state` | office | `{ story, key, from: Lifecycle, to: Lifecycle, view: StoryView, detail?: string[] }` | `detail` holds gate failure messages, e.g. a failed pickup re-check |
| `story.renumbered` | office | `{ key, from: StoryId, to: StoryId, detectedBy: "engine" \| "reconcile" }` | same transaction as the fact (section 2) |
| `work.assigned` | office | `{ work: WorkRef }` | run start, re-attach on resume, reassign |
| `work.phase` | office | `{ work: WorkRef, phase: Phase, progress: Progress }` | |
| `work.progress` | office | `{ work: WorkRef, progress: Progress }` | debounced, latest wins |
| `work.output` | office | `{ work: WorkRef, source: "worker" \| "verify" \| "script", from: int, to: int, text: string }` | byte range in the stored output |
| `work.observed` | office | `{ work: WorkRef, signal: string, since }` | watchdog facts; provisional open enum (`silent`, `repeating-failure`, `waiting-input`), names set by DIPO-6 |
| `usage.updated` | office | `{ work: WorkRef, usage: Usage }` | cumulative, so a duplicate or skipped one is harmless |
| `gate.reached` | office | `GateView` | |
| `gate.decided` | office | `{ gate, decision: "approved" \| "rejected", by: "maintainer" \| "rule", note? }` | |
| `question.asked` | office | `QuestionView` | answered with `work.answer` |
| `question.closed` | office | `{ question, answer? }` | |
| `story.parked` | office | `{ story, key, work?: WorkRef, reason: ParkReason, detail: string, from: Lifecycle, lastGoodCommit?: string, actions: CommandName[] }` | `work` absent for `on-hold`; `detail` is the hold note. `actions` lists commands a client may offer: `work.resume`, `story.drop` (and `story.amend` from M3). Sent with `story.state` to Parked |
| `test.started` / `test.recorded` | office | `TestView` / `{ test, story, key, result, note? }` | |
| `engine.notice` | both | `{ level: "info" \| "warn" \| "error", code: string, text: string }` | e.g. reconcile mismatches (0001), `engine.recovering` |
| `stream.mark` | both | `{ caughtUp?: boolean }` | derived, see below. Heartbeat when idle; end of catch-up when `caughtUp` |

**Derived events** (`stream.mark`, `office.summary`) are not stored facts. They never consume a seq: their cursor repeats the last stored seq, they are exempt from duplicate dropping, and they are not replayed. After catch-up the engine sends the current `office.summary` for every office, and later ones debounced on change.

### 6. Facts in, status derived, change log out

- The engine stores **facts** only (a phase began, a gate was decided, tokens were counted). Display status, overview column and health are **derived** by engine code, never stored as truth (idea 1).
- Each fact write appends one **change-log entry** in the same SQLite transaction: stream, seq (gap-free, monotonic), fact delta, and the derived `view` at that moment. The log is an outbox: disposable, never read back for decisions. Table layout and retention are DIPO-4's.
- Events are change-log entries rendered into the current contract at send time. A contract change rewrites the renderer, not the stored log.
- **Debounce before the log, batch after it.** High-rate sources are coalesced before they become facts: worker output flushes per run every 250 ms or 16 KiB; progress and usage at most once per second per run (defaults; DIPO-4 confirms them). State changes, gates, questions and parks are written at once, after flushing pending output for the same run, so order stays causal. The transport may pack several events into one `events` frame. The stream carries deltas for the subject that changed, never full state, and seq stays gap-free for loss detection (idea 21).
- **Software stream.** Office list and daemon events are not office facts. The daemon keeps them in an in-memory ring buffer (owner DIPO-3, 0006) with a new epoch at every daemon start. A client reconnecting after a restart gets `stream.resetRequired` and re-reads `engine.hello`. Losing this history is harmless: the office list itself is the `offices` table in the central database (0007).

### 7. Read surface and capability flags

| Read | Args | Returns |
|---|---|---|
| `engine.hello` | `{ contract: { major, minor }, client: { name, version } }` | `{ engine: version, contract: { major, minor }, capabilities: string[], daemon: DaemonState, offices: OfficeSummary[], cursor }`; `cursor` is the software stream position read together with `offices` |
| `office.snapshot` / `office.switch` | `{ office }` | `{ cursor, stories: StoryView[], work: WorkView[], gates: GateView[], questions: QuestionView[], tests: TestView[] }` derived, consistent with `cursor` |
| `story.detail` | `{ office, story }` | facts and derived view for one story, including past runs and verdicts |
| `work.outputRange` | `{ office, run, source, from, to? }` | stored output text for a byte range |
| `commands.describe` | `{}` | every command: name, JSON Schema of args and result (`z.toJSONSchema`), `confirm`, `since` minor version |
| `daemon.status` | `{}` | `{ state: DaemonState, stateReason?: string, pid, version, uptimeMs, socket, webUrl?, loadedOffices: OfficeId[], activeRuns: int, keepAwake: { held: boolean, reason?: string }, upgradePending: boolean }` (0006 section 5) |

Subscriptions (`subscribe`, `unsubscribe`) are reads too: they change no facts (section 3, section 8).

Capability flags are short strings a client checks before showing a feature, for example `replay`, `work.output`, `work.intervene`, `test.sessions`, `usage.cost`, `daemon.control`, `daemon.logLevel`, `rituals`, `roster`. A missing flag means hide or disable, never fail. Clients ignore unknown event types and unknown open-enum values, so an older client keeps working against a newer engine (idea 10).

### 8. Late attach, reconnect and replay

1. **First attach:** `engine.hello`, then `subscribe { stream: "software", after: hello.cursor }`. For an office: `office.snapshot` (one SQLite read transaction, so view and cursor match), then `subscribe { stream: "office:<id>", after: snapshot.cursor }`. No gap on either stream.
2. **Reconnect:** `subscribe` with `after` = last cursor seen. The engine replays stored entries with a higher seq, sends `stream.mark { caughtUp: true }`, then live events.
3. **Too old or wrong epoch:** the `subscribe` reply is the error `stream.resetRequired` with `details: { oldest }`. The client drops its local view and goes back to step 1 (pattern from [3]).
4. **Idle:** `stream.mark` every 15 s keeps the cursor fresh and lets both sides detect a dead connection.
5. **Filters:** `filter` names event type prefixes (for example to skip `work.output`); the client fetches output later with `work.outputRange`.
6. **Delivery:** at least once. Clients drop stored events whose cursor they already have (`stream` + `epoch` + `seq`, as `source` + `id` in [4]); derived events are exempt.
7. **Retention:** the office replay window is a default DIPO-4 sets (open question 3).

With SSE `after` would travel as the last event id [1]; 0006 carries it in the `subscribe` frame [2].

### 9. Idempotency, privacy, authorization and the conversation layer

- **Idempotency.** The engine stores `requestId`, a hash of the args and the reply in the same transaction as the facts, kept 24 h. The hash is taken after story references are resolved to `StoryKey`, so a retry that names a story by its former `DRAFT-n` id matches. A repeat with the same id and hash returns the stored reply without running again; the same id with another hash fails with `request.reused` [5]. Software-level commands (`office.open`, `office.forget`, `daemon.*`) have no office database, so the daemon keeps their records in its own request table, in memory for the daemon's lifetime (24 h cap). Its scope is one daemon run: a retry that crosses a daemon restart runs again, which is safe because these commands are target-state (opening a registered office, forgetting a forgotten one, stopping a draining daemon all reply `changed: false`). `daemon.webBootstrap` is the exception: its reply is never stored, so a retry always gets a new code (0006 decision 13). Commands are also target-state where possible (pause a paused story: `changed: false`). Gate, question and test commands name the exact occurrence, so a stale screen cannot approve the wrong gate.
- **Privacy (research idea 11).** The idempotency record holds the args hash, not the args. Assembled worker prompts are never part of the contract or the change log. Text the maintainer writes (`work.steer`, `work.answer`, `gate.reject`, `story.hold`, `test.record` notes) is a maintainer-authored fact, kept for the audit trail and as worker input. Retention and any opt-in for storing more follow DIPO-4.
- **Authorization.** One local maintainer. Any connection the transport accepts (0006: runtime directory permissions, or the browser session token sent in the `auth` frame or as a Bearer header) may send every command, except `daemon.webBootstrap`, which only the Unix socket accepts. `origin` and `client.name` are recorded for the audit trail, not for permission. `not.permitted` is reserved for a future read-only remote view.
- **Conversation layer (M5).** A client like any other. Its tool list is `commands.describe`; it cannot call anything not there. Every command it proposes is shown to the maintainer and sent with `origin: "conversation"` and `confirmed: true` only after the maintainer agrees. The engine refuses `origin: "conversation"` without `confirmed` (`confirmation.required`). This guards against a careless client; it is not a security boundary.

### 10. Errors

```ts
const EngineError = z.object({
  code: z.string(),                // open set, dotted: "story.notRunning", "args.invalid", ...
  message: z.string(),             // one sentence for people
  retryable: z.boolean(),          // true only when the same request may succeed later
  details: z.unknown().optional(), // e.g. zod issues for args.invalid, { oldest } for stream.resetRequired
});
```

Generic codes: `contract.unsupported`, `args.invalid`, `office.unknown`, `story.unknown`, `story.ambiguous`, `capability.missing`, `request.reused`, `confirmation.required`, `not.permitted`, `auth.failed`, `stream.resetRequired`, `internal`. Retryable codes: `engine.recovering` (daemon in `starting` or `recovering`; office commands and reads wait for `daemon.state` to `running`), `scheduling.off` (daemon in `safe`; commands that would schedule work, such as `work.run` or resume to In Progress, wait for `daemon.resumeScheduling`), and `run.hostAlive` (`work.resume` or `work.reassign` refused while the story's old worker host PID is still alive; 0006 decision 8 never restarts a run under a live host). Command-specific codes are in section 4. Codes are part of the contract; messages are not. The shape follows JSON-RPC's error object (code, message, data) [6], with dotted string codes so they read in logs.

### 11. Versioning

- The contract has `MAJOR.MINOR`, exported from `packages/contract`, independent of the binary version.
- **Same major means compatible.** A client and engine with the same major always work together; features one side lacks are hidden through capability flags, never through errors. 0006 relies on this rule for upgrades.
- **Minor** changes are additive only: a new command, read, event type, frame field, optional field, capability flag or open-enum value. Closed enums (lifecycle, park reasons, skip reasons, gate decisions, daemon states) change only in a major.
- **Major** changes rename, remove or change meaning. `engine.hello` fails with `contract.unsupported` when majors differ; client and daemon ship in one binary, so this means a daemon left running across an upgrade (0006 section 14).
- Replayed events are always rendered in the engine's current contract, so a client never sees two shapes for one event type.
- **Frozen minimal surface.** So `dipo daemon restart` works across a major upgrade, a few shapes never change in any major: the frame envelope fields `kind` and `requestId`, the `reply` frame with `ok` and `EngineError` (`code`, `message`, `retryable`, `details`), the `engine.hello` request and its `contract.unsupported` error (whose `details` carry the daemon's `{ contract: { major, minor }, version }`), the `daemon.status` fields `state`, `pid` and `version`, and `daemon.stop { stopWorkers }`. A daemon accepts these from a client of any major; everything else needs the same major. 0006 section 14 uses this surface for the restart.

### 12. No client needs engine internals

A client needs only `@dipsaus-orchestrator/contract` (schemas, frames, types, JSON Schema) and `@dipsaus-orchestrator/client` (transport). Derived views come from the engine in snapshots and events, the command list from `commands.describe`, features from capability flags, daemon state from `daemon.status`. The import ban in 0004 enforces the rest.

## Consequences

- One contract for CLI, TUI, conversation, daemon control and later UIs; a visual client is a pure function of snapshot plus events.
- The engine pays for an extra append per fact write and a renderer per event type. Small next to worker cost.
- Seq-based replay needs log retention; DIPO-4 sizes it. Clients must handle `stream.resetRequired`, on the software stream after every daemon restart.
- Debouncing adds up to 1 s latency on usage and progress and 250 ms on output. State changes are never delayed.
- Status rules live in one place (engine), so changing a rule changes every client at once.
- Adding a ritual or roster command later is a minor contract change, not a new interface.
- Owners: 0006 (DIPO-3) carries the frames, connection auth and the in-memory software stream. DIPO-4 provides fact tables, the office change log with epoch and seq, the request table, and story keys with the alias table. 0012 (DIPO-8) owns Lifecycle, Tier, ParkReason additions and draft promotion; this contract follows it. DIPO-5 feeds usage and questions. DIPO-6 names phases and health signals.

## Open questions for the maintainer

1. **`work.stop` outcome — answered 2026-10-10: two new park reasons.** `stopped` when the maintainer ends a worker, `interrupted` when a worker was lost while the daemon was down (0006 open question 3). Both park the story with `park.from` In Progress or In Review, show in the triage list, and `work.resume` continues or restarts the run. Amends the park reasons of 0001 and 0012.
2. **Discard the run — answered 2026-10-10: yes, `work.discard`.** Throws away the work (worktree and branch) and returns the story to Refined; it goes through the Ready gate again. Adds a transition In Progress, In Review or Parked to Refined in 0012.
3. **Retention — answered 2026-10-10: tiered.** State-change events (lifecycle, park, gates, verdicts, test results, renumbering) are kept long (default 1 year). Usage and progress updates are kept short (default 7 days); final usage totals per run are stored as facts and kept. Worker output is kept short (default 7 days); at run end code builds a run summary with no model call (the worker's final report, diffstat, verify result, last 50 output lines) which is kept as long as state changes. A client whose cursor is older than the short tier gets a snapshot, not a full replay. All periods are office configuration; DIPO-4 sizes and implements the tiers.
4. **Derived views — answered 2026-10-10: in the engine only.** Clients receive ready views (stuck, budget share, waiting on the maintainer, phase) and never compute status themselves, so every client shows the same thing; `contract` stays schemas-only (0004).
5. **Debounce — answered 2026-10-10: accepted as defaults** (output every 250 ms or 16 KiB, usage and progress at most 1 per second per run, state changes immediately), tunable in office configuration.
6. **Phase and signal names — answered 2026-10-10: provisional here, final names set by DIPO-6** (the overview spike), where they are designed for display. Renames before 1.0 are free.
7. **Changes outside the engine — answered 2026-10-10: automatic, with a notice.** Reconcile matches by StoryKey from the database, then frozen branch, then created date (0010); a title change alone is an edit. An unmatched key is closed as Removed with an `engine.notice`; if a run was active, its worker is stopped (0006 decision 8) and the notice says so.

## Sources

1. WHATWG HTML Living Standard, Server-sent events (`id` field, last event ID, `Last-Event-ID` on reconnect; no replay defined). https://html.spec.whatwg.org/multipage/server-sent-events.html
2. websocket.org, WebSocket reconnection: state sync and recovery (sequence numbers, bounded replay buffer, at-least-once with deduplication). https://websocket.org/guides/reconnection/
3. Kubernetes docs, API concepts: efficient detection of changes, `410 Gone`, watch bookmarks. https://kubernetes.io/docs/reference/using-api/api-concepts/
4. CloudEvents specification (`source` + `id` unique per event; duplicates may be dropped). https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md
5. IETF draft-ietf-httpapi-idempotency-key-header-07, The Idempotency-Key HTTP Header Field (October 2025; an Internet-Draft that expired 2026-04-18, used for the pattern only, not as a standard). https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
6. JSON-RPC 2.0 specification (client-chosen request id; error object with code, message, data). https://www.jsonrpc.org/specification
7. Zod 4 API (`z.discriminatedUnion`, `z.literal`). https://zod.dev/api ; JSON Schema export: https://zod.dev/json-schema
8. Research ideas 1, 10, 11, 15, 21: `docs/research/2026-10-comparable-tools.md`. ADR 0012 (DIPO-8) section 2, accepted on main (includes `Removed` and `on-hold`). ADR 0006 (DIPO-3) decisions 4 to 11 and 14, Proposed.

## Amendments

- 2026-10-10, decision 0010 (maintainer): the StoryKey lives only in the state database, never in the repository; identity after a database loss falls back to the frozen branch, then the created date.
- 2026-10-10, decision 0008 (maintainer): two new park reasons, `needs-permission` (the worker cannot finish without an action that was denied; worktree, branch and session are kept) and `worker-failed` (the worker crashed again after one resume, or failed its init checks: `apiKeySource`, model; detail is the last error). `Usage.budget` uses unit `"tokens"` (input + output + cache creation); `UsageTotals.cacheTokens` splits into `cacheCreateTokens` and `cacheReadTokens`. Minor additions: `QuestionView.kind` (`question` or `permission`) and `work.answer` `decision: "allow" | "deny"` for permission questions.
- 2026-10-10, decision 0007 (maintainer): the office list is the `offices` table in the central state database, not `offices.json`.
