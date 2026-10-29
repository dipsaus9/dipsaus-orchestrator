// Local oxlint rules for what the built-in rules cannot express (0017 section 4).
// oxlint has no `no-restricted-syntax`, so `new Date()` without arguments needs its own rule;
// `new Date(value)` stays allowed because it reads no clock.
//
// The engine seams (0004, 0008 section 1; DIPO-113) and the StoryStore seam (0010) are rules of
// their own, not `no-restricted-imports` patterns: an override replaces a rule's whole option
// list, so a ban added to that rule would have to be repeated in every engine override. They are
// scoped by `.oxlintrc.json` overrides: on for `packages/engine/src/**` (the Bun rules also for
// `packages/daemon/src/**`), off where the seam allows the import.

import { dirname, resolve } from "node:path";

/** A deep import path through the Claude CLI adapter directory. */
const CLAUDE_CLI = /(^|\/)workers\/claude-cli(\/|$)/;

/** The Claude CLI adapter directory, as an absolute path a relative import resolves to. */
const CLAUDE_CLI_DIR = /\/packages\/engine\/src\/workers\/claude-cli(\/|$)/;

/** The engine entry, as an absolute path a relative import resolves to (a directory import too). */
const ENGINE_ENTRY = /\/packages\/engine\/src(\/index(\.[cm]?[jt]s)?)?$/;

/** The engine package's own name; its entry re-exports the adapter. */
const ENGINE_PACKAGE = "@dipsaus-orchestrator/engine";

/** The Backlog.md StoryStore directory, as an absolute path a relative import resolves to. */
const BACKLOG_DIR = /\/packages\/engine\/src\/backlog(\/|$)/;

/** The Backlog.md directory as a deep path into the engine package. */
const BACKLOG_DEEP = /^@dipsaus-orchestrator\/engine\/src\/backlog(\/|$)/;

/** `bun` and every `bun:*` module but the test runner (0004 lists `bun:test` as a touchpoint). */
const BUN = /^bun(:(?!test$).+)?$/;

/**
 * The module specifier a node names: a string literal, a template literal without expressions,
 * or the literal of a TS import type; null for anything computed.
 */
function specifierOf(node) {
  if (node == null) return null;
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral") {
    return node.expressions.length === 0 ? (node.quasis[0]?.value.cooked ?? null) : null;
  }
  if (node.type === "TSLiteralType") return specifierOf(node.literal);
  return null;
}

/**
 * Reports every import, re-export, dynamic import, `require`, `import x = require(...)` and
 * `typeof import(...)`, type-only ones included, for which `messageFor(specifier, filename)`
 * returns a message.
 */
function importRule(description, messageFor) {
  return {
    meta: { type: "problem", docs: { description } },
    create(context) {
      const check = (source) => {
        const specifier = specifierOf(source);
        const message = specifier === null ? null : messageFor(specifier, context.filename);
        if (message !== null) context.report({ node: source, message });
      };
      return {
        ImportDeclaration: (node) => check(node.source),
        ExportNamedDeclaration: (node) => check(node.source),
        ExportAllDeclaration: (node) => check(node.source),
        ImportExpression: (node) => check(node.source),
        TSExternalModuleReference: (node) => check(node.expression),
        TSImportType: (node) => check(node.source ?? node.argument),
        CallExpression(node) {
          if (node.callee.type === "Identifier" && node.callee.name === "require") {
            check(node.arguments[0]);
          }
        },
      };
    },
  };
}

const CLAUDE_CLI_MESSAGE =
  "Claude specifics stay in packages/engine/src/workers/claude-cli (0004, CLAUDE.md). Reach the adapter through the WorkerPort (0008 section 1); only workers/claude-cli/** and the composition root (the engine entry and packages/engine/src/create) import it, type-only imports included.";
const ENGINE_ENTRY_MESSAGE =
  "Engine code does not import the engine entry, which re-exports the Claude CLI adapter for the daemon (0004). Import the module itself; reach the adapter through the WorkerPort (0008 section 1).";

/**
 * A path into `engine/src/workers/claude-cli`, or to the engine entry that re-exports it; relative
 * paths are resolved from the importing file.
 */
