// Example messages for the contract tests. Plain data on purpose: each one must earn its pass by
// parsing, not by type-checking. Every new contract shape adds a fixture here (DIPO-15 rule).

const ULID = "01J9ZK5Q8W3V4X6Y7Z8A9B0C1D";
const ULID2 = "01J9ZK5Q8W3V4X6Y7Z8A9B0C2E";

export const ids = {
  office: `off_${ULID}`,
  storyKey: `sto_${ULID}`,
  run: `run_${ULID}`,
  agent: `agt_${ULID}`,
  gate: `gat_${ULID}`,
  question: `qst_${ULID}`,
  test: `tst_${ULID}`,
  request: ULID,
  request2: ULID2,
  proposal: "3f".repeat(32),
};

export const softwareCursor = { stream: "software", epoch: "e1", seq: 42 };
export const officeCursor = { stream: `office:${ids.office}`, epoch: "e2", seq: 7 };

export const officeSummary = {
  office: ids.office,
  name: "dipsaus-orchestrator",
  path: "/Users/me/code/dipsaus-orchestrator",
  running: 1,
  parked: 2,
  waitingOnMaintainer: 1,
  optIns: ["privacy.storeCommandBodies"],
  ready: 2,
  outputRetentionDays: 7,
  privacy: [
    { key: "privacy.storePrompts", value: true, source: "default" },
    { key: "privacy.storeCommandBodies", value: false, source: "office.local.yaml" },
    { key: "privacy.keepRawEvents", value: false, source: "default" },
  ],
};

// The story and work model.

export const workRef = {
  story: "DIPO-21",
  key: ids.storyKey,
  run: ids.run,
  agent: ids.agent,
  role: "developer",
  tier: "M",
  model: "claude-sonnet",
};

export const progress = {
  criteriaMet: 4,
  criteriaTotal: 7,
  loop: 2,
  loopCap: 5,
  verify: "passing",
  reviewRound: 0,
};

const agentTotals = {
  inputTokens: 210_000,
  outputTokens: 18_000,
  cacheCreateTokens: 6_000,
  cacheReadTokens: 1_100_000,
  turns: 31,
  elapsedMs: 2_280_000,
  estimatedCost: 0.84,
};

export const usage = {
  agent: agentTotals,
  run: { ...agentTotals, turns: 40 },
  budget: { unit: "tokens", limit: 300_000, used: 234_000 },
  budgetShare: 0.78,
};

export const storyView = {
  key: ids.storyKey,
  story: "DIPO-21",
  provisional: false,
  title: "Stream worker events to the TUI",
  lifecycle: "In Progress",
  tier: "M",
  column: "running",
  work: workRef,
  evidence: { "work.model": "checked" },
};

export const parkedStoryView = {
  key: ids.storyKey,
  story: "DIPO-29",
  provisional: false,
  title: "Web client shell",
  lifecycle: "Parked",
  tier: "L",
  column: "desk",
  parked: {
    reason: "by-maintainer",
    detail: "after M2",
    from: "Ready",
    since: "2026-10-09T10:00:00Z",
  },
};

export const waitingStoryView = {
  key: ids.storyKey,
  story: "DIPO-31",
  provisional: false,
  title: "Cost view",
  lifecycle: "Ready",
  tier: "M",
  column: "waiting",
  waitingOn: ["DIPO-21"],
};

export const refinedStoryView = {
  key: ids.storyKey,
  story: "DIPO-33",
  provisional: false,
  title: "Office forget flow",
  lifecycle: "Refined",
  column: "refined",
  gateMessages: [
    'ready DIPO-33 failed R15: 2 unknowns open or resolved without an answer: "Keep…"',
  ],
  gateFailures: [
    {
      rule: "R15",
      message: 'ready DIPO-33 failed R15: 2 unknowns open or resolved without an answer: "Keep…"',
      text: '2 unknowns open or resolved without an answer: "Keep…"',
    },
  ],
};

export const workView = {
  work: workRef,
  phase: "build",
  progress,
  usage,
  health: "busy",
  lastOutputAt: "2026-10-12T09:00:30Z",
  startedAt: "2026-10-12T08:22:00Z",
  evidence: { "progress.criteriaMet": "claimed", "usage.agent.estimatedCost": "estimated" },
};

export const gateView = {
  gate: ids.gate,
  work: workRef,
  kind: "merge",
  waitingOn: "maintainer",
  summary: "reviewer passed, test passed",
};

