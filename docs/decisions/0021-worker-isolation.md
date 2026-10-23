# 0021 Worker isolation: one real box per story

Status: Accepted (2026-10-21, maintainer). Proposed in spike DIPO-263, written from the maintainer interview of 2026-10-21 (listed under "Maintainer decisions"). It amends 0001, 0008, 0010, 0012, 0014, 0019 and 0020 (see "Amends"). The text says where a point is a proposed detail rather than a maintainer decision.

## Context

### What a worker is today

On 2026-10-21 (checked on `main` at `992a78f7`), a worker is five pieces. Only one of them is sandboxed:

| Piece | What it is | Sandboxed |
|---|---|---|
| The model | Claude, deciding the next step | runs at Anthropic, only asks for tool calls |
| The `claude` program | Claude Code CLI on the maintainer's Mac. It runs the Read, Edit, Write and web tools | **no**, limited only by permission rules and dipo's hooks |
| Its Bash commands | tests, `ls`, `bun`, and so on | **yes**: Claude Code's srt sandbox, writes only to the worktree, network closed except Safe-Chain |
| The worktree | the story's folder: a git worktree of the main repository | it is the area the worker may write |
| The worker host | dipo's process that starts `claude` and relays its hooks | no; it is dipo's code |

The daemon and engine (**dipo** below) run unsandboxed, as the maintainer.

### Why this has to change

- **The security review and its audit of 2026-10-21.** Kept local until the escape below is closed (maintainer, 2026-10-21).
  - **N-1** and **V-1** were confirmed live: dipo runs a tool unsandboxed with the worker's worktree as its working directory, and that tool takes instructions from files there. So a file the worker writes in its own folder can run code with the maintainer's full access.
  - **V-2:** post-turn verify reads the home folder.
  - **V-3:** a permission answer lets a file write outside the worktree through.
  - **V-6:** temp directories.
  - **N-2:** a socket in reach of the worker.
  - All of these follow from the same fact: only Bash is boxed, and the box shares the Mac.
- **Tonight's run research** (`2026-10-20-dipo-run-gaps.md`).
  - Workers quietly drop work to stay inside their References: "done, but" appears in 25 of 78 reports.
  - Prose rules leak: `cd`, `sed -i`, Python heredoc edits.
  - The Bash guards became a growing shell parser (DIPO-195, 241, 242, 243, 261, 262) for a check that is best-effort by design.
- **The maintainer's view:** the planner carries 100% of the responsibility and the worker 0%. It should be 50/50. A worker should work like a developer: read the whole repository, run what it needs, decide how to deliver. It may do anything, as long as it cannot leave its box.

### Research (2026-10-21)

- Claude Code's own sandbox covers only Bash and similar commands. Read, Edit, Write, WebFetch, hooks and MCP run outside it.
- Inside a container, Claude Code with all permissions is the documented pattern, together with egress limits and no mounted credentials.
- A subscription login for a box:
  - `claude setup-token` gives a one-year token, limited to model requests, passed as `CLAUDE_CODE_OAUTH_TOKEN`. No revoke command is documented (unconfirmed).
  - The macOS login lives in the Keychain, which a box cannot read.
- A mounted git worktree is unsafe for an isolated worker. It shares refs, config and hooks with the main repository, and git config or hooks written there run on the host at dipo's next git command.
- Apple `container` (macOS 26) runs each container as its own lightweight VM with its own kernel. It is free (Apache-2.0) and launchd-native, but young (0.x), and memory freed inside a box is not returned to the host.

## Maintainer decisions

All taken on 2026-10-21 in the interview, in this order.

1. **References are a forecast.** The worker reads and writes anything in its box and reports what it touched. dipo records the real changed files and checks them against other stories in progress. References remain the planner's forecast for scheduling.
2. **Runs held until the redesign.** No `dipo run` starts until this design is built. There is no interim hotfix for N-1 and V-1.
3. **The whole worker goes into one real box,** and the design starts again from three questions: what the worker does, what it has access to, and what it sends back.
4. **The worker's jobs** (part 1):
   - It reads and writes code freely and uses the full web.
   - It installs packages, always through Safe-Chain.
   - It runs tests and commands.
   - It delivers its work **in parts** and says when the story is done.
   - **No git inside the box.** No host environment variables or settings (for example npm settings) in the box.
   - Verify is a command dipo runs in the worker's box, without AI.
   - Proposals are allowed, but are guarded against injection.
