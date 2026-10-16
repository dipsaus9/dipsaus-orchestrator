// Local oxlint rules for what the built-in rules cannot express (0017 section 4).
// oxlint has no `no-restricted-syntax`, so `new Date()` without arguments needs its own rule;
// `new Date(value)` stays allowed because it reads no clock.
//
// The engine seams (0004, 0008 section 1; DIPO-113) are rules of their own, not
// `no-restricted-imports` patterns: an override replaces a rule's whole option list, so a ban
// added to that rule would have to be repeated in every engine override. These rules match the
// import specifier only and are scoped by `.oxlintrc.json` overrides: on for
// `packages/engine/src/**`, off where the seam allows the import.

/** A relative or deep import path through the Claude CLI adapter directory. */
const CLAUDE_CLI = /(^|\/)workers\/claude-cli(\/|$)/;

/** `bun` and every `bun:*` module but the test runner (0004 lists `bun:test` as a touchpoint). */
const BUN = /^bun(:(?!test$).+)?$/;

/** Reports every import, re-export, dynamic import and `require` whose specifier matches. */
function importRule(description, pattern, message) {
  return {
    meta: { type: "problem", docs: { description } },
    create(context) {
      const check = (source) => {
        if (source?.type === "Literal" && typeof source.value === "string") {
          if (pattern.test(source.value)) context.report({ node: source, message });
        }
      };
      return {
        ImportDeclaration: (node) => check(node.source),
        ExportNamedDeclaration: (node) => check(node.source),
        ExportAllDeclaration: (node) => check(node.source),
        ImportExpression: (node) => check(node.source),
        CallExpression(node) {
          if (node.callee.type === "Identifier" && node.callee.name === "require") {
            check(node.arguments[0]);
          }
        },
      };
    },
  };
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
      "Ban imports of the Claude CLI adapter outside engine/src/workers and the engine entry.",
      CLAUDE_CLI,
      "Claude specifics stay in packages/engine/src/workers (0004, CLAUDE.md). Reach the adapter through the WorkerPort (0008 section 1); only workers/** and the engine entry import workers/claude-cli.",
    ),
    "no-bun-import": importRule(
      "Ban `bun` and `bun:*` imports (but `bun:test`) outside engine/src/platform.",
      BUN,
      "Engine code reaches Bun-specific APIs only through packages/engine/src/platform (0004), so a move to Node stays a change to that module.",
    ),
  },
};
