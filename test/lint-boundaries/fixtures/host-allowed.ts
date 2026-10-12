// Fixture: what the worker host may import: the worker contract, platform and logging.
import { listenLineSocket } from "../platform/line-socket";
import { createLogger } from "../log/logger";
import type { HostOp } from "../workers/types";

export const allowed: [unknown, unknown, HostOp | null] = [listenLineSocket, createLogger, null];
