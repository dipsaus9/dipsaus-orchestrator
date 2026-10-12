// Fixture: Bun.spawnSync blocks the daemon thread (0007 section 1).
export const result = Bun.spawnSync(["true"]);