export const questionView = {
  question: ids.question,
  work: workRef,
  kind: "permission",
  text: "Bash(docker compose up)",
  askedAt: "2026-10-12T09:02:00Z",
};

export const testView = {
  test: ids.test,
  story: "DIPO-15",
  key: ids.storyKey,
  checkout: "dipo-tst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
  head: "4b4171c2a1e3f5d7b9c0e2f4a6b8d0c2e4f6a8b0",
  steps: [{ check: "Press o", expect: "The office switcher opens" }, { check: "Type slay" }],
  url: "http://localhost:52731/",
  shell: "dipo test shell DIPO-15",
  startedAt: "2026-10-12T09:03:00Z",
};

export const officeSnapshot = {
  cursor: officeCursor,
  stories: [storyView, parkedStoryView, waitingStoryView, refinedStoryView],
  work: [workView],
  gates: [gateView],
  questions: [questionView],
  tests: [testView],
};

const officeCommandFixtures: Record<string, { args: unknown; result: unknown }> = {
  "office.infer": { args: {}, result: { infer: "started", capabilities: ["verify", "dev"] } },
  "office.confirm": {
    args: { action: "set", capability: "verify", commands: [["bun", "run", "check"]], cwd: "." },
    result: {
      capability: "verify",
      source: "maintainer",
      confirmed: true,
      diff: [
        "~ verify: unresolved -> bun run check [maintainer, confirmed (set by the maintainer)]",
      ],
    },
  },
  "work.run": {
    args: { stories: ["DIPO-21", ids.storyKey], maxAgents: 1, from: "/work/app" },
    result: {
      started: [{ story: "DIPO-21", key: ids.storyKey, run: ids.run }],
      skipped: [{ story: "DIPO-31", key: ids.storyKey, reason: "dependency" }],
    },
  },
  "work.answer": {
    args: { question: ids.question, text: "Yes, a 404 is fine." },
    result: { question: ids.question, delivered: "on-resume", run: ids.run },
  },
  "work.steer": {
    args: { story: "DIPO-21", text: "Keep the old flag." },
    result: { run: ids.run, delivered: "next-turn" },
  },
  "work.resume": {
    args: { story: "DIPO-21", note: "Dependency merged." },
    result: { story: "DIPO-21", key: ids.storyKey, to: "In Progress", run: ids.run },
  },
  "work.discard": {
    args: { story: "DIPO-21", note: "Wrong approach." },
    result: { story: "DIPO-21", key: ids.storyKey },
  },
  "story.park": {
    args: { story: "DIPO-21", note: "after M2" },
    result: { story: "DIPO-21", key: ids.storyKey, run: ids.run },
  },
  "story.drop": {
    args: { story: "DRAFT-3", deleteBranch: false },
    result: { story: "DRAFT-3", key: ids.storyKey },
  },
  "gate.approve": { args: { gate: ids.gate }, result: { gate: ids.gate, decision: "approved" } },
  "gate.reject": {
    args: { gate: ids.gate, note: "Split the migration." },
    result: { gate: ids.gate, decision: "rejected" },
  },
  "proposal.accept": {
    args: { proposal: ids.proposal.slice(0, 12) },
    result: { proposal: ids.proposal, state: "accepted", draft: "DRAFT-4" },
  },
  "proposal.dismiss": {
    args: { proposal: ids.proposal },
    result: { proposal: ids.proposal, state: "dismissed" },
  },
  "test.start": {
    args: { story: "DIPO-15" },
    result: {
      test: ids.test,
      head: testView.head,
      checkout: testView.checkout,
      steps: testView.steps,
      url: testView.url,
      shell: testView.shell,
    },
  },
  "test.record": {
    args: { test: ids.test, result: "fail", note: "Esc does not go back." },
    result: { test: ids.test, result: "fail" },
  },
};

