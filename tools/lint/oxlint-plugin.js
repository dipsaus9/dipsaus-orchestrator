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
 * `typeof import(...)`, type-only ones included, whose specifier `matches(specifier, filename)`.
 */
function importRule(description, matches, message) {
  return {
    meta: { type: "problem", docs: { description } },
    create(context) {
      const check = (source) => {
        const specifier = specifierOf(source);
        if (specifier !== null && matches(specifier, context.filename)) {
          context.report({ node: source, message });
        }
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

/** True for a path into `engine/src/workers/claude-cli`: relative ones resolved from the file. */
function intoClaudeCli(specifier, filename) {
  if (specifier.startsWith(".")) {
    return CLAUDE_CLI_DIR.test(resolve(dirname(filename), specifier).replaceAll("\\", "/"));
  }
  return CLAUDE_CLI.test(specifier);
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
      "Ban imports of the Claude CLI adapter outside it and the engine entry.",
      intoClaudeCli,
      "Claude specifics stay in packages/engine/src/workers/claude-cli (0004, CLAUDE.md). Reach the adapter through the WorkerPort (0008 section 1); only workers/claude-cli/** and the engine entry import it, type-only imports included.",
    ),
    "no-bun-import": importRule(
      "Ban `bun` and `bun:*` imports (but `bun:test`) outside engine/src/platform.",
      (specifier) => BUN.test(specifier),
      "Engine and daemon code reach Bun-specific APIs only through packages/engine/src/platform (0004), so a move to Node stays a change to that module.",
    ),
    "no-bun-global": {
      meta: {
        type: "problem",
        docs: { description: "Ban the global `Bun` outside engine/src/platform." },
      },
      create(context) {
        return {
          // The references no scope of the file resolves: a local `Bun` shadows the global, and a
          // property name or a declaration is not a reference.
          "Program:exit"() {
            const global = context.sourceCode.scopeManager.globalScope;
            for (const reference of global?.through ?? []) {
              if (reference.identifier.name !== "Bun") continue;
              context.report({
                node: reference.identifier,
                message:
                  "Engine and daemon code reach Bun-specific APIs (Bun.spawn, Bun.serve, Bun.file) only through packages/engine/src/platform (0004).",
              });
            }
          },
        };
      },
    },
  },
};