5. **Questions:** live and park, but live only while the maintainer has the TUI open at that moment.
6. **Delivery and review:**
   - dipo commits and pushes each delivered part to the story branch, before any PR.
   - The reviewer is separate and has no box. It reviews the branch's diff against the story's goal, through git or GitHub, not only locally.
   - Important findings go through dipo back to the **same** worker. After a fix the review runs again.
   - The reviewer is critical on whether tests help, whether the goal is delivered and whether there are security issues, and says when a human should review too.
7. **Reviewer tools:** read-only plus web. No shell, no writing, no gh.
8. **Per part:** a secret and protected-file scan before each commit and push. The full verify runs once, when the worker says the story is done.
9. **Box contents:** only files marked safe. Nothing outside git by default; the office config can list files to copy in, each marked as holding no real secrets.
10. **Network:**
    - The whole internet is reachable.
    - Package registries are reachable only through Safe-Chain.
    - The Mac and the local network are blocked. Useful local ports can be allowlisted in the office config.
11. **Login:** first probe whether a dipo proxy outside the box can add the subscription token, so it never enters the box. If that fails, put a one-year setup-token in the box, with token scanning and rotation.
12. **Environment:**
    - Described in the office config, outside the reach of stories. dipo detects a default from the repository and builds the image once.
    - A story that wants a new tool proposes it, and the maintainer adds it.
13. **Package cache:** one per office, filled by dipo from the lockfile through Safe-Chain. It is read-only inside the boxes; a worker's extra installs stay in its own box.
14. **Technology:** Apple `container`.
15. **Lifetime:** from claim to merge, so CI failures and PR comments are fixed in the same box. The box is stopped while waiting, and rebuilt from the delivered parts if lost.
16. **Limits:** none per box. dipo's budget caps still apply.
17. **No per-call checks inside the box.** The door is only the listed messages, and they are checked.
18. **Progress:** the worker's report counts for progress (criteria ticked, tests run). Verify and the reviewer are the check.
19. **Probe gate:** the escape probe is a hard gate. Nothing else is built on the design until every line passes.
20. **Collisions:** both stories continue; the second catches up after the first merges.

## Decision

### 1. One real box per story

- Each story's builder runs in its own box: an Apple `container` VM with its own kernel.
- The whole worker is inside the box: the `claude` program, every tool it runs and its copy of the code.
- dipo talks to the box only through the door (section 7).
- dipo code reaches the box technology through one box interface, so another backend can be added later, for Linux, without changing the design.

### 2. Contents

- **The code:** a plain copy of the repository at the story's start commit, with **no `.git`** and no history.
- **Files outside git:** only those the office config lists *and* marks as holding no real secrets.
- **Nothing of the maintainer's:**
  - no environment variables from the host;
  - no `~/.npmrc` or other settings files;
  - no Keychain, SSH agent or home folder;
  - no mounted host directories other than what the door needs (proposed detail: one exchange directory per box that holds no host files).
- SSH agent forwarding stays off.

### 3. Network

- The whole internet is reachable.
- Package registries are reachable **only through Safe-Chain**. A direct connection to a registry fails.
- The maintainer's Mac and local network are blocked. Exceptions are local ports listed in the office config.
- **The rules are enforced outside the box.** The worker is effectively root inside it, so a rule inside the box would be one it can switch off. How this is done on Apple `container` is proven by the probe (section 16).

### 4. The Claude login

- First choice: the box sends its model requests through a dipo proxy outside the box, which adds the maintainer's subscription token, so **the token never enters the box**. The worker can use the subscription while its box runs, but cannot take the token.
- Fallback, if the probe shows the proxy cannot carry a subscription login: a one-year `claude setup-token` passed into the box. With it:
  - dipo scans every delivered part and every output for the token;
  - the token is rotated on a schedule.
- Proposed detail: the Claude Code version inside the image is pinned, and auto-update and nonessential traffic are off.

### 5. The ready environment and the cache

