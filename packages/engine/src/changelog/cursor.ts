// Cursors of the office change log (0005 section 2): the office stream name, the epoch and a seq.
// Kept apart from log.ts so the renderer can build cursors while the log checks entries with it.

import { type Cursor, type OfficeId, StreamName } from "@dipsaus-orchestrator/contract";

export function officeStream(office: OfficeId): StreamName {
  return StreamName.parse(`office:${office}`);
}

export function cursorAt(office: OfficeId, epoch: string, seq: number): Cursor {
  return { stream: officeStream(office), epoch, seq };
}
