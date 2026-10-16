// Fixture: the global `Bun` belongs in engine/src/platform (0004).
export const read = (path: string): unknown => Bun.file(path);
