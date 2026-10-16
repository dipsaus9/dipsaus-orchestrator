// Fixture: the global `Bun` read through `globalThis` is the same leak (0004).
export const dotted: unknown = globalThis.Bun;
export const indexed: unknown = globalThis["Bun"];
export const other: unknown = globalThis.process;
