# 0023 Skills and plugins granted to a session

Status: proposed. First written 2026-11-27 (spike DIPO-519). The probes P1 to P3 ran on 2026-11-28 (DIPO-518; results at the end of section 9 and in `tools/box-probe/RESULTS.md`), and sections 4, 6 and 7 follow them. It is not approved: it waits for the maintainer's approval. Until then the code and the accepted ADRs stand as they are: no session loads a skill or a plugin (0008).

## Decision in short

- A session gets a skill or a plugin only through a **grant** that code reads from files the maintainer reviewed: a story run's grant from the `skills` and `plugins` keys of its role file, the reviewer's, planner's and auditor's from the `grants` block of the office config. The scan session on the Mac gets no grant in the first cut (section 6).
- A skill is a folder under `.dipo/skills/<name>/` on the base, and a plugin a folder under `.dipo/plugins/<name>/`. They are read from git's objects at the commit the run claims, as role files are. That commit is the pin; the run records the name and a sha256 of each granted tree, and keeps that grant for all its sessions.
- The engine copies the granted folders into the session's own box and passes no flag that widens a read-only plan. Every other skill and plugin stays out, including the repository's own `.claude/skills` and the skills bundled with Claude Code, and `system/init` is checked against the grant instead of against nothing.
- A skill or plugin of the grant holds no executable part: no hooks, no scripts, no MCP or LSP server, no agents, no pre-approved tools, no shell injection. A load-time check refuses it. The box is the guard: the probes showed a skill's hook runs a command even in a box whose kind has no shell.
- Marketplace plugins are not a source in the first cut.

The probes P1 to P3 are written out in section 9, with their results of 2026-11-28 at its end.

## What is known today

Measured, recorded in the comments of `packages/engine/src/workers/claude-cli/skills.ts` and `plugins.ts`, `tools/box-probe/RESULTS.md` and the recording `safety-slash-skill`:

- **M1** (DIPO-116 probe p16c, Claude Code 2.1.301): without `--disable-slash-commands`, a user message that starts with `/<name>` expands a project skill from the session's `.claude/skills` with no permission check, even without the Skill tool, and registers the skill's frontmatter hooks, which run commands no tool setting governs.
- **M2** (probe p17b, recording `safety-slash-skill`): with the flag, nothing expands and `system/init` lists `skills: []`.
- **M3** (DIPO-108 live run, 2.1.301): `system/init` lists a plugin synced from the claude.ai account as `<name>@synced`, and Claude Code's own plugins as `<name>@builtin`.
- **M4** (shipped, with tests on recordings): a SessionStart hook of a plugin runs before `system/init`, so a plugin has to be switched off in the settings and not only checked from `system/init`.

Everything else this ADR says about how Claude Code loads a skill or plugin comes from Claude Code's documentation (`code.claude.com/docs`, skills and plugins reference, read 2026-11-27, Claude Code 2.1.303 installed on the Mac) and was marked unmeasured with the probe that checks it. The probes ran on 2026-11-28; each claim's result is in the table at the end of the Probes section, and the text above it says what was measured.

## 1. The role file

**The key.** Options:

- **A. Two keys in the frontmatter, `skills` and `plugins`, each a list of names.** The strict schema stays; `version` stays `1`, because a dipo that does not know the keys refuses the file with "the key may need a newer dipo" (0017), which fails closed.
- **B. One key `grants` with `skills` and `plugins` under it.** One more level, and it would be the only nested key of the file.
- **C. Names in the body.** Prose a model reads. Refused: it is deterministic data (0001).

**Recommended: A.** `skills: [name, ...]` and `plugins: [name, ...]`, both optional, default empty. A name is a role name's shape (lowercase letters, digits, hyphens, starting with a letter), at most 8 of each. A duplicate is an error.

**How a name is given and pinned.** Options: (A) the bare name, resolved in `.dipo/skills/` or `.dipo/plugins/` of the base the run claims; (B) `name@<sha>` or `name@<version>`; (C) `name@<marketplace>`.

**Recommended: the bare name.** The base commit that holds the role file and the folder is the pin, so the same story at the same commit gets the same bytes, as it does for the role's instructions (0001 Roles). A second pin in the name would be a second source for one fact (0001 principle 7). The run stores the grant it started with, by name and sha256 of the folder's files, so a later session of the run, a fix round or a resume reads that copy and never the changed base; the sha256 is evidence, not a second pin.

**A name that is not available.** Options: (A) the file loads, the run fails at start; (B) the file is refused at load; (C) a new Ready gate rule.

**Recommended: B.** The role loader already reads the base tree and already leaves an invalid role out of the roster with one notice naming the file (0017). It also checks that every named folder exists on the same base tree, holds a `SKILL.md` (a skill) or `.claude-plugin/plugin.json` (a plugin), and passes the safety check of section 5. A failing role is out of the roster, and the Ready gate's existing check that a story's role is in the roster refuses the story. No new gate rule, no new check at the run's start: one mechanism. A grant that changes on the base after a story is Ready reaches the story only through the base it claims, so the load-time check is repeated at the claim, and a failure there parks the story like any invalid role does today. **Not measured (U8):** whether `claude plugin validate` agrees with the engine's own manifest check. That check does not exist until the implementation story builds it, so that story compares the two on the probe folders of section 9; the engine's check stays code and never runs the CLI.

