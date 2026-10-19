// A current run profile whose verify is resolved (DIPO-173), for tests of the verify tools check
// on the launch, the dry run and the resume: they read the office's verify from the stored profile.

import type { OfficeHandle } from "../../src/db/office";
import type { VerifyCommands } from "../../src/workers/port";

/** Stores profile 1 as the office's current profile, its verify resolved to `verify`. */
export function storeResolvedVerify(office: OfficeHandle, verify: VerifyCommands): void {
  office.immediate(() => {
    office.run(
      `insert into run_profiles (office_id, profile_id, scanned_at, commit_sha, fingerprint,
         toolchain, conformance, deviations, previous_profile_id, current)
       values ($office_id, 1, 0, 'a', 'f', '{}', 'conforming', '[]', null, 1)`,
    );
    office.run(
      `insert into run_capabilities (office_id, profile_id, capability, status, commands,
         working_dir, source, confidence, evidence)
       values ($office_id, 1, 'verify', 'resolved', $commands, $cwd, 'script', 'high',
               'package.json scripts.verify')`,
      { commands: JSON.stringify(verify.commands), cwd: verify.cwd },
    );
  });
}
