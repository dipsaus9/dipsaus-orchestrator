// Cursors of the office change log (0005): the office stream name and a seq. Kept apart from
// log.ts so the renderer can build cursors while the log checks entries with it.

import { type Cursor, type OfficeId, StreamName } from "@dipsaus-orchestrator/contract";

export function officeStream(office: OfficeId): StreamName {
  return StreamName.parse(`office:${office}`);
}

export function cursorAt(office: OfficeId, seq: number): Cursor {
  return { stream: officeStream(office), seq };
}
