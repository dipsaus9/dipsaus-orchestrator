// The only engine code that calls `Bun.YAML.parse` (0017 section 5). Configuration files hold
// exactly one YAML 1.2 document; anchors and merge keys are resolved by the parser, and the
// result is validated by the caller.

export type YamlParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

// A line that starts a document (`---`) or ends one (`...`), with optional trailing content.
const DOCUMENT_START = /^---(?:\s|$)/;
const DOCUMENT_END = /^\.\.\.(?:\s|$)/;

function isContentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#") && !line.startsWith("%");
}

// `Bun.YAML.parse` returns an array both for a file with several documents and for one document
// whose top level is a sequence. Markers decide: a `---` after content or after another `---`,
// or content after `...`, starts a second document. Markers at column 0 are never part of a
// block scalar.
function hasSecondDocument(text: string): boolean {
  let seenContent = false;
  let seenStart = false;
  let ended = false;
  for (const line of text.split(/\r?\n/)) {
    if (DOCUMENT_START.test(line)) {
      if (seenContent || seenStart) return true;
      seenStart = true;
      continue;
    }
    if (DOCUMENT_END.test(line)) {
      if (seenContent) ended = true;
      continue;
    }
    if (isContentLine(line)) {
      if (ended) return true;
      seenContent = true;
    }
  }
  return false;
}

/** Parses `text` as exactly one YAML document. Never throws. */
export function parseYamlDocument(text: string): YamlParseResult {
  let value: unknown;
  try {
    value = Bun.YAML.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid YAML: ${message}` };
  }
  if (Array.isArray(value) && hasSecondDocument(text)) {
    return {
      ok: false,
      message: "holds more than one YAML document; a configuration file holds exactly one",
    };
  }
  return { ok: true, value };
}
