// A `Workspace` for the CLI tests: a fixed current directory, scripted answers, and repositories
// described as data instead of git. Only tests import it, so it never reaches the binary.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { RepositoryLocation, Workspace } from "./workspace";

export interface FakeRepository extends RepositoryLocation {
  readonly office?: OfficeId;
  readonly backlog?: boolean;
}

export interface FakeWorkspaceOptions {
  readonly cwd?: string;
  readonly interactive?: boolean;
  /** Answers to `ask`, in order; a question past the last gets "". */
  readonly answers?: readonly string[];
  /** The repository around `cwd`, or none. */
  readonly repository?: FakeRepository;
}

export interface FakeWorkspace extends Workspace {
  /** Every question asked, in order. */
  readonly questions: string[];
}

export function fakeWorkspace(options: FakeWorkspaceOptions = {}): FakeWorkspace {
  const questions: string[] = [];
  const answers = [...(options.answers ?? [])];
  const repository = options.repository;
  return {
    cwd: options.cwd ?? "/work",
    interactive: options.interactive ?? false,
    questions,
    ask: async (question) => {
      questions.push(question);
      return answers.shift() ?? "";
    },
    locate: async () => repository ?? null,
    readOfficeId: () => repository?.office ?? null,
    isBacklogProject: () => repository?.backlog ?? false,
  };
}