function claudeCliMessage(specifier, filename) {
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(filename), specifier).replaceAll("\\", "/");
    if (CLAUDE_CLI_DIR.test(target)) return CLAUDE_CLI_MESSAGE;
    return ENGINE_ENTRY.test(target) ? ENGINE_ENTRY_MESSAGE : null;
  }
  if (specifier === ENGINE_PACKAGE) return ENGINE_ENTRY_MESSAGE;
  return CLAUDE_CLI.test(specifier) ? CLAUDE_CLI_MESSAGE : null;
}

const BACKLOG_MESSAGE =
  "The engine reads and writes stories only through the StoryStore (0010): import packages/engine/src/story-store and take the store as a dependency. Only the Backlog.md implementation in packages/engine/src/backlog and the composition root import backlog/.";

/** A path into `engine/src/backlog`; relative paths are resolved from the importing file. */
function backlogMessage(specifier, filename) {
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(filename), specifier).replaceAll("\\", "/");
    return BACKLOG_DIR.test(target) ? BACKLOG_MESSAGE : null;
  }
  return BACKLOG_DEEP.test(specifier) ? BACKLOG_MESSAGE : null;
}

const BUN_MESSAGE =
  "Engine and daemon code reach Bun-specific APIs only through packages/engine/src/platform (0004), so a move to Node stays a change to that module.";
const BUN_GLOBAL_MESSAGE =
  "Engine and daemon code reach Bun-specific APIs (Bun.spawn, Bun.serve, Bun.file) only through packages/engine/src/platform (0004).";

/** True when `node` is `<object>.Bun` or `<object>["Bun"]` with `node` as the object. */
function readsBun(node) {
  const member = node.parent;
  if (member?.type !== "MemberExpression" || member.object !== node) return false;
  if (!member.computed)
    return member.property.type === "Identifier" && member.property.name === "Bun";
  return specifierOf(member.property) === "Bun";
}

/** The test runner's registration functions a CI-only file may call only behind its guard. */
const REGISTRATIONS = new Set(["describe", "it", "test"]);

const CI_GUARD_MESSAGE =
  'A *.ci.test.ts file registers its tests only when DIPO_TEST_CI is 1 (0017 section 1): put every top-level describe, it or test inside `if (process.env["DIPO_TEST_CI"] === "1") { ... }` (or a top-level const bound to that comparison), or use `describe.if(<that>)`.';

/** `process.env.DIPO_TEST_CI` or `process.env["DIPO_TEST_CI"]`. */
function readsCiVariable(node) {
  if (node?.type !== "MemberExpression") return false;
  const name = node.computed
    ? specifierOf(node.property)
    : node.property.type === "Identifier"
      ? node.property.name
      : null;
  if (name !== "DIPO_TEST_CI") return false;
  const env = node.object;
  if (env?.type !== "MemberExpression" || env.computed) return false;
  return (
    env.property.type === "Identifier" &&
    env.property.name === "env" &&
    env.object.type === "Identifier" &&
    env.object.name === "process"
  );
}

/** The string literal "1". */
function isOne(node) {
  return node.type === "Literal" && node.value === "1";
}

/** `<DIPO_TEST_CI> === "1"` either way round, or a name bound to it (`guards`). */
function isCiGuard(node, guards) {
  if (node == null) return false;
  if (node.type === "Identifier") return guards.has(node.name);
  if (node.type !== "BinaryExpression" || node.operator !== "===") return false;
  return (
    (readsCiVariable(node.left) && isOne(node.right)) ||
    (readsCiVariable(node.right) && isOne(node.left))
  );
}

/** The registration a call makes (`describe`, `it.each(...)`, `describe.if(x)` ...), or null. */
function registrationOf(call) {
  let callee = call.callee;
  let guardedBy = null;
  for (;;) {
    if (callee.type === "Identifier") {
      return REGISTRATIONS.has(callee.name) ? { name: callee.name, guardedBy } : null;
    }
    if (callee.type === "MemberExpression") {
      callee = callee.object;
      continue;
    }
    if (callee.type === "CallExpression") {
      // `describe.if(guard)(...)`: the inner call's argument is the guard.
      const inner = callee.callee;
      if (
        inner.type === "MemberExpression" &&
        !inner.computed &&
        inner.property.type === "Identifier" &&
        inner.property.name === "if"
      ) {
        guardedBy = callee.arguments[0] ?? null;
      }
      callee = inner;
      continue;
    }
    return null;
  }
}

const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

