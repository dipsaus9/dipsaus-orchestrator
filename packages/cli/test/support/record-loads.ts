// Preloaded into a `dipo` process by `lazy-load.test.ts` (DIPO-318): each time the process loads a
// source file of the TUI or the daemon package, it writes `loaded <path>` to stderr.

import { readFileSync } from "node:fs";

const WATCHED = /\/packages\/(tui|daemon)\/src\/.+\.tsx?$/;

Bun.plugin({
  name: "record-loads",
  setup(build) {
    build.onLoad({ filter: WATCHED }, (args) => {
      process.stderr.write(`loaded ${args.path}\n`);
      return {
        contents: readFileSync(args.path, "utf8"),
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      };
    });
  },
});