## 2. The office config

**The keys.** Options:

- **A. A `grants` block with one entry per engine-code role:**
  ```yaml
  grants:
    reviewer: { skills: [], plugins: [] }
    planner:  { skills: [], plugins: [] }
    auditor:  { skills: [], plugins: [] }
  ```
- **B. `skills` and `plugins` inside each existing block** (`review`, `scan`, and new `planning` and `audit` blocks). Spreads one concept over blocks that otherwise hold limits.
- **C. A list per skill naming the roles that get it.** Inverts the lookup; a role file and the config then say it in opposite directions.

**Recommended: A.** It mirrors the role file's two keys, and it is the one place a reader looks for "who gets what". Every key has a default of an empty list, so no version bump (0017, section 7). There is no `scanner` entry: the scan session gets no grant in the first cut (section 6), so a `scanner` key is refused like any unknown key. The names are resolved and checked on the base tree as in section 1; a missing name or a failing folder refuses the office file, naming the key path, as every other config error does. A reviewer's grant is read at the start of each review session of a run; like a role's, it is the grant of the commit the run claimed.

## 3. Sources

| Source | Pin | Review before a session | Verdict |
|---|---|---|---|
| **Files on the base under `.dipo/`** | The base commit the run claims; sha256 of each folder recorded with the run | They reach the base by a story's PR, which the review agent reads against the story, and the maintainer merges; the load-time check of section 5 runs on every base | **Recommended, the only source in the first cut** |
| **Files baked into the box image from the office config** | The image's own build, which has no commit pin for the files unless a hash is added; an image is rebuilt only when its config changes | A config change reaches the base by a PR | Refused. A second source of the same bytes; it changes only with an image rebuild, so a run's grant would depend on the image's age, and the read-only boxes are made from the same image and could not get a different grant |
| **Marketplace plugins** | A marketplace entry can name a commit; a plugin's own `version` pins it until changed (documented, not measured by design: marketplace plugins are refused, U6) | Only after a fetch, through the box's network, which reaches registries only via Safe-Chain (0008 section 2); a marketplace is not a registry that Safe-Chain checks | Refused for now. The fetch is a second network path, the pin lives in a file nobody reviews in the repository, and the box holds no `~/.claude/plugins`. A later ADR may allow one if a plugin cannot be vendored |

Vendoring in the repository means a skill or plugin is reviewed as code, is the same bytes in a developer box, a read-only box and a test of the loader, and a Mac session reads it from git, never from the maintainer's home. Claude Code's own plugins (`@builtin`) and the maintainer's installed and synced ones stay refused, as today: the grant is the only way a skill or plugin reaches a session.

**Reviewed before it reaches a session**, in three steps, none of them a model: the PR review (the reviewer reads `.dipo/skills/` and `.dipo/plugins/` like any file), the load-time check of section 5 (refuses any executable part), and the sha256 in the run's grant, which the run detail shows (section 7). A change under `.dipo/skills/` or `.dipo/plugins/` is a repository file like `.dipo/roles/`; it is not added to `.github/CODEOWNERS`, because that file is for the release path (0016). The maintainer may add it by hand if they want a second reviewer there.

## 4. The mechanism for `claude -p`

Options for how a granted skill or plugin reaches the session:

- **A. `enabledPlugins` in the run settings.** Names a plugin that Claude Code has installed. It needs `installed_plugins.json` and a marketplace in the box's home, which is the install path section 3 refused. Today's use stays: on the Mac only, `enabledPlugins` false for every installed plugin (M4).
- **B. `--plugin-dir <path>`.** Loads a plugin from a folder for the session, with no install (documented, measured 2026-11-28, U4, P1). One flag per plugin. A read-only plan refuses it today (`READ_ONLY_REFUSED_FLAGS`, 0008 section 1).
- **C. Skills copied into the box.** The engine writes each granted skill to the session's own personal skills folder, `<box home>/.claude/skills/<name>/`, before the session starts. No flag. A read-only plan needs no change. The folder belongs to the box user and is written by dipo, as the system file is.
- **D. The Skill tool.** Not a way to deliver but the way a model invokes a skill. It has to be among the kind's tools, which today are named exactly (0008 section 1).

**Recommended.**

- **Skills: C.** A granted skill is copied to the personal skills folder of the session's box (a developer, reviewer or planning box), so `--plugin-dir` is not needed and the read-only plan check stays as it is. The scan on the Mac gets no grant in the first cut (section 6).
- **Plugins: B, in the developer box only, for now.** The engine copies the granted plugin to a fixed folder in the box and passes `--plugin-dir <that folder>` once per plugin; `enabledPlugins` is not used because nothing is installed in a box. A read-only session (reviewer, planner, auditor) gets skills only in the first cut: its plan check stays exactly as today, and an office whose `grants.reviewer.plugins` is not empty is refused at load. This is the smallest change that keeps the 0008 rule "no flag that adds plugins" true for every read-only kind. If P2 shows `--plugin-dir` with one exact engine-made path is safe in a read-only box, a later story may widen it; it is not part of this decision.
- **D.** The Skill tool joins the tool list of a kind only when the session has a grant. The adapter names it (0008): a developer's and a reviewer's and a planning session's grant adds `Skill` to their `--tools` list; with no grant the list is what it is today. The read-only plan check compares tool names exactly, so the exact list of each kind with a grant is a second allowed list, fixed in code.

