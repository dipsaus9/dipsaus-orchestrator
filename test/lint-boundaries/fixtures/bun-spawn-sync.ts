// Fixture: Bun.spawnSync blocks the daemon thread (0007).
export const result = Bun.spawnSync(["true"]);