const officeReadFixtures: Record<string, { args: unknown; result: unknown }> = {
  "office.snapshot": { args: { office: ids.office }, result: officeSnapshot },
  "office.switch": { args: { office: ids.office }, result: officeSnapshot },
  "story.detail": {
    args: { office: ids.office, story: "DIPO-21" },
    result: {
      view: storyView,
      work: workView,
      runs: [
        {
          run: ids.run,
          agents: [ids.agent],
          role: "developer",
          tier: "M",
          model: "claude-sonnet",
          startedAt: "2026-10-12T08:22:00Z",
          usage: agentTotals,
        },
      ],
      verdicts: [
        {
          gate: ids.gate,
          run: ids.run,
          kind: "review",
          decision: "rejected",
          by: "rule",
          note: "blocking finding",
          at: "2026-10-12T08:50:00Z",
        },
        {
          gate: ids.gate,
          kind: "ready",
          decision: "rejected",
          by: "rule",
          failures: ["ready DIPO-21 failed R07: milestone is missing or does not exist"],
          at: "2026-10-12T08:10:00Z",
        },
      ],
      questions: [questionView],
    },
  },
  "work.outputRange": {
    args: { office: ids.office, run: ids.run, source: "verify", from: 0, to: 64 },
    result: { run: ids.run, source: "verify", from: 0, to: 64, text: "FAIL test/retry.test.ts" },
  },
  "work.prompt": {
    args: { office: ids.office, run: ids.run, agent: ids.agent },
    result: {
      run: ids.run,
      agent: ids.agent,
      texts: [
        { part: "system", text: "You are the developer." },
        { part: "message", text: "Story DIPO-21: retry the lookup." },
      ],
    },
  },
  "story.losses": {
    args: { office: ids.office, story: "DIPO-21" },
    result: {
      story: "DIPO-21",
      key: ids.storyKey,
      commits: [{ sha: "3f9a1c2", subject: "feat(DIPO-21): retry the lookup" }],
      files: ["scratch.txt"],
    },
  },
  "story.gate": {
    args: { office: ids.office, story: "DIPO-21" },
    result: {
      story: "DIPO-21",
      key: ids.storyKey,
      passed: false,
      failures: [
        {
          rule: "R07",
          message: "ready DIPO-21 failed R07: milestone is missing or does not exist",
        },
        {
          rule: "R11",
          message: "ready DIPO-21 failed R11: no declared scope; add at least one path with --ref",
        },
      ],
    },
  },
  "office.stats": {
    args: { office: ids.office },
    result: {
      office: ids.office,
      tables: [
        { table: "change_log", rows: 12_400, bytes: 7_900_000 },
        { table: "requests", rows: 31, bytes: 9_300 },
      ],
    },
  },
  "office.profile": {
    args: { office: ids.office },
    result: {
      office: ids.office,
      scanned: true,
      scannedAt: "2026-10-23T10:00:00.000Z",
      commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      fingerprint: "sha256:1f2e",
      level: "partial",
      nothingToStart: false,
      inferring: false,
      runRefusal: 'Verify is unresolved: add a "verify" script to package.json.',
      capabilities: [
        {
          name: "verify",
          status: "unresolved",
          confirmed: false,
          stale: false,
          pending: {
            command: "make check",
            commands: [["make", "check"]],
            cwd: ".",
            confidence: "low",
            modelConfidence: "medium",
            evidence: ["Makefile: target check runs the tests"],
            stale: false,
            run: ids.run,
            proposedAt: "2026-10-23T10:05:00.000Z",
          },
          fix: 'add a "verify" script, so code resolves it and the confirmation can go',
          cli: ["dipo office confirm accept verify", "dipo office confirm reject verify"],
        },
      ],
      deviations: [
        {
          code: "missing-test",
          message: 'No "test" script. Add one: it is required.',
          conflict: false,
          fix: 'add a "test" script',
        },
      ],
    },
  },
  "office.desk": {
    args: { office: ids.office },
    result: [
      {
        kind: "QUESTION",
        story: "DIPO-140",
        key: ids.storyKey,
        question: ids.question,
        detail: '"Keep the old flag?" · worker waiting',
        since: "2026-10-23T10:00:00.000Z",
        blocks: [],
        actions: [{ command: "work.answer", cli: `dipo answer ${ids.question} "<answer>"` }],
      },
      {
        kind: "MERGE",
        story: "DIPO-141",
        key: ids.storyKey,
        gate: ids.gate,
        pr: { number: 7, url: "https://github.com/o/r/pull/7", state: "open" },
        detail: "the release PR",
        since: "2026-10-23T10:00:00.000Z",
        blocks: ["DIPO-142"],
        actions: [],
        hand: "merge PR #7 by hand on GitHub",
      },
    ],
  },
  "work.preview": {
    args: { office: ids.office, stories: ["DIPO-21"] },
    result: {
      refusals: [],
      story: { story: "DIPO-21", key: ids.storyKey },
      skipped: [],
      launch: {
        adapter: "claude-cli",
        branch: "DIPO-21/add-retry",
        runDir: "/home/me/code/shop/.git/dipo/runs/<run-id>",
        cwd: "/home/me/code/shop/.git/dipo/runs/<run-id>",
        argv: ["/home/me/.local/bin/claude", "-p", "--model", "sonnet"],
        model: "sonnet",
        effort: "medium",
        caps: { budgetTokens: 800_000, maxTurns: 120, maxMinutes: 60, loops: 4 },
        envNames: ["DIPO_RUN", "HOME", "PATH"],
        files: [{ name: "claude-settings.json", content: '{ "sandbox": { "enabled": true } }\n' }],
        systemFile: {
          path: "/home/me/code/shop/.git/dipo/runs/<run-id>/system.md",
          text: "You are a worker.\n",
        },
        taskMessage: "<story>\nDIPO-21 Add retry\n</story>\n",
      },
      problem: null,
    },
  },
  "office.digest": {
    args: { office: ids.office, since: "2026-10-11T18:00:00Z" },
    result: {
      since: "2026-10-11T18:00:00Z",
      counts: { done: 2, parked: 1 },
      lines: ["DIPO-19 done", "DIPO-24 parked: verify-failing"],
    },
  },
};