**Measured 2026-11-28 (P1, P2).** **U1:** with `--disable-slash-commands`, `system/init` lists `skills: []` and no granted skill loads, in a developer box (Claude Code 2.1.303) and on the Mac (2.1.332), so the plan of a session with a grant drops the flag. **U2:** without the flag, the repository copy's `.claude/skills/probe-project` is listed in a developer box and usable (the session answered `PROJECT-OK` through the Skill tool), so the engine removes `.claude/skills` from a developer box's copy before the session starts; a read-only box, whose plan passes `--setting-sources user`, did not list it. **U3:** a skill copied into `~/.claude/skills` is listed as its plain name (`probe-plain`), a plugin's skill as `<plugin>:<name>` (`probe-pack:pack-skill`). **U5:** a skill of the personal folder is listed in a read-only box whose plan passes no settings flag, and is invoked and used there (P2 step 4 invoked `probe-hook` through the Skill tool); a skill that is not copied there is not listed. An ungranted skill's file stays readable in a developer box as any file of the copy is, without loading.

**Claude Code's own skills.** Without the flag, `system/init` also lists the skills bundled with Claude Code: 18 in 2.1.303 (`deep-research`, `design`, `design-sync`, `dataviz`, `update-config`, `verify`, `debug`, `code-review`, `simplify`, `batch`, `fewer-permission-prompts`, `doctor`, `loop`, `claude-api`, `workflow-authoring`, `run`, `run-skill-generator`, `plugin-authoring`), and one more (`claude-approvals`) in 2.1.332. The set changes with the Claude Code version. They are as trusted as the binary, like the `@builtin` plugins, but they are instructions nobody reviewed for the office, the model may invoke any of them, and their listings cost prompt tokens in every session with a grant (section 7). The grant is meant to be the only skill list, so the plan of a session with a grant switches off every skill it does not grant, with Claude Code's per-skill setting (`skillOverrides`, documented). **Not measured (U15):** that `skillOverrides` switches off a bundled skill in the pinned Claude Code version. The first implementation story measures it before it builds the `system/init` check. If it does not, the check lets through exactly the bundled names of the pinned version, a list fixed in code next to the version pin, and nothing else.

**What `system/init` is checked against.** Today: any skill listed stops the session (`skillRefusal`) and any plugin not allowed stops it (`pluginRefusal`). With a grant: the listed skills must be a subset of the grant's skill names plus the granted plugins' namespaced skills (and the bundled names, only if U15 shows they cannot be switched off), and the listed plugins a subset of the granted plugins' names plus Claude Code's `@builtin` ones as today. **Measured 2026-11-28 (U4, P1):** `--plugin-dir` loads a plugin with no install, listed as `{"name": "probe-pack", "source": "probe-pack@inline", "path": "<the folder>"}`, and its skill is usable (`PACK-OK`). Anything else listed stops the session at its `system/init` as now, with the refusal naming what was extra and the grant. A session with no grant keeps today's check unchanged, so the code path of "no grant" is today's.

**The slash expansion.** A user message that starts with `/<name>` expands a skill without a permission check (M1). With a grant the flag cannot stay, so the engine has to make a steer unable to name a skill: it sends the text of a message that begins with `/` with one leading space. **Measured 2026-11-28 (U7, P1):** a bare `/probe-plain` expands the skill (the message comes back as `<command-name>/probe-plain</command-name>`); a leading space, a leading zero-width space and a leading backslash each leave it a plain user message. The space is the one the engine uses: it is visible in the transcript and changes no word. The grant is the only skill list in the session, so what an expansion could reach is the granted skills and nothing the repository holds.

## 5. Safety

A skill's or agent's frontmatter and a plugin's components can run commands outside any tool setting: `hooks` run commands when a skill is invoked and stay for the rest of the session (M1), `allowed-tools` pre-approves tools, `permissionMode` in an agent changes what a subagent may do, `context: fork` with `agent` starts a subagent, `` !`cmd` `` in a skill body runs a command when the skill loads, and a plugin can add hooks, MCP servers, LSP servers, monitors and a `bin/` folder put on the Bash `PATH` (documented). **Measured 2026-11-28 (U9, P1, P2):** a granted skill's `PreToolUse` hook ran its command after the skill was invoked, in a developer box and also in a reviewer box whose tools are only read, search, web and Skill (the mark file appeared in the box both times, never on the Mac). A kind's tool list does not stop a hook, so the load-time check below is the guard for every kind, and the box keeps what a missed hook could do inside it. A plugin's `SessionStart` hook ran before `system/init` in the developer box, as M4 says.

**The rule: a grant holds only instructions.** The load-time check (sections 1 and 2) refuses a skill folder or plugin folder that has:

