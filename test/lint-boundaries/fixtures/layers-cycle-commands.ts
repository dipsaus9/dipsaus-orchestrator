// Fixture: placed in commands/ (0004, DIPO-395). With layers-cycle-views.ts in views/, the two
// directories of one layer import each other through different files: the layer rule and the
// file cycle rule pass it, and only the directory cycle check refuses it.
import { leaf } from "../views/leaf";

export const command = leaf;
