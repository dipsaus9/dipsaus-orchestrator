// Fixture: the main client entry never clears a timer through `window` (0017 section 4).
export const cleared = window.clearInterval(0);