// ---- the git module (0010) ----------------------------------------------------------------------
// Two rules, so a file may be allowed to start git for a read (the CLI's repository lookup) while
// the ban on git writes still holds there:
// - `no-git-spawn`: no file outside the git module starts git: a `cmd` list or a spawn call whose
//   program is git (by basename, so `/usr/bin/git` too, also through a `const` or `x ?? "git"`),
//   or a `$` template that starts with git;
// - `no-git-write`: no file outside the git module passes a git argument list that commits, moves
//   or deletes a ref, or pushes (the verb found after the options and the values of `-c` and `-C`),
//   to any call, in a `cmd` list, bound to a `const`, or in a `$` template.
// Both are about git on the Mac. The box's own repository (`engine/src/box/box-git.ts`, 0008) is
// not: dipo runs its fixed init script inside the box, as the box user, through the box
// interface's exec, so it starts no git on the Mac and needs no exception here.

const GIT_SPAWN_MESSAGE =
  "Only the git module (packages/engine/src/git) starts git (0010): run a hardened step through its runner (`runGitStep`, an office's `GitSession`).";
const GIT_WRITE_MESSAGE =
  "Commits, ref changes, pushes and branch deletes go through the git writer (packages/engine/src/git/write.ts, 0010), never a raw git step.";

/** Calls that start a process from a program and an argument list. */
const SPAWNERS = new Set(["spawn", "spawnSync", "exec", "execFile", "execFileSync", "execSync"]);

/** A program whose basename is `git`. */
const GIT_PROGRAM = /(^|\/)git$/;

/** git options that take the next word as their value. */
const VALUE_OPTIONS = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

/** git verbs that make a commit, move or delete a ref, or change the remote. */
const GIT_WRITE_VERBS = new Set([
  "am",
  "branch",
  "cherry-pick",
  "commit",
  "commit-tree",
  "merge",
  "pull",
  "push",
  "rebase",
  "reset",
  "revert",
  "tag",
  "update-ref",
]);

/** Verbs that create a branch with one of `BRANCH_FLAGS`. */
const BRANCHING_VERBS = new Set(["checkout", "switch", "worktree"]);
const BRANCH_FLAGS = new Set(["-b", "-B", "-c", "-C"]);

/** The callee's name: `f` of `f(...)`, `m` of `x.m(...)`; null otherwise. */
function calleeName(call) {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) {
    return callee.property.type === "Identifier" ? callee.property.name : null;
  }
  return null;
}

/**
 * The `const` bindings of a file by name, so an identifier is followed to its initializer. Names
 * are not scoped: two constants of one name in different functions both count.
 */
function constants() {
  const byName = new Map();
  return {
    record(declarator) {
      if (declarator.parent?.kind !== "const" || declarator.id.type !== "Identifier") return;
      if (declarator.init != null) byName.set(declarator.id.name, declarator.init);
    },
    /** `node`, or the initializer an identifier is bound to (followed a few steps). */
    resolve(node) {
      let current = node;
      for (let step = 0; step < 4 && current?.type === "Identifier"; step++) {
        const init = byName.get(current.name);
        if (init === undefined) break;
        current = init;
      }
      while (current?.type === "TSAsExpression" || current?.type === "TSSatisfiesExpression") {
        current = current.expression;
      }
      return current;
    },
  };
}

/** The text of a word: a string literal, a template without expressions, or a constant of one. */
function wordOf(node, consts) {
  return specifierOf(consts.resolve(node));
}

/** True when `node` names the git program: `"git"`, `"/usr/bin/git"`, `x ?? "git"`, a binding `git`. */
function isGitProgram(node, consts) {
  if (node == null) return false;
  const word = wordOf(node, consts);
  if (word !== null) return GIT_PROGRAM.test(word);
  const resolved = consts.resolve(node);
  if (resolved !== node) return isGitProgram(resolved, consts);
  if (node.type === "LogicalExpression") {
    return isGitProgram(node.left, consts) || isGitProgram(node.right, consts);
  }
  if (node.type === "ConditionalExpression") {
    return isGitProgram(node.consequent, consts) || isGitProgram(node.alternate, consts);
  }
  if (node.type === "Identifier") return node.name === "git";
  return node.type === "MemberExpression" && !node.computed && node.property.name === "git";
}

