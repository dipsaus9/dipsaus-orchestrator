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

/** The engine package's own name: its entry, which engine code never imports. */
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
          if (isRequire(node.callee)) check(node.arguments[0]);
        },
      };
    },
  };
}

const CLAUDE_CLI_MESSAGE =
  "Claude specifics stay in packages/engine/src/workers/claude-cli (0004, CLAUDE.md). Reach the adapter through the WorkerPort (0008 section 1); only workers/claude-cli/** and the composition root (the engine entry and the wiring of createEngine) import it, type-only imports included.";
const ENGINE_ENTRY_MESSAGE =
  "Engine code does not import the engine entry, which is the daemon's (0004). Import the module itself; reach the adapter through the WorkerPort (0008 section 1).";

const DAEMON_ENGINE_MESSAGE =
  "The daemon imports from the engine only `createEngine`, types and the platform entry (0004, 0005): take a process piece from @dipsaus-orchestrator/engine/platform and reach everything else through the engine `createEngine` gives.";

/** The name an import or export specifier names in the module it reads from. */
function specifierName(node) {
  const name = node.imported ?? node.local;
  return name?.type === "Identifier" ? name.name : specifierOf(name);
}

/** The engine package's folder, as an absolute path a relative import resolves to. */
const ENGINE_DIR = /\/packages\/engine(\/|$)/;

/** True when `source` names the engine entry. */
function fromEngine(source) {
  return specifierOf(source) === ENGINE_PACKAGE;
}

/** True when `source` is a relative path into the engine package, resolved from `filename`. */
function intoEngine(source, filename) {
  const specifier = specifierOf(source);
  if (specifier === null || !specifier.startsWith(".")) return false;
  return ENGINE_DIR.test(resolve(dirname(filename), specifier).replaceAll("\\", "/"));
}

/** True when `callee` is `require` or `import.meta.require`. */
function isRequire(callee) {
  if (callee.type === "Identifier") return callee.name === "require";
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "MetaProperty" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "require"
  );
}

/**
 * The daemon's imports of the engine (0004): from the entry, `createEngine` and type-only imports
 * pass; any other value, a side-effect, namespace or default import, a re-export of a value,
 * `export *`, a dynamic import, `require`, `import.meta.require` or `import x = require(...)` of
 * the entry is reported, and so is any form of a relative path into the engine package. The
 * platform entry is another specifier, so it passes.
 */
const daemonEngineImports = {
  meta: {
    type: "problem",
    docs: { description: "Let the daemon import only createEngine, types and the platform entry." },
  },
  create(context) {
    const report = (node) => context.report({ node, message: DAEMON_ENGINE_MESSAGE });
    const deep = (source) => intoEngine(source, context.filename);
    const checkSpecifiers = (node, kindOf) => {
      if (node.specifiers.length === 0) report(node);
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier" || specifier.type === "ExportSpecifier") {
          if (kindOf(specifier) === "type" || specifierName(specifier) === "createEngine") continue;
        }
        report(specifier);
      }
    };
    return {
      ImportDeclaration(node) {
        if (deep(node.source)) report(node);
        if (!fromEngine(node.source) || node.importKind === "type") return;
        checkSpecifiers(node, (specifier) => specifier.importKind);
      },
      ExportNamedDeclaration(node) {
        if (deep(node.source)) report(node);
        if (!fromEngine(node.source) || node.exportKind === "type") return;
        checkSpecifiers(node, (specifier) => specifier.exportKind);
      },
      ExportAllDeclaration(node) {
        if (deep(node.source) || (fromEngine(node.source) && node.exportKind !== "type")) {
          report(node);
        }
      },
      ImportExpression(node) {
        if (fromEngine(node.source) || deep(node.source)) report(node);
      },
      TSExternalModuleReference(node) {
        if (fromEngine(node.expression) || deep(node.expression)) report(node);
      },
      TSImportType(node) {
        if (deep(node.source ?? node.argument)) report(node);
      },
      CallExpression(node) {
        if (!isRequire(node.callee)) return;
        if (fromEngine(node.arguments[0]) || deep(node.arguments[0])) report(node);
      },
    };
  },
};

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

