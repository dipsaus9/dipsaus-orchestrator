// Fixture: a template literal without expressions is a plain specifier (0004).
export const load = (): Promise<unknown>[] => [
  import(`bun:sqlite`),
  import(`../workers/claude-cli/report-schema`),
];
