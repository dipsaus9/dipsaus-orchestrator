// The Bash check of `dipo hook PreToolUse --bash` (DIPO-194, DIPO-195): the reason a worker Bash
// command is refused before it runs, else null. It refuses a command that sets or clears DIPO_TMP
// or TMPDIR (temp-guard) and every gh call but the help forms (gh-guard).

import { ghRefusal } from "./gh-guard";
import { refusedTempVariable, tempVariableRefusal } from "./temp-guard";

/** Pure: the reason a Bash command text is refused, else null. */
export function bashRefusal(command: string): string | null {
  const variable = refusedTempVariable(command);
  if (variable !== null) return tempVariableRefusal(variable);
  return ghRefusal(command);
}