- The office config names the box's image or recipe: toolchain, versions and system packages.
- Stories cannot change it. dipo detects a default from the repository, like today's scan.
- dipo builds the image once and reuses it. A worker that needs a new tool proposes it (message W5), and the maintainer adds it.
- **Package cache:** one per office, filled by dipo from the lockfile through Safe-Chain. Boxes mount it read-only. A worker's own installs go through Safe-Chain and stay in its own box.

### 6. Lifetime and limits

- A box is created at claim and **lives until the story's PR merges**, or until the story is dropped or discarded.
- It runs while the worker works, and is stopped (files kept) while the story waits for a review, an answer, a resume, CI or the maintainer.
- If a stopped box is lost, dipo rebuilds it from the start commit plus the delivered parts. Only undelivered work is lost.
- No CPU, memory or disk limits per box. dipo's budget caps (tokens, turns, minutes) still stop the worker.

### 7. The door

The only traffic between the box and dipo is these messages.

**Every message from the worker:**
- is size-limited and checked against a strict format;
- is treated as untrusted text, never as an instruction;
- reaches the maintainer cleaned of terminal control characters.

**Worker to dipo**

| | Message | What dipo does |
|---|---|---|
| W1 | **Part done**, with a short message | Section 8: scan, commit, push |
| W2 | **Story done**, with a report: what it did, criteria it considers met, what it tested, deviations | Runs verify in the box (section 9). The report updates the story's progress (decision 18) |
| W3 | **Question** | Live while the maintainer's TUI is open at that moment, otherwise the story parks with the question (section 11) |
| W4 | **Blocked**, with a reason | Parks the story with the reason |
| W5 | **Proposal**: a follow-up story, or a tool for the environment | Shown to the maintainer as plain text. Nothing happens on its own |
| W6 | **Live activity**: tool calls, output, token usage | Feeds the budget caps and the live view |

**dipo to worker**

| | Message |
|---|---|
| D1 | The task: story, goal, criteria, context |
| D2 | The maintainer's answer to a question |
| D3 | Findings to fix: the reviewer's, CI failures, the maintainer's PR comments |
| D4 | Verify failure output |
| D5 | Stop: budget reached or stopped by the maintainer. dipo ends the session and stops the box |

**What goes away**
- No checks on individual tool calls inside the box.
- No permission prompts and no allow-once answers.
- No Bash hook, gh guard or temp guard.
- No `dipo hook` program and no link to dipo's sockets from inside the box.

### 8. Delivery in parts

1. When the worker sends W1, dipo takes the changes since the last delivered part out of the box.
2. dipo scans them for secrets and protected files:
   - protected files are the story's task file, CI workflows and dipo's own configuration (proposed list, completed when the stories are written);
   - a hit stops the push and parks the story.
3. dipo commits the part on the story branch outside the box, using the worker's message as text only, and pushes the branch.
4. **Every git operation is dipo's, on dipo's own copy.** dipo never runs git, or any other tool, inside or on files from the box's folder (section 14).

### 9. Verify

- When the worker sends W2, dipo runs the office's verify command in the worker's box, without AI.
- A red result goes back to the worker as D4.
- A green result, plus the last part delivered, moves the story to review.

### 10. Review

- The reviewer is a separate session without a box.
- Its tools are read-only plus web search: the story, the diff of the story branch against the start commit, and a read tool that reads files from the pushed commit (not from the disk). No shell, no writing, no gh.
- It judges four things:
  - whether the tests actually help;
  - whether the code delivers the story's goal;
  - whether there are security issues;
  - whether a human should review too.
- Important findings go through dipo to the same builder (D3). After the fix (new parts, verify green) the review runs again.
- The PR is opened after the review passes.

### 11. Questions

- A worker's question is shown live only while a TUI is connected **at that moment**. Today's 10-minute presence window no longer applies.
- Otherwise the story parks with the question, and the answer resumes it in the same box.

### 12. Changed files and collisions

- dipo computes each story's real changed files itself, from the delivered parts against the start commit. It does not rely on the worker's list.
- When two stories in progress change the same file:
  - dipo tells the maintainer and both workers;
  - both continue;
  - when the first merges, dipo brings the new main into the second story's branch and box;
  - if git cannot merge cleanly, the second worker gets a fix round to resolve the conflict.
