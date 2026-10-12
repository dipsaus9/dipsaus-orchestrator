// `bun run recordings:refresh` (0017 section 2, "Storage and refresh"): captures every live
// scenario again, then regenerates the derived ones. On demand only; each capture is a real
// Claude session on the maintainer's login.

import { capture } from "./capture";
import { writeDerived } from "./derive";
import { SCENARIOS } from "./scenarios";

for (const scenario of SCENARIOS) await capture(scenario);
writeDerived();
console.log("refreshed; review the diff before committing");
