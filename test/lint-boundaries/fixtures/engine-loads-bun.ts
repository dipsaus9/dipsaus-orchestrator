// Fixture: a dynamic import of `bun` is the same leak as a static one (0004).
export const load = (): Promise<unknown> => import("bun");