- Detection uses git's own merge check, with no model calls.

### 13. References

References are the planner's forecast of which files a story will touch. They are used to schedule stories that probably won't collide, and as context for the worker. They are no longer a write fence:
- the "write only these paths" contract goes;
- the scope check at done goes;
- the scope-violation park goes, except for protected files (section 8).

### 14. What dipo never does

- dipo never runs a tool (git, the backlog tooling, a package manager, a test) unsandboxed **in, or on configuration from, a directory the worker can write**.
- The task file, the story's status and the criteria ticks are written by dipo in its own copy of the repository, never in the box's.
- This closes N-1 and V-1 at the root.

### 15. Reviewer and builder roles stay separate

- The builder never sees the reviewer's reasoning, only its findings.
- The reviewer never sees the builder's reasoning or transcript. It gets what 0019 section 4 gives it (story, criteria, test plan, the diff), plus the report evidence DIPO-254 adds.

### 16. Probe gate

The first story of this design is the escape probe. dipo builds a box exactly as designed, then tries the following from inside it as root:

| Attempt from inside the box | Must |
|---|---|
| Read a file from the maintainer's home folder | fail |
| Connect to the Mac: dipo's socket, any local port | fail |
| Reach the router or another device on the local network | fail |
| Reach a package registry directly | fail |
| Install a package through Safe-Chain | work |
| Reach the internet | work |
| Find the SSH agent, host environment variables or `.npmrc` | fail |
| As root, switch off the network rules | fail |
| Find the Claude token in the box (if the proxy works) | fail |

- The probe is run with the maintainer watching.
- Nothing else is built until every line passes.
- If network rules cannot be enforced outside the box on Apple `container`, the technology choice is revisited with the facts.

## Amends

Each ADR below carries a dated amendment entry that points here.

- **0001:**
  - the `scope-violation` park reason only covers protected files;
  - the Ready gate's scope check becomes a forecast check.
- **0008:**
  - The worker adapter runs the whole worker in a box (sections 1–7).
  - The Bash sandbox settings, permission rules, PermissionRequest relay, allow-once answers, Bash hook and self-test approval probe go.
  - The credential check becomes part of the probe.
  - Line 208 ("cannot lift a sandbox block") and line 156 (values cannot leave except through the model API) are corrected.
- **0010:**
  - Commits in parts by dipo (section 8).
  - The scope check at done becomes changed-file tracking and collision handling (section 12).
  - No tool is run in, or on configuration from, the worker's folder (section 14).
- **0012:**
  - F8 References become a forecast (section 13).
  - R11 stays as "at least one forecast path".
  - R29 (DIPO-251) is reconsidered as a forecast-quality check rather than a gate.
  - Scope requests go: the `needs-scope` park reason, the report's `scopeRequest` field and the rule that adds F8 paths in lane a (amendment of 2026-10-16).
- **0014:**
  - The worker contract drops "you may write only these paths", the no-git and no-`cd` rules, and the scope nudges.
  - It gains the part, done, question, blocked and proposal messages.
- **0019:**
  - The reviewer's tools (section 10).
  - Fix rounds go to the same builder in its kept box, including CI failures and PR comments until merge.
- **0020:**
  - Questions are live only while the TUI is open (section 11).
  - Park and resume keep the box.
  - Web access is open to the whole internet (decision 10); the §11b allowlist idea is replaced.

## Consequences

**Closed by design** (from the 2026-10-21 reviews):
- V-1, N-1, H-1, H-9 (section 14);
- V-2 (verify runs in the box);
- V-3 (no permission answers);
- V-6, H-10 (temp directories live in the box);
- N-2, H-3 for workers (no socket in reach);
- H-15 and the guard line (no guards).

**Still open, to be filed as stories:**
- V-5 and N-7: terminal control characters in worker text, now at the door.
- H-6: the secret scan, now per part.
- H-8: stored command bodies.
- V-4: web leaks. Accepted by decision 10: with nothing secret in the box, what can leave is the code copy and the worker's own output.
- From the architecture review: A-1 (subprocess deadlines), A-4 (stream drift), A-6 (test isolation, including the runtime-dir fall-through found by the audit), A-7 (unpushed In Review), A-2, A-3, A-5, A-8 and A-13 to A-24.

