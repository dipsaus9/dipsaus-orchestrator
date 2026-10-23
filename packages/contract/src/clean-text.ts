// One cleaner for text that comes from outside dipo (0021 section 7, DIPO-313): a worker, a
// repository, a story or a log. The box door, the engine's ingest and every client that prints such
// text use it, so no terminal control character reaches the maintainer's terminal.

/**
 * Terminal escape sequences, removed whole so no rest of one shows: CSI (also its one-byte C1
 * form), OSC up to BEL or ST, DCS, SOS, PM and APC up to ST, and any other escape with the
 * character after it (a whole code point, so an astral character never leaves half of itself). An
 * unterminated string sequence runs to the end of the text.
 */
const ESCAPE_SEQUENCES =
  // oxlint-disable-next-line no-control-regex -- control characters are what this removes
  /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u009d[\s\S]*?(?:\u0007|\u009c|$)|\u001b[PX^_][\s\S]*?(?:\u001b\\|$)|[\u0090\u0098\u009e\u009f][\s\S]*?(?:\u009c|$)|\u001b[\s\S]?/gu;

/**
 * Characters removed after the sequences: C0 controls but tab and newline, DEL, C1 controls, the
 * bidirectional marks, embeddings, overrides and isolates (U+061C, U+200E, U+200F, U+202A to
 * U+202E, U+2066 to U+2069), invisible characters that hide text (zero-width space, word joiner
 * and the invisible operators, the byte-order mark, the interlinear annotation marks, the soft
 * hyphen, the combining grapheme joiner, the Mongolian vowel separator, the Hangul fillers U+115F,
 * U+1160 and U+3164, the zero-width joiner and non-joiner, and the variation selectors U+FE00 to
 * U+FE0F and U+E0100 to U+E01EF) and the tag characters (U+E0000 to U+E007F), which can carry
 * hidden text. Messages are short status texts: a hidden-text channel matters more than an
 * emoji sequence that falls apart.
 */
const UNSAFE_CHARACTERS =
  // oxlint-disable-next-line no-control-regex, no-misleading-character-class -- these characters are what this removes, one by one
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u{61c}\u{200b}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{fff9}-\u{fffb}\u00ad\u{34f}\u{115f}\u{1160}\u{180e}\u{200c}\u{200d}\u{3164}\u{fe00}-\u{fe0f}]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/**
 * `text` cleaned of terminal control characters and other unsafe characters, so it can be stored
 * and shown as plain text: line ends become `\n` (also U+2028 and U+2029), lone surrogates become
 * U+FFFD, escape sequences go whole and the characters of `UNSAFE_CHARACTERS` go. Tab and newline
 * stay. Idempotent.
 */
export function cleanText(text: string): string {
  return text
    .toWellFormed()
    .replace(/\r\n?|[\u{2028}\u{2029}]/gu, "\n")
    .replace(ESCAPE_SEQUENCES, "")
    .replace(UNSAFE_CHARACTERS, "")
    .toWellFormed();
}

/**
 * One sample per class of terminal sequence the cleaners are tested with: each is removed whole,
 * so `a${sample}b` cleans to `ab`. Tests of every print path use these.
 */
export const SEQUENCE_SAMPLES: Readonly<Record<string, string>> = {
  "CSI, 7-bit": "\u001b[31;1m",
  "CSI, one byte": "\u009b31;1m",
  OSC: "\u001b]0;owned title\u0007",
  "OSC hyperlink": "\u001b]8;;https://evil.example\u001b\\",
  DCS: "\u001bP1;2qpayload\u001b\\",
  "cursor movement": "\u001b[5A\u001b[3;4H",
  erase: "\u001b[2J\u001b[2K",
};
