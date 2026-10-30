// The words of a run's health (0009), shared by the TUI and `dipo watch` so both say the same: the
// short label with its glyph, and what each state means for people. The engine sends the health
// value; nothing here derives one.

/** The five health words and glyphs of 0009; an unknown state shows as its plain word. */
const HEALTH_LABEL: Readonly<Record<string, string>> = {
  lost: "LOST !!",
  looping: "looping @",
  stuck: "stuck ~",
  quiet: "quiet .",
  busy: "busy >",
};

export function healthLabel(health: string): string {
  return HEALTH_LABEL[health] ?? health;
}

/** What each health state means, for people (0009). */
const HEALTH_MEANING: Readonly<Record<string, string>> = {
  busy: "the worker is producing output",
  quiet: "no output for a few minutes (timeouts.workerQuietMinutes)",
  stuck: "no output for a long time (timeouts.workerStallMinutes); the worker may hang",
  looping: "the same failure repeats, or the worker is on its last allowed loop",
  lost: "the worker exited or its host is gone, and dipo has not processed that yet",
};

/** What `health` means; an unknown state as its plain word. */
export function healthMeaning(health: string): string {
  return HEALTH_MEANING[health] ?? health;
}