**New risks:**
- Apple `container` is young.
- Memory is not returned while boxes run, and boxes live until merge with no limits.
- The fallback login puts a one-year token in the box.
- The worker has no git history to read (`git log`, `git blame`).
- Code the worker delivers still runs later in CI and on the maintainer's machine. Review and CI remain the guard there.

## Backlog impact

Checked against the open stories on 2026-10-21. Each story is re-read before it is changed.

| Effect | Stories |
|---|---|
| **Replaced by this design** | DIPO-252 and DIPO-253 (CLI approval settings, `cd` freely: replaced by the box and the probe). DIPO-165 and DIPO-258 (scope requests: References are a forecast). DIPO-261 and DIPO-262 (Bash guards). DIPO-169 (research access: full web). DIPO-245 (self-test approval evidence). |
| **Reshaped** | DIPO-257 (launch-check holds become box checks). DIPO-148 (fix rounds to the same box, plus CI and PR comments). DIPO-149 (conflicts: the second story catches up). DIPO-155 and DIPO-157 (resume with a kept box). DIPO-159 (live question only while the TUI is open). DIPO-154 (handoff notes, less needed with a kept box). DIPO-240 (installs move into the box and the dipo-filled cache). DIPO-247 (reviewer without a box). DIPO-251 (R29 as a forecast check). DIPO-255 (base-commit test run, now in a box). DIPO-116 (skills and plugins inside the box). DIPO-161 and DIPO-162 (discard and release must also tear down the box). |
| **Still valid** | DIPO-254 (report entries and deviations). DIPO-256 (budget line and caps). DIPO-259 and DIPO-166 (proposals as data: message W5). DIPO-186 (ADR notes in the report). DIPO-260 (security-sensitive story rule, for the reviewer). DIPO-150 to 153, 156, 158, 167, 168, 239, and the maintenance stories. DIPO-182 stays dropped (closed 2026-10-18); transcripts are revisited with the box design if needed. |
| **New** | The escape probe (first, the gate). The box interface and Apple `container` backend. The token proxy probe. The door messages. Delivery in parts with the scan. dipo's own copy for Backlog writes. Changed-file tracking and collisions. The reviewer's read-only tools. Plus the open review findings above. |

## Open points for the probe and the stories

- How network rules are enforced outside an Apple `container` box (host proxy, host-only network, or another way).
- Whether a proxy can carry a subscription login (decision 11).
- How parts leave the box: an exchange directory or a `container exec` stream (proposed detail).
- Start-up time of a box, and the cost of keeping boxes until merge without limits.
- A Linux backend behind the same box interface (not decided).

## Sources

- The security review, the architecture review and their audit of 2026-10-21. Kept local by the maintainer until N-1 and V-1 are closed, then added to `docs/reviews/`.
- `docs/research/2026-10-20-dipo-run-gaps.md`
- Claude Code docs:
  - sandboxing: https://code.claude.com/docs/en/sandboxing
  - sandbox environments: https://code.claude.com/docs/en/sandbox-environments
  - devcontainer: https://code.claude.com/docs/en/devcontainer
  - authentication: https://code.claude.com/docs/en/authentication
  - network config: https://code.claude.com/docs/en/network-config
- Apple `container`: https://github.com/apple/container and its technical overview.
- Git security: https://git-scm.com/docs/git#_security, https://git-scm.com/docs/git-worktree

## Amendments

