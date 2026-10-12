// Fixture: the main client entry never reaches Node's `process` through `globalThis` (0004).
export const env = globalThis.process.env;
