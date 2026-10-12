// Fixture: the main client entry is runtime-free, so it never calls a Bun global (0004).
export const socket = Bun.connect({ unix: "/tmp/dipo.sock", socket: { data() {} } });