- 2026-10-21, DIPO-264 (maintainer): section 16. **The probe gate passed** on Apple `container` 1.6.0 (macOS 26.6, Apple silicon), with one accepted risk. Commands: `tools/box-probe/probe.sh`; results: `tools/box-probe/RESULTS.md`. Every check ran as root in the box.
  - **Results per line:**
    1. Home folder: fails. Nothing is mounted.
    2. The Mac: partly. dipo's socket and ports bound to `127.0.0.1` are not reachable; services that listen on all interfaces are reachable over the box network. This is the accepted risk.
    3. Local network and router: fails.
    4. Registry directly: fails.
    5. Install through Safe-Chain: works, and Safe-Chain's test package is refused.
    6. Internet through the web proxy: works.
    7. SSH agent, host environment and `.npmrc`: none in the box.
    8. Root switching off the network rules: fails for the internet, the local network and the registries. No rule exists yet for the Mac's own services.
    9. The token in the box: fails, in neither the environment nor the files.
  - **Network** (section 3):
    - Each box joins a host-only network (`--internal`), which has no route out.
    - The only way out is dipo's web proxy on the box network's address on the Mac. Registry tunnels (host name normalised) go to dipo's Safe-Chain proxy.
    - Every other tunnel goes only to a public internet address. Bare IP addresses and names resolving to the Mac, to private, shared, link-local or multicast ranges, or to the box network are refused.
    - A first version of the proxy passed any target. The probe's review found this, and every line was tested again through the fixed proxy.
  - **Accepted risk** (maintainer):
    - A box can reach services on the Mac that listen on all interfaces, over the box network.
    - The maintainer's chosen fix is a firewall rule inside the box, set at box start, that the worker cannot change. Section 3 asks for rules outside the box, so that rule would be a second layer, and a rule on the Mac stays open. The fix is postponed: it could not be built in this session.
  - **Login** (section 4):
    - The first choice works. A model proxy on the Mac passes only model requests and adds the subscription login; the box has only a placeholder key and `NO_PROXY` for the proxy's address.
    - After a live request, the token was in neither the box's environment nor its files.
    - The fallback (a token inside the box) is not used.
  - **Measured:** about 1 s to start a box with a warm image, 7 MiB for an idle box, and under 1 s to copy the code in. A stopped box keeps its files.
  - **For the build stories:**
    - Apple `container` sets a 1 GiB memory limit by default, so dipo must set a high one to honour decision 16.
    - npm's Claude Code lagged the native installer, so the image needs a deliberate version.
    - Safe-Chain checks only the known registries, and installs from elsewhere take the direct route.
    - The proxy's address rule does not recognise a private host on a public range: one served by a VPN, a home network's global IPv6 addresses, or its own public IPv4 address reached back through the router. It also misses IPv6 forms that embed a private IPv4 address. The build proxy should also refuse the Mac's own addresses and on-link prefixes.
    - The registry check goes by name: a registry alias, or a tunnel to another name on the same CDN, reaches the registry without Safe-Chain.
- 2026-10-21, DIPO-266 (maintainer): sections 3 and 5. **The image build runs outside the box network, accepted for now.**
  - `container build` has no network option, so the image builder runs on Apple `container`'s default network, not the host-only box network.
  - No worker and no story code run during a build: only the steps dipo writes from the base branch's office config, and the install scripts of the Debian packages, Node, the package managers and Claude Code. Those scripts can reach the Mac, the local network and the registries directly; the build proxy steers the install tools by configuration, not by a wall.
  - Workers in boxes are not affected. The build proxy must run only for the length of a build, with the box web proxy's address rules (DIPO-271).
  - Moving the build onto a closed network is tracked as DIPO-286.
- 2026-10-21, DIPO-268 (maintainer): section 3. **The accepted risk is wider than recorded.**
  - The real-box run of dipo's web proxy showed that a box can also connect directly to a service bound to the Mac's own local-network address, not only to services that listen on all interfaces.
  - Without the web proxy, a box still reached neither the internet, the router nor the registries; through it, the Mac, its local-network address, the box network, the router, IP literals and plain HTTP were refused.
  - The maintainer accepts the wider risk on the same terms. DIPO-283 closes both.
  - The box network's address exists on the Mac only while a box runs on that network, so dipo's proxies can start only after the first box of the network is running.