- a `SKILL.md` whose frontmatter holds any key but `name`, `description`, `when_to_use`, `disable-model-invocation`, `user-invocable`, `argument-hint` or `arguments`. That refuses `hooks`, `allowed-tools`, `disallowed-tools`, `context`, `agent`, `shell`, `model` and `effort`, and an unknown key (unknown keys are ignored by Claude Code, documented, so one is refused here rather than carried silently);
- a `` !` `` command injection in a skill's body;
- in a skill folder, any file but Markdown and plain text (`.md`, `.txt`), so no script ships with a skill;
- in a plugin folder, any of `hooks/`, `.mcp.json`, `.lsp.json`, `agents/`, `commands/`, `bin/`, `monitors/`, `workflows/`, `output-styles/`, `themes/`, or a manifest key `hooks`, `mcpServers`, `lspServers`, `agents`, `commands`, `channels`, `userConfig`, `dependencies`, `experimental`;
- a path that is a symbolic link or leaves the folder.

A plugin that passes holds a manifest and `skills/<name>/SKILL.md` folders under the same rules. That makes a plugin a named bundle of skills, which is all the first cut needs; anything with an executable part is a story's change to this rule, not a grant.

**By kind.**

| Session | Where it runs | What a hook or server could reach, were the check bypassed | Guard in addition to the check |
|---|---|---|---|
| Developer | In its box, everything allowed (0008) | Only the box, which already holds nothing of the maintainer's | None needed; the box is the boundary. P1 showed a granted skill's hook, handed to the box directly, wrote only inside it |
| Reviewer, planner, auditor | In a read-only box, tools read, glob, grep and web | The box and its proxies; P2 showed a hook does run a command there although the kind has no shell | The plan check refuses every flag the grant does not need, unchanged (P2: all eleven refused flags, in 44 spellings); `--strict-mcp-config` stays, so a plugin's or a project's MCP server is not loaded. **Measured 2026-11-28 (U10, P2):** with `--strict-mcp-config` a `--plugin-dir` plugin's `.mcp.json` did not start its server; without the flag it did |
| Scan | On the Mac, every tool off, no box | A hook would run as the maintainer, outside any box | No grant (section 6) |

## 6. The scan session on the Mac

Options:

- **A. Move the scan into a read-only box.** One guard for every session: the box. A scan session has no tool, takes its input as text and returns text, so it needs no files from the repository. Cost: a box made and deleted for a short session, and a changed 0008 section 6 and 0013 (the scan session "runs on the Mac"). It removes the Mac-side problem and also the one session that runs without the Bash sandbox, but it moves a whole session for a grant most offices will not set.
- **B. Skills only, under the check of section 5 and `disableAllHooks`.** Keep the scan on the Mac. A granted skill has no executable part by the load-time check; plugins are refused for the scan at load, because a plugin's SessionStart hook runs before `system/init` (M4) and could not be checked in time. The engine copies the granted skills into a home folder of the run, never reading the maintainer's `~/.claude`. The run settings add `disableAllHooks: true`, so a hook that slipped the check does not start. `system/init` is checked against the grant as in section 4. Every tool stays off except the Skill tool; the Skill tool does not give the session a shell.
- **C. A command guard around the session's process**, for example a sandbox profile for the Mac process. This is the guard 0008 removed on 2026-11-03 because it guarded a shell the session did not have, and it would be one mechanism beside the box.
- **D. No grant for the scan in the first cut.** The scan stays as it is: every tool off, `--disable-slash-commands`, no skill, no plugin.

**What P3 measured (2026-11-28, Claude Code 2.1.332).**

- B rests on a run home that does not exist. The scan runs with the maintainer's own `HOME` (`packages/engine/src/workers/claude-cli/plan.ts`, `environment`) and `--setting-sources project,local`. P3 stood a scratch `HOME` in for the run home: under `project,local` a skill in that home's `.claude/skills` was not loaded ("Unknown skill"); with the `user` source added it loaded. So a personal skill reaches the scan only through the `user` source. In the maintainer's own `HOME` that source loads the maintainer's own `~/.claude` skills and settings, which section 3 keeps out; in any other home the session has no login (measured: the scan's plan with the scratch `HOME` and no model route answered `Not logged in`). B would need a run home and a model route on the Mac, a second mechanism beside the box's.
- **U12:** `--tools Skill` is enough (`PLAIN-OK`, and `tools` in `system/init` is `Skill` only). That every tool off alone keeps a skill unusable was not isolated: step 1 kept `--disable-slash-commands`, which empties the list by itself (U1).
- **U11:** `disableAllHooks` stopped a `--plugin-dir` plugin's `SessionStart` hook on the Mac; without it the hook ran on the Mac (the mark file appeared). A skill with a `hooks` key was refused by Claude Code's own permission check in the scan's `default` permission mode ("requires approval, and this session has no approval surface"), with and without `disableAllHooks`, so that hook never ran and the probe could not show `disableAllHooks` on a skill's hook.
- The maintainer's `~/.claude/skills` and `~/.claude/plugins` were the same before and after.

**Recommended after the probes: D, and A when an office needs a grant for the scan.** No skill reaches a session on the Mac, so no hook can run as the maintainer, and nothing changes in the scan's plan. B is not approved: its layers held where they could be tried, but it needs a new home and model route on the Mac. When an office needs a skill in the scan, a later story moves the scan into a read-only box (A) and gives it a grant as the reviewer gets one.

## 7. Prompt budget and evidence

**Budget (0014).** A skill's `description` and `when_to_use` are listed to the model in every session that has the skill, truncated at 1,536 characters each (documented), and the body loads only when the skill is invoked. **Measured 2026-11-28 (U13, P1):** in a developer box the same fixed prompt read 10,297 tokens from the cache with a grant (21 listings: two granted, the repository's one, 18 bundled, and the Skill tool) and 7,463 without, so the listings and the tool cost about 2,800 tokens, most of them the bundled skills that section 4 switches off. The probe's descriptions are short, so the 1,536-character cut was not reached and stays documented only. These listings are not part of the task message, so the task message caps do not count them, but they use the same context. Options: (A) count them in the 0014 budgets; (B) cap them by a rule on the file; (C) no limit.

**Recommended: B, with a row in the budget table.** The load-time check refuses a skill whose `description` and `when_to_use` together are over 600 characters, and a grant whose listings together are over 3,000 characters (S and M classes) or 4,000 (L and XL). P1 measured the cost of short listings only (U13 above), which does not argue for other numbers, so the proposed ones stand. The cap is a property of the file, checked in code once, so a budget never cuts a description on the way in. L1+L2 do not change with a grant, so their hash stays the same for a role that gets one; the listing is part of Claude Code's own prompt (L0). **Measured 2026-11-28 (U14, P1):** a grant changes the cached prefix (the second run of each read 10,297 tokens from the cache with the grant against 7,463 without), so the grant is part of the cache key and the grant's hash is stored with the L1+L2 hash.

**Evidence.** The run records its grant when it starts: for each skill and plugin, the name, the base commit and the sha256 of its files, in the run's row with the role's. A run keeps the grant it started with, as it keeps its role (0001 Roles): every later session, a fix round, a review and a resume uses the stored grant; a change on the base reaches only a run that starts later. The session's own `system/init` list is stored as an event of the run. The run detail shows the grant and the listed names, so a difference between them is visible; the refusal of section 4 is its own park detail.

## 8. What the decision would change

None of these files changes in the story that writes this ADR. They change in the implementation stories after the maintainer approves 0023. The lines are those on the base of 2026-11-27.

- **0008** (`docs/decisions/0008-worker-adapter.md`):
  - line 38 (section 1, the tools paragraph): "no flag that adds tools, permissions, settings, plugins or MCP servers" keeps its meaning for read-only plans; add that the tool list of a kind with a grant carries `Skill`, an exact second list;
  - lines 45 to 47 (section 2, Contents): the box also holds the granted skills and plugins, copied by dipo from the base;
  - line 69 (section 2, the image): add that skills and plugins do not come from the image;
  - line 141 (section 6, the developer's argv): `--disable-slash-commands` is passed only when the session has no grant, and `--plugin-dir` once per granted plugin;
  - line 146 (section 6, the reviewer, planning and scan paragraph): "None of these sessions loads settings, hooks, plugins or skills from the repository copy" becomes "none loads one from the repository copy; the reviewer and planning sessions load only their grant"; the scan sentence does not change (section 6: no grant);
  - the Replaced list (line 196 on): one line for the rule that no session loads a skill or a plugin.
- **0017** (`docs/decisions/0017-testing-strategy-and-configuration.md`):
  - line 101 (the sample's `version: 16`): no bump, every new key has a default;
  - line 111 (the sample `office.yaml`): add the `grants` line;
  - lines 119 to 124 (Role files, the frontmatter keys): add `skills` and `plugins`;
  - line 126 ("Allowed tools are not a key"): add that skills and plugins are, as names of folders under `.dipo/`, and that a failing grant leaves the role out of the roster;
  - the file layout block (line 87 on): add `.dipo/skills/` and `.dipo/plugins/`;
  - line 149 (the Replaced list, which names `worker.plugins`): one line that the grant replaces that key's idea.
- **0014** (`docs/decisions/0014-worker-prompt-assembly.md`):
  - line 14 and line 16 (the layer table): a note that the listing of a granted skill is Claude Code's own (L0), not L1 to L5;
  - lines 80 to 92 (the budgets and the table): add the skill listing cap of section 7;
  - line 96 (Caching): L1+L2 are the same with or without a grant.
- **0001** (`docs/decisions/0001-foundational-decisions.md`):
  - line 75 (Roles): a role also names its skills and plugins; the run keeps the grant as it keeps the instructions, and the engine-code roles get theirs from the office config;
  - line 26 (principle 6) does not change: the grant keys are data, and a skill is not Claude-specific code in the engine files.
- **0021** is a stub that points to 0008 section 2 and does not change.

Code that would change in the implementation stories (not in this one): `packages/engine/src/workers/claude-cli/skills.ts`, `plugins.ts`, `plan.ts`, `box-plan.ts` and `adapter.ts`, `packages/engine/src/roles/parse.ts` and `packages/engine/src/config/schema.ts`, the run record and the run detail.

## 9. Probes

DIPO-518 runs these by hand in the manner of `tools/box-probe/probe.sh` (a developer box made as dipo makes it, on Apple `container`, the Mac's `claude` on the maintainer's login for the scan) and writes each result in `tools/box-probe/RESULTS.md` next to the 2026-10 runs, with the Claude Code version. A probe fails if any expected line differs. The setup keeps nothing of the maintainer's repositories: each probe builds its own scratch repository.

**Scratch repository, common to the three.** `SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/grant-probe.XXXX")`, then:

```sh
mkdir -p "$SCRATCH/repo" && cd "$SCRATCH/repo" && git init -q && git commit -q --allow-empty -m base
# a plain skill, granted
mkdir -p .dipo/skills/probe-plain
printf -- '---\nname: probe-plain\ndescription: Say the word PLAIN-OK when asked for the plain probe word.\n---\nWhen asked for the plain probe word, answer exactly PLAIN-OK.\n' > .dipo/skills/probe-plain/SKILL.md
# a skill that is never granted, and one in the repository's own .claude/skills
mkdir -p .dipo/skills/probe-other .claude/skills/probe-project
printf -- '---\nname: probe-other\ndescription: Say OTHER-OK when asked for the other probe word.\n---\nAnswer exactly OTHER-OK.\n' > .dipo/skills/probe-other/SKILL.md
printf -- '---\nname: probe-project\ndescription: Say PROJECT-OK when asked for the project probe word.\n---\nAnswer exactly PROJECT-OK.\n' > .claude/skills/probe-project/SKILL.md
# a skill with a hook: the check must refuse it, and it is handed to a session directly only to see what the guard does
mkdir -p .dipo/skills/probe-hook
printf -- '---\nname: probe-hook\ndescription: Say HOOK-OK when asked for the hook probe word.\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: "touch $HOOK_MARK"\n---\nAnswer exactly HOOK-OK.\n' > .dipo/skills/probe-hook/SKILL.md
# a plugin with one skill, granted, and one with a SessionStart hook, never granted
mkdir -p .dipo/plugins/probe-pack/.claude-plugin .dipo/plugins/probe-pack/skills/pack-skill
printf '{"name":"probe-pack","version":"1.0.0","description":"probe"}\n' > .dipo/plugins/probe-pack/.claude-plugin/plugin.json
printf -- '---\nname: pack-skill\ndescription: Say PACK-OK when asked for the pack probe word.\n---\nAnswer exactly PACK-OK.\n' > .dipo/plugins/probe-pack/skills/pack-skill/SKILL.md
mkdir -p .dipo/plugins/probe-hookpack/.claude-plugin .dipo/plugins/probe-hookpack/hooks
printf '{"name":"probe-hookpack","version":"1.0.0"}\n' > .dipo/plugins/probe-hookpack/.claude-plugin/plugin.json
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch \\"$HOOK_MARK\\""}]}]}}\n' > .dipo/plugins/probe-hookpack/hooks/hooks.json
git add -A && git commit -q -m probes
```

