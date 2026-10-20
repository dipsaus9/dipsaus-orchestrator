// The only engine code that calls `Bun.YAML.parse` (0017 section 5). Configuration files hold
// exactly one YAML 1.2 document; anchors and merge keys are resolved by the parser, and the
// result is validated by the caller. The one-document rule lives in the contract, so
// `client/node` applies the same rule with its own call to the parser (DIPO-69).

import { parseSingleYamlDocument, type YamlParseResult } from "@dipsaus-orchestrator/contract";

export type { YamlParseResult };

/** Parses `text` as exactly one YAML document. Never throws. */
export function parseYamlDocument(text: string): YamlParseResult {
  return parseSingleYamlDocument((source) => Bun.YAML.parse(source), text);
}

/**
 * Writes `value` as one YAML document in block style, one key per line. `Bun.YAML.stringify` writes
 * flow style on one line unless it is given an indent (0017), and it keeps no comments.
 */
export function stringifyYamlDocument(value: unknown): string {
  return Bun.YAML.stringify(value, null, 2);
}