- 2026-10-22, DIPO-275 (maintainer): decisions 4, 8 and 18, sections 2, 5, 7 (W2, D4), 9 and 10, and 0019 sections 1, 7 and 8. **CI is the verify of a box run; dipo prepares the box with the packages installed.**
  - In the first box run (DIPO-248), the repository's verify failed 305 tests inside the box because they need the git program, which the box does not have (decision 4 stands). The worker tried to install git, and the story parked as verify-failing after three loops, although its change caused none of the failures.
  - **Preparing the box.** Before the worker starts, dipo installs the office's packages in the box at the start commit, with the office's install command, through the box's web route and Safe-Chain (later from the package cache, DIPO-295). The box gets only the files the office config lists (section 2); no environment variables of the Mac.
  - **The worker checks its own work.** The worker runs the office's verify in its box before it reports done, and fixes what its change broke. The box prompt says the box has no git program, that failures caused by that are not the worker's, and that the worker does not install missing system tools (DIPO-293). dipo does not check that the worker ran verify.
  - **CI is the verify.** dipo no longer runs verify in the box at done (this replaces section 9 and the full verify of decision 8). At done, dipo commits and pushes the last part, opens the story PR, and starts the review and CI together (0019 section 7). Red CI goes back to the same worker through the CI loop of 0019 section 8.
  - **An office without CI** relies on the worker's own verify and the review.
  - **Replaced for box runs:**
    - in decision 4, "Verify is a command dipo runs in the worker's box";
    - decision 8's full verify at done;
    - in decision 18, "Verify and the reviewer are the check", which now reads CI and the reviewer;
    - section 9;
    - the W2 row's "Runs verify in the box": W2 now pushes, opens the PR and starts the review and CI;
    - the D4 row: D4 now carries red CI output;
    - in section 10, "verify green", which now reads CI green, and "The PR is opened after the review passes": the PR opens at done, as 0019 section 3 decides.
  - **In 0019, for box runs:**
    - the verify in section 1 step 1 and section 8's local verify cap no longer apply;
    - section 7's wait for checks the host has not reported does not hold an office without CI (DIPO-299).
  - Mac runs keep their verify until DIPO-280 removes them.
- 2026-10-22, DIPO-275 (maintainer): maintainer decision 2. **The box design holds; the hold on runs is lifted for box runs.**
  - The first box run (DIPO-248) parked verify-failing on the missing git program, which led to the verify redesign of the same day (amendment above).
  - The retest ran DIPO-300 and DIPO-122 end to end. The image, first built through the build proxy in about four minutes, was reused. dipo installed the packages in the box in 5 to 8 seconds. Each worker ran verify itself and did not try to install git. dipo committed each part from git objects and ran no verify of its own. The reviewer approved with read-only tools and nothing loaded from its copy. dipo opened the story PR itself (DIPO-122), and CI ran the full suite green on both.
  - The maintainer lifts the hold of 2026-10-21 for box runs: runs start with `--box` only, one at a time. The Mac-sandbox worker path stays unused until DIPO-280 removes it.
  - Still open from DIPO-275: the package cache fill (DIPO-295) and a live probe of a refused read outside the reviewer's copy. The gaps of the retest are DIPO-301 to DIPO-307.