A **mark** file, `$HOOK_MARK`, is the evidence a hook ran: its path is a file in the scratch directory outside the session's place (`$SCRATCH/hook-mark` for a Mac session, `/tmp/hook-mark` inside a box, read after with `container exec`). The `claude` command in each step is the one in `packages/engine/src/workers/claude-cli/plan.ts` for the kind (`-p --input-format stream-json --output-format stream-json --verbose`, `--strict-mcp-config`, `--tools` as the kind's list), with the flags the step names; each prompt is one stream-json user message on stdin, and `system/init` is the first line of stdout with `type: "system", subtype: "init"`.

### P1. The developer box: a granted skill and a granted plugin load and are usable, an ungranted one does not

Setup: the common scratch repository; a developer box as in `tools/box-probe/probe.sh` (Alpine image, `container run -d --name grant-p1 --network dipo-boxes --cap-add CAP_NET_ADMIN`, the firewall and proxies as a session sets them, the Claude Code version the image pins) with the repository copied in without `.git` and the model proxy route set; Claude Code runs as the box user, `bypassPermissions`.

Commands, in order:

1. `container exec grant-p1 sh -c 'mkdir -p ~/.claude/skills && cp -R /work/.dipo/skills/probe-plain ~/.claude/skills/ && mkdir -p /opt/dipo-grant && cp -R /work/.dipo/plugins/probe-pack /opt/dipo-grant/'` (the engine's copy of the grant).
2. With `--disable-slash-commands`, ask "What is the plain probe word?" and read `system/init`. This is the baseline (M2: `skills: []`) and answers **U1**.
3. Without the flag and with `--plugin-dir /opt/dipo-grant/probe-pack`, in the box's `/work` (which holds `.claude/skills/probe-project`): read `system/init`, then ask "What is the plain probe word?", "What is the pack probe word?", "What is the other probe word?" and "What is the project probe word?".
4. Repeat step 3 with `/probe-plain` as the first characters of a steer, and with a leading marker candidate of **U7** (a leading space, a zero-width marker, `\/probe-plain`), each as a second user message in the same session.
5. Repeat step 3 with `~/.claude/skills/probe-plain` replaced by the copy of `probe-hook`, with `HOOK_MARK=/tmp/hook-mark`, and ask for "the hook probe word"; then `container exec grant-p1 test -e /tmp/hook-mark`.
6. Repeat step 3 with `/opt/dipo-grant/probe-hookpack` in place of the pack, and `container exec grant-p1 test -e /tmp/hook-mark` after the session.
7. Count the characters of the listings (`/skill-doctor` is not available with `-p`; read the `system/init` and the first request body the model proxy logs) for **U13** and **U14**: run the same fixed prompt twice, once with and once without the grant, and compare `cache_creation_input_tokens` and `cache_read_input_tokens` of the second run of each.

Expected:

- Step 2: `skills: []` in `system/init`, no `PLAIN-OK` (M2 holds).
- Step 3: `system/init` lists `skills` as `probe-plain` and `probe-pack:pack-skill` only and `plugins` as `probe-pack` only; no `probe-other`; `probe-project` is **not** listed (if it is, **U2** is true and the plan must switch it off with `skillOverrides` or remove the folder, and the probe is repeated with that); the answers are `PLAIN-OK` and `PACK-OK`; the other and project questions get no `OTHER-OK` or `PROJECT-OK`.
- Step 4: the engine-made marker form (the one that passes) makes the message a plain user message and does not expand a skill; the bare `/probe-plain` form expands it (M1) and is the reason the marker exists.
- Step 5: the engine's check refuses `probe-hook` before any session, with the key `hooks` named; handed to the box directly, the mark file is created only inside the box (and `HOOK_MARK` outside the box does not exist on the Mac): the box is the boundary.
- Step 6: likewise: the load-time check refuses `probe-hookpack` (`hooks/` and the manifest); run directly, a mark inside the box, and `system/init` lists `probe-hookpack`, so the extra-listing check of section 4 would stop the run when it is not in the grant.
- Step 7: the listing sizes and the cache counts, which set the two numbers of section 7 and answer **U14**.

### P2. A read-only box: a granted skill loads while the plan check still refuses every flag the grant does not need

Setup: the common scratch repository; a read-only box made as a reviewer's (`git archive` copy of the commit, no `box.files`, same firewall, user and proxies) named `grant-p2`; the plan built by the real `plan` of the reviewer kind (`packages/engine/src/workers/claude-cli/box-plan.ts`) so the probe tests the real check, not a hand-written argv.

Commands, in order:

1. `container exec grant-p2 sh -c 'mkdir -p ~/.claude/skills && cp -R /work/.dipo/skills/probe-plain ~/.claude/skills/'`.
2. Start the reviewer's session with the plan unchanged except that `--tools` carries `Skill` as in section 4 and `--disable-slash-commands` is dropped; read `system/init`; ask "What is the plain probe word?" and "What is the other probe word?" (**U5**).
3. For each of `--settings '{}'`, `--plugin-dir /opt/dipo-grant/probe-pack`, `--agents '{}'`, `--allowedTools Skill`, `--mcp-config x`, `--permission-prompt-tool x`, `--dangerously-skip-permissions`, in upper and lower case and as `--flag=value`: call `checkReadOnlyArgv("review", [...plan, flag])` and read the error.
4. Put a granted skill with the `hooks` key in `~/.claude/skills`, ask for its word, and then read `/tmp/hook-mark` inside the box (the hook, if it runs, finds a kind without Bash: **U9**).
5. Copy `probe-pack` to `/opt/dipo-grant/` with a `.mcp.json` that starts `touch /tmp/mcp-mark`, run the session with `--strict-mcp-config` and `--plugin-dir` added to the argv without `checkReadOnlyArgv` (a probe-only bypass of the check) and read the mark (**U10**).

Expected:

- Step 2: `system/init` `skills` is `probe-plain` only, `tools` is the kind's list plus `Skill`, the first answer is `PLAIN-OK`, the second has no `OTHER-OK`; no `Bash`, `Write` or `Edit` in the list.
- Step 3: every flag is refused with its name in the message (`a review session's plan may not pass ...`), and the plan of step 2 passes the check; the grant needed no flag.
- Step 4: the real check refuses the skill before a session; in the bypass, no mark file (a read-only kind has no tool to run it, or the hook ran inside the box and wrote nothing outside it).
- Step 5: no `/tmp/mcp-mark`; `--strict-mcp-config` stops the plugin's server, so a plugin's `.mcp.json` does not start. If a mark appears, plugins stay out of every read-only kind and the load-time check is the only guard, as section 4 already recommends.

### P3. The scan on the Mac: a granted skill or plugin cannot run a command outside the guard

Setup: the common scratch repository; the Mac's `claude` at the version the probe command reports; a fresh run home `$SCRATCH/home` that holds only a copy of the login the adapter copies for a Mac session (no such home or copy exists: the scan runs with the maintainer's `HOME`, see the results; the run of 2026-11-28 used an empty scratch `HOME` and the probe model proxy in its place); `HOOK_MARK=$SCRATCH/hook-mark` set in the session's environment; the plan built by the real scan plan of `plan.ts` (every tool off, `--disable-slash-commands`, the run settings with `enabledPlugins` false for installed plugins); the maintainer's own `~/.claude` is not touched.

