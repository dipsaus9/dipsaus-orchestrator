// Local oxlint rules for what the built-in rules cannot express (0017 section 4).
// oxlint has no `no-restricted-syntax`, so `new Date()` without arguments needs its own rule;
// `new Date(value)` stays allowed because it reads no clock.
//
// The engine seams (0004, 0008 section 1; DIPO-113) are rules of their own, not
// `no-restricted-imports` patterns: an override replaces a rule's whole option list, so a ban
// added to that rule would have to be repeated in every engine override. They are scoped by
// `.oxlintrc.json` overrides: on for `packages/engine/src/**` (the Bun rules also for
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
  "Claude specifics stay in packages/engine/src/workers/claude-cli (0004, CLAUDE.md). Reach the adapter through the WorkerPort (0008 section 1); only workers/claude-cli/** and the engine entry import it, type-only imports included.";
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

const GIT_SPAWN_MESSAGE =
  "Only the git module (packages/engine/src/git) starts git (0010): run a hardened step through its runner (`runGitStep`, an office's `GitSession`).";
const GIT_WRITE_MESSAGE =
  "Commits, ref changes, pushes and branch deletes go through the git writer (packages/engine/src/git/write.ts, 0010), never a raw git step.";

/** Calls that start a process from an argument list. */
const SPAWNERS = new Set(["spawn", "spawnSync", "exec", "execFile", "execFileSync", "execSync"]);

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

/** True when `node` names the git program: `"git"`, `x ?? "git"`, or a binding called `git`. */
function isGitProgram(node) {
  if (node == null) return false;
  if (specifierOf(node) === "git") return true;
  if (node.type === "LogicalExpression") return isGitProgram(node.left) || isGitProgram(node.right);
  if (node.type === "Identifier") return node.name === "git";
  return node.type === "MemberExpression" && !node.computed && node.property.name === "git";
}

/** The array literals an argument may hold: itself, or both branches of a conditional. */
function arraysOf(node) {
  if (node == null) return [];
  if (node.type === "ArrayExpression") return [node];
  if (node.type === "ConditionalExpression") {
    return [...arraysOf(node.consequent), ...arraysOf(node.alternate)];
  }
  return [];
}

/** True when the argument list `array` runs a git verb that writes (see `GIT_WRITE_VERBS`). */
function writesGit(array) {
  const words = array.elements.map((element) => specifierOf(element));
  const verb = words.find((word) => word !== null && !word.startsWith("-"));
  if (verb === undefined) return false;
  if (GIT_WRITE_VERBS.has(verb)) return true;
  return BRANCHING_VERBS.has(verb) && words.some((word) => BRANCH_FLAGS.has(word));
}

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
    "git-module-only": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Ban starting git, and git steps that commit, move or delete a ref or push, outside the git module.",
        },
      },
      create(context) {
        const reportSpawn = (node) => context.report({ node, message: GIT_SPAWN_MESSAGE });
        const reportWrites = (node) => {
          for (const array of arraysOf(node)) {
            if (writesGit(array)) context.report({ node: array, message: GIT_WRITE_MESSAGE });
          }
        };
        return {
          // `spawn({ cmd: ["git", ...] })`, `Bun.spawn(["git", ...])`, `execFile("git", ...)`.
          Property(node) {
            const key = node.key.type === "Identifier" ? node.key.name : specifierOf(node.key);
            if (key !== "cmd") return;
            for (const array of arraysOf(node.value)) {
              if (isGitProgram(array.elements[0])) reportSpawn(array);
            }
          },
          CallExpression(node) {
            const name = calleeName(node);
            if (name !== null && SPAWNERS.has(name)) {
              const [first] = node.arguments;
              if (isGitProgram(first)) reportSpawn(first);
              for (const array of arraysOf(first)) {
                if (isGitProgram(array.elements[0])) reportSpawn(array);
              }
            }
            // A git argument list that writes, passed to any call (`session.ok(location, ["push",
            // ...])`, a helper of the caller's own) or bound to a name for one.
            for (const argument of node.arguments) reportWrites(argument);
          },
          VariableDeclarator(node) {
            reportWrites(node.init);
          },
        };
      },
    },
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