- 2026-10-22, DIPO-186 (maintainer): replaces "dipo does not check that the worker ran verify" of the amendment of 2026-10-22 (CI is the verify of a box run). dipo reads the box worker's tool calls: a done report with a file edit and no run of the office's verify or test command after the last edit is sent back once per run, naming the command and asking the worker to report failures caused only by the missing git program; CI stays the verify. A test that fails in the box only because the box has no git program counts as done in the worker's test-plan report, with evidence that says so.
- 2026-10-22, DIPO-309 (maintainer): sections 3 and 14. A story's test runs in a new test box per test, from the story branch's pushed head, with the office image, the listed files, install from the package cache through Safe-Chain, and `dev` started by dipo; the builder's box is left untouched. The Mac reaches `dev` through a small forwarder that is part of the box image: it listens on the test box's network address and forwards to the `dev` port on the box's loopback, and the test URL is the box address on the host-only network. No port is published. Accepted risk, the same as testing by hand: the page `dev` serves runs in the maintainer's browser on the Mac.
- 2026-10-22, DIPO-310 (maintainer): section 10. The scan fallback session runs on the Mac with no box and every tool off (no read, shell or web), as the reviewer runs without a box; its evidence is built by code from dipo's base copy.
- 2026-10-22, DIPO-240 (maintainer): a developer runs only in its box; there is no Mac worker path, and `--box` is accepted and changes nothing. A story's box lives from claim to merge: dipo stops it while the story waits (review, answer, resume, CI, the maintainer), after the token check, and starts it for the next session; a session and a stop never overlap, and a box is deleted only after a fresh token check. A lost box is rebuilt from the start commit plus the delivered parts (with the start commit's backlog), the maintainer is told, and only undelivered work is lost. Merge, drop and discard delete the box within about a minute. No install, setup, post_create step or base verify runs in the Mac worktree; the box's own install (section 5) is the only install. The engine step sandbox is gone; the Safe-Chain proxy keeps its own sandbox for the box cache fill and the web route. A developer host of an earlier binary still running on the Mac after a daemon restart is stopped and its story parks interrupted. The four box-only park causes (a protected file, a secret, a refused part, the story's task file) stay not resumable (maintainer, 2026-10-23): the story is discarded and run again.
- 2026-10-23, DIPO-312 (maintainer): sections 8 and 14. A box part may not change the configuration of the tools dipo runs on checkouts: the Backlog CLI's (`backlog.config.yml`, `.backlog/`, and the config of the folder `backlog.config.yml` names), Bun's (`bunfig.toml`, `.bunfig.toml`) and Claude Code's MCP servers (`.mcp.json`); such a part parks with `protected-file`. dipo refuses a Backlog CLI call when a Backlog file it could read has front matter that is not plain YAML, is not a file dipo can check (a special file, or over 1 MiB), when a status change would run a command named in the configuration or a task file, or when the folder has no project configuration of its own. Stored tool lines and log lines have secrets scrubbed before they are cut or written.
- 2026-10-23, DIPO-281 (maintainer, from DIPO-283), section 3. Every box gets an in-box firewall that dipo sets before a box's first install or build step and again at each session: output only to loopback and to the Mac's box-network address on the ports of dipo's web route and model proxy. Services on the Mac that listen on all interfaces, on the box-network address or on the Mac's local-network address are no longer reachable from a box by accident. The office's `box.localPorts` (office config version 12) are reached only through the web proxy, as `host.dipo.internal:<port>` on the Mac's loopback, by a box dipo admitted with its own proxy password. The rule lives in the box's kernel. It stops accidental direct connections but not yet a worker that sets out to undo it: the worker runs as root in the box, and dipo's privileged commands start through the box's dynamic loader. Running everything untrusted in a box as a non-root user closes that (DIPO-334); until then the accepted risk of 2026-10-21 for Mac services stays open for a deliberate worker.
- 2026-10-23, DIPO-281 (maintainer, from DIPO-286), sections 3 and 5. The office image is built in a build box on the host-only box network, through the boxes' own web route (Safe-Chain for registries, dipo's web proxy for the rest), and made with `container commit`; `container build` and its builder are no longer used. The bootstrap uses only the base image's programs (apt download only, `dpkg-deb -x`) and runs no package install script; the firewall is then set and the install steps run behind it, so no install step reaches the Mac, the local network or a registry except through dipo's proxies. Claude Code's auto-update and nonessential traffic are switched off with each box command, since a committed image keeps its base image's settings. Until DIPO-334 the install steps run as root, so an install script could still change the image's own files. This replaces the build-time part of the DIPO-266 amendment.
- 2026-10-23, DIPO-281 (maintainer), section 3, registry routing. Known registry aliases, CDN names, public mirrors and names in registry-only zones are refused. In a direct tunnel a TLS handshake must name the CONNECT host (no Encrypted Client Hello, no nameless hello), and a clear-text stream may not name a registry or start HTTP/2 in clear text. Open: registries and mirrors not on the list, a relay on the internet, domain fronting on a shared CDN, and coalesced HTTP/2 across names on a registry's certificate.
- 2026-10-23, DIPO-334 (maintainer), section 3: every command dipo starts in a box runs as the box user (uid/gid 1000, no capabilities, no new privileges), and the tools mount is /dipo-net. dipo's own root steps keep an allow list without net_admin or net_raw; outside a build box only fixed stage and dipo-part steps run as root, and no root copy writes into a folder the box user can write. In the image build, Debian's packages from the signed archive and the pinned Node.js archive install as a root step before any npm code; npm installs run as the box user into its home. This closes the gap of the DIPO-281 amendment.