Commands, in order:

1. Copy `probe-plain` to `$SCRATCH/home/.claude/skills/`. Start the scan plan with `--disable-slash-commands` kept and `--tools ""` as today; ask "What is the plain probe word?"; read `system/init` (**U12**: whether a session with no tool can use a skill at all).
2. Drop `--disable-slash-commands` and set `--tools Skill`; repeat.
3. Add `"disableAllHooks": true` to the run settings; copy `probe-hook` into the run home's skills and ask for the hook probe word; read `$SCRATCH/hook-mark` (**U11**).
4. Repeat step 3 without `disableAllHooks`, to see what the setting guards; read the mark.
5. Copy `probe-hookpack` to a plugin folder and start the session with `--plugin-dir` pointing at it, with and without `disableAllHooks`; read the mark (SessionStart runs before `system/init`, M4).
6. Run the engine's load-time check on `.dipo/skills/probe-hook`, `.dipo/plugins/probe-hookpack` and `.dipo/plugins/probe-pack` for the scan's grant.
7. `ls "$HOME/.claude/skills" "$HOME/.claude/plugins"` before and after all steps: the maintainer's home is the same.

Expected:

- Step 1: either `skills` is `[]` and no `PLAIN-OK` (a skill needs the flag off), or the skill loads: the result decides **U12** and the plan's flags for the scan.
- Step 2: `skills` is `probe-plain` only, the answer is `PLAIN-OK`, and the `tools` list is `Skill` and nothing else: no `Bash`, `Read`, `Write` or `WebFetch`.
- Step 3: no `$SCRATCH/hook-mark`; the guard holds with `disableAllHooks`.
- Step 4 may create the mark. If it does, it proves why the load-time check and `disableAllHooks` are both required, and is recorded as such; if it does not, the layers are redundant and both stay.
- Step 5: with `disableAllHooks` the plugin's SessionStart hook does not run; without it it may. If the mark appears **with** `disableAllHooks`, plugins are refused for the scan, which the decision already says, and nothing changes. If a mark appears from a **skill** with `disableAllHooks` (step 3), P3 fails: the scan moves into a box (option A of section 6) and 0023 is not approved with B.
- Step 6: the check refuses `probe-hook` (`hooks` key) and `probe-hookpack` (`hooks/`, the manifest), and passes `probe-pack` for a developer grant, while a scan grant naming any plugin is refused at load.
- Step 7: both listings are the same before and after.