/** True when every one of `specifiers` is type-only. */
function allTypes(specifiers, kindOf) {
  return specifiers.length > 0 && specifiers.every((specifier) => kindOf(specifier) === "type");
}

/**
 * Calls `check(source, typeOnly)` for every module a file names: a static import or re-export, a
 * side-effect import, `export *`, a dynamic import, `require`, `import.meta.require`,
 * `import x = require(...)` and `typeof import(...)`. `typeOnly` is true when the form carries
 * only types, so it loads nothing at run time.
 */
function importVisitors(check) {
  return {
    ImportDeclaration: (node) =>
      check(
        node.source,
        node.importKind === "type" || allTypes(node.specifiers, (s) => s.importKind),
      ),
    ExportNamedDeclaration(node) {
      if (node.source === null || node.source === undefined) return;
      check(
        node.source,
        node.exportKind === "type" || allTypes(node.specifiers, (s) => s.exportKind),
      );
    },
    ExportAllDeclaration: (node) => check(node.source, node.exportKind === "type"),
    ImportExpression: (node) => check(node.source, false),
    TSExternalModuleReference: (node) => check(node.expression, false),
    TSImportType: (node) => check(node.source ?? node.argument, true),
    CallExpression(node) {
      if (isRequire(node.callee)) check(node.arguments[0], false);
    },
  };
}

/**
 * What each package may import of the others (0004), the one list: `imports` for every file,
 * `tests` on top for its test files. The contract imports nothing but zod.
 */
const PACKAGE_IMPORTS = {
  contract: { imports: [], tests: [] },
  engine: { imports: ["contract"], tests: ["testkit"] },
  daemon: { imports: ["contract", "engine"], tests: ["testkit"] },
  client: { imports: ["contract"], tests: ["testkit"] },
  tui: { imports: ["contract", "client"], tests: [] },
  cli: { imports: ["contract", "client", "tui", "daemon"], tests: ["testkit"] },
  testkit: { imports: ["contract"], tests: [] },
};

const WORKSPACE = /^@dipsaus-orchestrator\/([^/]+)(?:\/(.*))?$/;
/** A file in a package: the package folder (the last `packages/<name>/` of the path) and the rest. */
const PACKAGE_FILE = /^(.*\/packages\/([^/]+)\/)(.*)$/;
const TEST_FILE = /(^|\/)test\/|\.test\.tsx?$/;

/** The package a file is in, the path inside it and whether it is a test file; null outside one. */
function packageOf(filename) {
  const match = PACKAGE_FILE.exec(filename.replaceAll("\\", "/"));
  if (match === null) return null;
  const [, root, name, inside] = match;
  return {
    name,
    root,
    source: inside.startsWith("src/") && !TEST_FILE.test(inside),
    test: TEST_FILE.test(inside),
  };
}

/** Why `specifier`, named by a file of `own`, breaks a package boundary (0004); null if it does not. */
function packageImportMessage(specifier, filename, own) {
  const workspace = WORKSPACE.exec(specifier);
  if (workspace !== null) {
    const [, target, rest] = workspace;
    if (rest !== undefined && (rest === "src" || rest.startsWith("src/"))) {
      return "Deep imports are banned (0004). Import the package entry instead.";
    }
    if (target === own.name) return null;
    const rules = PACKAGE_IMPORTS[own.name];
    const allowed = rules === undefined ? [] : [...rules.imports, ...(own.test ? rules.tests : [])];
    if (allowed.includes(target)) return null;
    const list = allowed.length === 0 ? "no other package" : allowed.join(", ");
    return `${own.name} imports only ${list} (0004); it never imports ${target}.`;
  }
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(filename), specifier).replaceAll("\\", "/");
    if (!`${target}/`.startsWith(own.root)) {
      return "No package reaches into another package's files by relative path (0004). Import its entry instead.";
    }
    return null;
  }
  if (own.name === "contract" && own.source && specifier !== "zod") {
    return "The contract imports nothing but zod and its own files (0004, 0005): no I/O and no other module.";
  }
  return null;
}

