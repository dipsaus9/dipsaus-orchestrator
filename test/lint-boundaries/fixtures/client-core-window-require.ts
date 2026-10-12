// Fixture: the main client entry never reaches `require` through `window` (0004).
export const load = window.require;