/** The array literals a value may hold: itself, a constant's, or both branches of a conditional. */
function arraysOf(node, consts) {
  const resolved = consts.resolve(node);
  if (resolved == null) return [];
  if (resolved.type === "ArrayExpression") return [resolved];
  if (resolved.type === "ConditionalExpression") {
    return [...arraysOf(resolved.consequent, consts), ...arraysOf(resolved.alternate, consts)];
  }
  return [];
}

/**
 * True when the words of a git command line write (see `GIT_WRITE_VERBS`): a leading git program
 * is skipped, then options and the values of `VALUE_OPTIONS`; unknown words (null) are skipped.
 */
function writesWords(words) {
  let at = words.length > 0 && words[0] !== null && GIT_PROGRAM.test(words[0]) ? 1 : 0;
  let verb;
  for (; at < words.length; at++) {
    const word = words[at];
    if (word === null) continue;
    if (VALUE_OPTIONS.has(word)) {
      at += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    verb = word;
    break;
  }
  if (verb === undefined) return false;
  if (GIT_WRITE_VERBS.has(verb)) return true;
  return BRANCHING_VERBS.has(verb) && words.slice(at + 1).some((word) => BRANCH_FLAGS.has(word));
}

/** The words of a `$` template's leading text, or null when it is not a `$` template. */
function shellWords(node) {
  const tag = node.tag;
  const dollar =
    (tag.type === "Identifier" && tag.name === "$") ||
    (tag.type === "MemberExpression" && !tag.computed && tag.property.name === "$");
  if (!dollar) return null;
  return (node.quasi.quasis[0]?.value.cooked ?? "").trim().split(/\s+/);
}

/** A git rule from `visitors`, each called at the end of the file with `report` and the constants. */
function gitRule(description, message, visitors) {
  return {
    meta: { type: "problem", docs: { description } },
    create(context) {
      const consts = constants();
      const reported = new Set();
      const report = (node) => {
        if (reported.has(node)) return;
        reported.add(node);
        context.report({ node, message });
      };
      // Every check waits for the end of the file, so a constant declared below its use resolves.
      const pending = [];
      const later = (fn) => (node) => pending.push(() => fn(node, report, consts));
      const handlers = {};
      for (const [type, fn] of Object.entries(visitors)) handlers[type] = later(fn);
      const record = handlers.VariableDeclarator;
      handlers.VariableDeclarator = (node) => {
        consts.record(node);
        record?.(node);
      };
      handlers["Program:exit"] = () => {
        for (const run of pending) run();
      };
      return handlers;
    },
  };
}

/** The value of a `cmd` property (`{ cmd: [...] }`, or shorthand `{ cmd }`), else undefined. */
function cmdValue(property) {
  const key = property.key.type === "Identifier" ? property.key.name : specifierOf(property.key);
  return key === "cmd" ? property.value : undefined;
}

const gitSpawnRule = gitRule("Ban starting git outside the git module.", GIT_SPAWN_MESSAGE, {
  Property(node, report, consts) {
    const value = cmdValue(node);
    if (value === undefined) return;
    for (const array of arraysOf(value, consts)) {
      if (isGitProgram(array.elements[0], consts)) report(array);
    }
  },
  CallExpression(node, report, consts) {
    const name = calleeName(node);
    if (name === null || !SPAWNERS.has(name)) return;
    const [first] = node.arguments;
    if (isGitProgram(first, consts)) report(first);
    for (const array of arraysOf(first, consts)) {
      if (isGitProgram(array.elements[0], consts)) report(array);
    }
  },
  TaggedTemplateExpression(node, report, consts) {
    const words = shellWords(node);
    if (words === null) return;
    const leading = words[0] ?? "";
    const program = leading === "" ? node.quasi.expressions[0] : null;
    if (GIT_PROGRAM.test(leading) || isGitProgram(program, consts)) report(node);
  },
});

const gitWriteRule = gitRule(
  "Ban git steps that commit, move or delete a ref, or push, outside the git module.",
  GIT_WRITE_MESSAGE,
  {
    CallExpression(node, report, consts) {
      for (const argument of node.arguments) {
        for (const array of arraysOf(argument, consts)) {
          if (writesWords(array.elements.map((element) => wordOf(element, consts)))) report(array);
        }
      }
    },
    VariableDeclarator(node, report, consts) {
      for (const array of arraysOf(node.init, consts)) {
        if (writesWords(array.elements.map((element) => wordOf(element, consts)))) report(array);
      }
    },
    Property(node, report, consts) {
      const value = cmdValue(node);
      if (value === undefined) return;
      for (const array of arraysOf(value, consts)) {
        if (writesWords(array.elements.map((element) => wordOf(element, consts)))) report(array);
      }
    },
    TaggedTemplateExpression(node, report) {
      const words = shellWords(node);
      if (words !== null && words.length > 0 && GIT_PROGRAM.test(words[0]) && writesWords(words)) {
        report(node);
      }
    },
  },
);

export default {
  meta: { name: "dipo" },
  rules: {
    "ci-test-guard": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Require every top-level test registration in a *.ci.test.ts file to sit behind the DIPO_TEST_CI guard.",
        },
      },
      create(context) {
        /** Top-level `const` names bound to the guard comparison. */
        const guards = new Set();
        return {
          Program(program) {
            for (const statement of program.body) {
              const declaration =
                statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
              if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
                continue;
              }
              for (const declarator of declaration.declarations) {
                if (declarator.id.type === "Identifier" && isCiGuard(declarator.init, guards)) {
                  guards.add(declarator.id.name);
                }
              }
            }
          },
          CallExpression(node) {
            // Only the outermost call of a chain such as `describe.each(rows)(name, fn)`.
            if (node.parent?.type === "CallExpression" && node.parent.callee === node) return;
            const registration = registrationOf(node);
            if (registration === null) return;
            if (registration.guardedBy !== null && isCiGuard(registration.guardedBy, guards))
              return;
            let child = node;
            for (let parent = node.parent; parent != null; parent = parent.parent) {
              // Inside a function: the registration that calls it is the one checked.
              if (FUNCTIONS.has(parent.type)) return;
              if (
                parent.type === "IfStatement" &&
                parent.consequent === child &&
                isCiGuard(parent.test, guards)
              ) {
                return;
              }
              child = parent;
            }
            context.report({ node, message: CI_GUARD_MESSAGE });
          },
        };
      },
    },
    "no-git-spawn": gitSpawnRule,
    "no-git-write": gitWriteRule,
    "no-argless-date": {
      meta: {
        type: "problem",
        docs: { description: "Ban `new Date()` without arguments outside the platform module." },
      },
      create(context) {
        return {
          NewExpression(node) {
            if (
              node.callee.type === "Identifier" &&
              node.callee.name === "Date" &&
              node.arguments.length === 0
            ) {
              context.report({
                node,
                message:
                  "`new Date()` reads wall-clock time. Use the injected Clock (0017 section 4).",
              });
            }
          },
        };
      },
    },
    "no-claude-cli-import": importRule(
      "Ban imports of the Claude CLI adapter, directly or through the engine entry, outside it and the entry.",
      claudeCliMessage,
    ),
    "no-backlog-import": importRule(
      "Ban imports of the Backlog.md StoryStore implementation outside it and the composition root.",
      backlogMessage,
    ),
    "no-bun-import": importRule(
      "Ban `bun` and `bun:*` imports (but `bun:test`) outside engine/src/platform.",
      (specifier) => (BUN.test(specifier) ? BUN_MESSAGE : null),
    ),
    "no-bun-global": {
      meta: {
        type: "problem",
        docs: { description: "Ban the global `Bun` outside engine/src/platform." },
      },
      create(context) {
        return {
          // `Bun` is not a configured global, so its unshadowed references are the ones no scope
          // of the file resolves; a local `Bun`, a property name or a declaration is not one.
          "Program:exit"() {
            const global = context.sourceCode.scopeManager.globalScope;
            for (const { identifier } of global?.through ?? []) {
              if (identifier.name === "Bun") {
                context.report({ node: identifier, message: BUN_GLOBAL_MESSAGE });
              }
            }
          },
          // `globalThis` is a configured global (env `builtin`): a reference that resolves to it,
          // not to a local of that name, reading `.Bun` or `["Bun"]`.
          MemberExpression(node) {
            const object = node.object;
            if (
              object.type === "Identifier" &&
              object.name === "globalThis" &&
              readsBun(object) &&
              context.sourceCode.isGlobalReference(object)
            ) {
              context.report({ node, message: BUN_GLOBAL_MESSAGE });
            }
          },
        };
      },
    },
  },
};
