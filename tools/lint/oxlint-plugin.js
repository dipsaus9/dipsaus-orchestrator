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

export default {
  meta: { name: "dipo" },
  rules: {
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
