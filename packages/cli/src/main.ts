// Entry point of the `dipo` binary, compiled by `scripts/build.ts`.

import { defaultDeps, main } from "./index";

process.exitCode = await main(process.argv.slice(2), defaultDeps());