/** A plain worker-output `work.output`: worker text, no `markers` (next to the marker below). */
export const workerOutputFixture = {
  work: workRef,
  source: "worker",
  from: 1007,
  to: 1024,
  text: "Running tests…\n",
};

const officeEventFixtures: Record<string, unknown> = {
  "story.state": {
    story: "DIPO-33",
    key: ids.storyKey,
    from: "Ready",
    to: "Refined",
    view: refinedStoryView,
    detail: refinedStoryView.gateMessages,
  },
  "story.renumbered": { key: ids.storyKey, from: "DRAFT-3", to: "DIPO-40", detectedBy: "engine" },
  "work.assigned": { work: workRef },
  "work.phase": { work: workRef, phase: "build", progress },
  "work.progress": { work: workRef, progress },
  // An engine marker (DIPO-95): the range holds exactly the flagged marker line.
  "work.output": {
    work: workRef,
    source: "worker",
    from: 1024,
    to: 1068,
    text: "[dipo] 2026-10-12T09:00:00.000Z phase build\n",
    markers: [{ from: 1024, to: 1068, kind: "phase", value: "build", at: "2026-10-12T09:00:00Z" }],
  },
  "work.observed": {
    work: workRef,
    signal: "no-output",
    since: "2026-10-12T09:01:00Z",
    clearedAt: "2026-10-12T09:02:00Z",
    view: workView,
  },
  "usage.updated": { work: workRef, usage, view: workView },
  "gate.reached": gateView,
  "gate.decided": { gate: ids.gate, decision: "approved", by: "maintainer" },
  "question.asked": questionView,
  "question.closed": { question: ids.question, answer: "Yes, a 404 is fine." },
  "story.parked": {
    story: "DIPO-26",
    key: ids.storyKey,
    work: workRef,
    reason: "ambiguous-spec",
    detail: "May the migration drop the old column?",
    from: "In Progress",
    lastGoodCommit: "4f2a9c1",
    actions: ["work.answer", "work.resume", "work.discard", "story.drop"],
  },
  "story.pr": {
    story: "DIPO-21",
    key: ids.storyKey,
    pr: { number: 142, url: "https://github.com/example/demo/pull/142", state: "open" },
  },
  "proposal.filed": {
    proposal: ids.proposal,
    kind: "follow-up",
    key: ids.storyKey,
    story: "DIPO-122",
    run: ids.run,
    title: "Split RunOutcomes",
  },
  "proposal.closed": { proposal: ids.proposal, key: ids.storyKey, state: "accepted" },
  "test.started": testView,
  "test.recorded": {
    test: ids.test,
    story: "DIPO-15",
    key: ids.storyKey,
    result: "fail",
    note: "Esc does not go back.",
  },
  "test.ended": { test: ids.test, story: "DIPO-15", key: ids.storyKey, reason: "new-head" },
};

