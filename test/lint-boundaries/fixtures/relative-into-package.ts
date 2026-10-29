// Fixture: no package reaches into another package's files by relative path (0004), in any form.
// The paths resolve from packages/<package>/<dir>/.
import { packageName } from "../../engine/src/index";

export * from "../../contract/src/ids";
export const lazy = () => import("../../client/src/index");
export const leaked = packageName;
