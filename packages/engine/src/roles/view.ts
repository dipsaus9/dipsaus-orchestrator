// What `office.roles` answers (DIPO-473): the roster as the office holds it and the role files it
// refused, as the contract's shapes.

import type { InvalidRoleFile, OfficeId, RoleView } from "@dipsaus-orchestrator/contract";

export interface RolesView {
  readonly office: OfficeId;
  readonly roles: RoleView[];
  readonly invalid: InvalidRoleFile[];
}