// `dipo` field blocks (0010 section 3).
export const validFieldBlock = {
  branch: "DIPO-12/daemon-restart-keeps-workers",
  unknowns: [
    {
      q: "Does the host survive SIGKILL of the daemon?",
      status: "resolved",
      answer: "Yes, tested on macOS and Linux.",
    },
  ],
  test_plan: {
    entries: [
      {
        kind: "manual",
        check: "Kill the daemon during a run, start it again",
        expect: "The run continues and the TUI shows it",
      },
    ],
  },
  park: { reason: "by-maintainer", from: "Ready", note: "Waiting for Bun 1.4.3" },
};

export const invalidFieldBlocks: Record<string, unknown> = {
  "unknown key": { ...validFieldBlock, owner: "me" },
  "unknown nested key": {
    unknowns: [{ q: "Which port?", status: "open", owner: "me" }],
  },
  "answer: 5173": { unknowns: [{ q: "Which port?", status: "resolved", answer: 5173 }] },
  "test_plan with entries and not_applicable": {
    test_plan: { entries: [], not_applicable: "Docs only, nothing to run." },
  },
  "test_plan with neither": { test_plan: {} },
  "unknown lifecycle in park": { park: { reason: "by-maintainer", from: "Waiting", note: "n" } },
  "branch with uppercase slug": { branch: "DIPO-12/Daemon" },
  "branch slug over 40 characters": { branch: `DIPO-12/${"a".repeat(41)}` },
};

export const commandFixtures: Record<string, { args: unknown; result: unknown }> = {
  "office.open": {
    args: { path: "/Users/me/code/dipsaus-orchestrator" },
    result: {
      office: ids.office,
      registered: true,
      warnings: [
        "/Users/me/code/dipsaus-orchestrator is on a network filesystem (nfs); another machine opening it has its own state, and nothing guards its worktrees and branches.",
      ],
    },
  },
  "office.forget": { args: { office: ids.office }, result: { office: ids.office } },
  "office.init": {
    args: { office: ids.office },
    result: {
      office: ids.office,
      pr: { number: 12, url: "https://github.com/o/r/pull/12" },
      branch: "dipo/backlog-20261012T091500",
      leftAlone: ["DIPO-36"],
    },
  },
  "office.purge": {
    args: { office: ids.office, from: "/Users/me/Projects/demo" },
    result: {
      office: ids.office,
      path: "/Users/me/Projects/demo",
      rows: 1284,
      directory: "/Users/me/Projects/demo/.git/dipo",
    },
  },
  "office.rescan": { args: {}, result: { scan: "started" } },
  "office.reloadConfig": {
    args: { office: ids.office },
    result: {
      office: ids.office,
      valid: false,
      errors: [
        {
          file: ".dipo/office.yaml",
          path: "caps.maxAgents",
          expected: "integer",
          message: ".dipo/office.yaml: caps.maxAgents: expected integer, got string",
        },
      ],
      configHash: "9f2c4e0b7a1d3f5e8c6b4a2d0e1f3a5c7b9d1e3f5a7c9e1b3d5f7a9c1e3b5d7f",
    },
  },
  "office.setPrivacy": {
    args: { office: ids.office, key: "storeCommandBodies", value: false },
    result: {
      office: ids.office,
      key: "storeCommandBodies",
      value: false,
      valid: true,
      errors: [],
      configHash: "9f2c4e0b7a1d3f5e8c6b4a2d0e1f3a5c7b9d1e3f5a7c9e1b3d5f7a9c1e3b5d7f",
    },
  },
  "daemon.stop": { args: { stopWorkers: false }, result: { state: "draining" } },
  "daemon.setLogLevel": { args: { level: "debug" }, result: { level: "debug" } },
  "daemon.resumeScheduling": { args: {}, result: { state: "running" } },
  ...officeCommandFixtures,
};

