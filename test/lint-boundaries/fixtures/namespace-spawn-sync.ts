// Fixture: spawnSync through a namespace import (0007).
import * as childProcess from "node:child_process";

export const result = childProcess.spawnSync("true");