### The claims and their results (2026-11-28)

Run by the maintainer's orchestrating session: Claude Code 2.1.303 in the boxes (dipo's office image, Apple `container` 1.6.0, on `dipo-boxes`), 2.1.332 on the Mac, every session on Haiku through the probe model proxy, the scratch repository above. The boxes were made as the steps say but without dipo's firewall, which no claim below depends on. Each line of the run is in `tools/box-probe/RESULTS.md`.

| Id | Claim, from Claude Code's documentation | Probe | Result |
|---|---|---|---|
| U1 | `--disable-slash-commands` also turns off the skills of the Skill tool, so a plan with a grant drops it | P1 step 2, P3 step 1 | True: `skills: []`, no granted skill loads |
| U2 | A repository's `.claude/skills` is listed when the flag is dropped, and needs `skillOverrides` or removal | P1 step 3 | True in a developer box, listed and usable: the engine removes it from the copy. Not listed in a read-only box (`--setting-sources user`) |
| U3 | A personal skill is listed as its plain name; a plugin's as `<plugin>:<name>` | P1 step 3 | True |
| U4 | `--plugin-dir` loads a plugin for the session with no install, and what `system/init` lists for it | P1 step 3 | True: `<name>@inline` with its folder as `path`, and its skill usable |
| U5 | A personal skill loads in a read-only box that passes no settings flag | P2 steps 2 and 4 | True: listed (step 2) and invoked and used (step 4) |
| U6 | A marketplace entry can be pinned to a commit, and a plugin's `version` pins it | not probed | Not measured by design: marketplace plugins are refused; a later ADR measures it |
| U7 | A leading marker keeps a steer from expanding a skill | P1 step 4 | True for a leading space, a zero-width space and a backslash; the engine uses a space |
| U8 | `claude plugin validate` agrees with the engine's manifest check | P1 steps 5 and 6 | Not measured: the engine's check is built by the implementation story, which compares the two |
| U9 | A skill's `hooks` run as documented, in a box that has no Bash | P1 step 5, P2 step 4 | True: the hook ran a command in the developer box and in the reviewer box, inside the box only |
| U10 | `--strict-mcp-config` also stops the `.mcp.json` of a `--plugin-dir` plugin | P2 step 5 | True; without the flag the server starts |
| U11 | `disableAllHooks` stops the hooks of skills and plugins | P3 steps 3 to 5 | True for a plugin's `SessionStart` hook on the Mac, which runs there without it; a skill with hooks was refused by the permission check before it ran |
| U12 | A session with every tool off cannot invoke a skill, and `--tools Skill` is enough | P3 steps 1 and 2 | `--tools Skill` is enough, with the `user` setting source and a scratch `HOME`; under the scan's `project,local` a personal skill does not load. "Every tool off" alone not isolated (step 1 kept the flag); not needed, as the scan gets no grant |
| U13 | A listing is cut at 1,536 characters, and what it costs in tokens | P1 step 7 | Cost measured (about 2,800 tokens for 21 short listings and the Skill tool); the cut not reached |
| U14 | A listing changes the prompt cache of L1+L2 | P1 step 7 | True: the grant changes the cached prefix |
| U15 | `skillOverrides` switches off a skill bundled with Claude Code | first implementation story | Found by P1: 18 bundled skills are listed once the flag is dropped. Not measured yet (section 4) |

Steps 6 of P1 and P3 (the engine's load-time check on the probe folders) and step 3's "the plan of step 2 passes the check" of P2 wait for the implementation stories: the load-time check does not exist yet, and today's read-only check refuses `Skill` because it is not yet one of a reviewer's tools.

## Open questions for the maintainer

- Whether plugins stay out of the read-only kinds in the first cut (recommended; P2 showed `--strict-mcp-config` stops a plugin's server, but a plugin's hooks would run as U9 shows).
- Whether a marketplace plugin may ever be a source (recommended: not in this ADR).
- Whether the scan stays without a grant (section 6, D, recommended after P3) or moves into a box (A) now.

## Replaced

Nothing yet. On approval, the rule that no session loads a skill or a plugin (0008) and the `worker.plugins` office key's replacement (0017) are replaced by this decision, in those ADRs' own Replaced lists.