export const readFixtures: Record<string, { args: unknown; result: unknown }> = {
  "engine.hello": {
    args: { contract: { major: 1, minor: 0 }, client: { name: "dipo-cli", version: "0.1.0" } },
    result: {
      engine: "0.1.0",
      contract: { major: 1, minor: 0 },
      capabilities: ["replay", "daemon.control"],
      daemon: "running",
      offices: [officeSummary],
      cursor: softwareCursor,
    },
  },
  "commands.describe": {
    args: {},
    result: {
      commands: [
        {
          name: "office.purge",
          args: {
            type: "object",
            properties: { office: { type: "string" }, from: { type: "string" } },
            required: ["office"],
          },
          result: { type: "object" },
          since: 1,
          level: "software",
          confirm: true,
          irreversible: true,
        },
      ],
      reads: [
        {
          name: "daemon.status",
          args: { type: "object", properties: {} },
          result: { type: "object" },
          since: 0,
        },
      ],
    },
  },
  "daemon.status": {
    args: {},
    result: {
      state: "running",
      pid: 4242,
      version: "0.1.0",
      uptimeMs: 60_000,
      socket: "/var/folders/xy/abc123/T/dipo/dipo.sock",
      loadedOffices: [ids.office],
      activeRuns: 1,
      keepAwake: { held: true, reason: "1 active run" },
      upgradePending: false,
      buildCommit: "1a2b3c4d5e6f-dirty",
      engineBehind: [{ office: ids.office, name: "dipsaus-orchestrator", commits: 2 }],
      tools: {
        claude: "/Users/me/.local/bin/claude",
        backlog: "/opt/homebrew/bin/backlog",
        gh: "/opt/homebrew/bin/gh",
        git: "/usr/bin/git",
        // rg was not found on PATH, so it is absent.
      },
    },
  },
  ...officeReadFixtures,
};

export const eventFixtures: Record<string, unknown> = {
  "office.registered": { office: ids.office, path: officeSummary.path, name: officeSummary.name },
  "office.forgotten": { office: ids.office },
  "office.summary": officeSummary,
  "daemon.state": { from: "recovering", to: "safe", reason: "crash loop" },
  "scan.finished": {
    scripts: { verify: "bun run verify" },
    warnings: [],
    trigger: "rescan",
    level: "conforming",
    deviations: [],
    diff: ["~ verify: bun run test [standard, package.json scripts.test] -> bun run verify"],
  },
  "engine.notice": { level: "warn", code: "reconcile.mismatch", text: "DIPO-3 vanished." },
  "stream.mark": { caughtUp: true },
  ...officeEventFixtures,
};

const event = {
  cursor: officeCursor,
  at: "2026-10-12T09:00:00Z",
  type: "scan.finished",
  causedBy: ids.request,
  data: eventFixtures["scan.finished"],
};

export const clientFrameFixtures: Record<string, unknown> = {
  "auth with code": { kind: "auth", requestId: ids.request, code: "c0de" },
  "auth with token": { kind: "auth", requestId: ids.request, token: "t0ken" },
  command: {
    kind: "command",
    requestId: ids.request,
    name: "office.open",
    args: commandFixtures["office.open"]?.args,
    origin: "cli",
  },
  "office command": {
    kind: "command",
    requestId: ids.request,
    office: ids.office,
    name: "office.rescan",
    args: {},
    origin: "conversation",
    confirmed: true,
  },
  read: { kind: "read", requestId: ids.request, name: "daemon.status", args: {} },
  subscribe: {
    kind: "subscribe",
    requestId: ids.request,
    stream: `office:${ids.office}`,
    after: officeCursor,
    filter: ["work.", "story."],
  },
  unsubscribe: { kind: "unsubscribe", stream: "software" },
};

export const serverFrameFixtures: Record<string, unknown> = {
  "command reply": {
    kind: "reply",
    reply: {
      ok: true,
      requestId: ids.request,
      result: { scan: "started" },
      changed: true,
      cursor: officeCursor,
    },
  },
  "read reply": { kind: "reply", reply: { ok: true, requestId: ids.request, result: {} } },
  "error reply": {
    kind: "reply",
    reply: {
      ok: false,
      requestId: ids.request,
      error: {
        code: "contract.unsupported",
        message: "The daemon speaks contract 2.0.",
        retryable: false,
        details: { contract: { major: 2, minor: 0 }, version: "2.0.0" },
      },
    },
  },
  events: { kind: "events", events: [event] },
};

export const malformedClientFrames: Record<string, unknown> = {
  "unknown kind": { kind: "hello", requestId: ids.request },
  "auth with code and token": {
    kind: "auth",
    requestId: ids.request,
    code: "c0de",
    token: "t0ken",
  },
  "auth with neither": { kind: "auth", requestId: ids.request },
  "bad request id": { kind: "read", requestId: "not-a-ulid", name: "daemon.status", args: {} },
  "bad origin": { ...(clientFrameFixtures["command"] as object), origin: "robot" },
  "bad stream": { kind: "unsubscribe", stream: "office:nope" },
};

export const malformedServerFrames: Record<string, unknown> = {
  "unknown kind": { kind: "push", events: [] },
  "empty events": { kind: "events", events: [] },
  "command reply without changed and result": { kind: "reply", reply: { ok: true } },
};