/**
 * The package bans of 0004 over every import form, also a dynamic import and `require`. A file
 * outside `packages/` (the root `test/` with its cross-package tests, `tools/`) is no package, so
 * the rule leaves it alone: the written exception of 0004.
 */
const packageImports = {
  meta: {
    type: "problem",
    docs: { description: "Let each package import only the packages 0004 allows." },
  },
  create(context) {
    const own = packageOf(context.filename);
    if (own === null) return {};
    return importVisitors((source) => {
      const specifier = specifierOf(source);
      const message =
        specifier === null ? null : packageImportMessage(specifier, context.filename, own);
      if (message !== null) context.report({ node: source, message });
    });
  },
};

/**
 * The engine's layers, lowest first (0004), the one list: every directory of `packages/engine/src`
 * and every file at its top. A file imports a value only from its own layer or a lower one;
 * types may cross. Until the layering spike sets finer layers, all the engine's orchestration is
 * one domain layer between the base and the composition root.
 */
const ENGINE_LAYERS = [
  {
    name: "base",
    entries: [
      "changelog",
      "config",
      "context",
      "git",
      "host",
      "keepawake",
      "log",
      "platform",
      "software-stream",
      "story-store",
      "wiring",
    ],
  },
  {
    name: "domain",
    entries: [
      "backlog",
      "backup",
      "box",
      "commands",
      "db",
      "gate",
      "hooks",
      "ingest",
      "merge",
      "office",
      "pricing",
      "prompts",
      "reads",
      "reconcile",
      "retention",
      "review",
      "run",
      "runs",
      "scan",
      "stories",
      "story-pr",
      "views",
      "workers",
      "worktree",
    ],
  },
  {
    name: "composition",
    entries: ["create", "features.ts", "index.ts", "platform-entry.ts"],
  },
];

const ENGINE_SRC = /\/packages\/engine\/src\/(.+)$/;

/** The layer index of a path inside `packages/engine/src`, -1 for an unlisted entry, null outside. */
function engineLayer(path) {
  const match = ENGINE_SRC.exec(path.replaceAll("\\", "/"));
  if (match === null) return null;
  const inside = match[1];
  const entry = inside.includes("/") ? inside.slice(0, inside.indexOf("/")) : inside;
  const candidates = [entry, `${entry}.ts`, entry.replace(/\.[cm]?[jt]sx?$/, ".ts")];
  const index = ENGINE_LAYERS.findIndex((layer) =>
    layer.entries.some((name) => candidates.includes(name)),
  );
  return { index, entry };
}

/** No value import from a higher engine layer into a lower one (0004). */
const engineLayers = {
  meta: {
    type: "problem",
    docs: { description: "Refuse a value import from a higher engine layer into a lower one." },
  },
  create(context) {
    const own = engineLayer(context.filename);
    if (own === null || context.filename.endsWith(".test.ts")) return {};
    if (own.index === -1) {
      return {
        Program(node) {
          context.report({
            node,
            message: `packages/engine/src/${own.entry} is in no engine layer; add it to ENGINE_LAYERS in tools/lint/oxlint-plugin.js (0004).`,
          });
        },
      };
    }
    return importVisitors((source, typeOnly) => {
      const specifier = specifierOf(source);
      if (typeOnly || specifier === null || !specifier.startsWith(".")) return;
      const target = engineLayer(resolve(dirname(context.filename), specifier));
      if (target === null || target.index <= own.index) return;
      const from = ENGINE_LAYERS[own.index].name;
      const to = target.index === -1 ? "no layer" : ENGINE_LAYERS[target.index].name;
      context.report({
        node: source,
        message: `The ${from} layer of the engine imports no value from the ${to} layer (0004): ${own.entry} may not import ${target.entry}.`,
      });
    });
  },
};

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
    "daemon-engine-imports": daemonEngineImports,
    "package-imports": packageImports,
    "engine-layers": engineLayers,
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
