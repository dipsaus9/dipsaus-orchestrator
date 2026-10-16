// Fixture: a local named `Bun` and a property named `Bun` are not the global.
const Bun = { file: (path: string): string => path };

export const read = (path: string): string => Bun.file(path);
export const holder = { Bun: 1 };
export const value = holder.Bun;
