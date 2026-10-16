// Fire-and-forget engine jobs (DIPO-110). A job the engine starts without waiting for it (a reply
// to a worker host, the ending of a run, a timer's pass) must never end in an unhandled rejection.
// Under the binary's top-level await, Bun 1.4.2 reports one on stderr and keeps running; the crash
// counter does not count it, and the process exits 1 at its next stop. How the daemon should react
// to one is decided in a follow-up story. `background` starts the job and attaches its error
// handler before anything else that follows it (the `settled` callback, the in-flight set), so a
// database or I/O error inside the job is one log line through the owner's engine logger, with the
// error's code when it has one.

/** Where a failed job is logged: the owner's engine logger (`logger.warn`, or its `warn` dependency). */
export type BackgroundLog = (message: string, fields: Readonly<Record<string, unknown>>) => void;

export interface BackgroundOptions {
  /** The log line of a failure, such as "parking a run failed". */
  readonly failed: string;
  /** Fields of that line (the run, the office); `reason` and `errorCode` are added. */
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly log: BackgroundLog | undefined;
  /** Holds the job until it settled, for the owner's `idle()` or `stop()`. */
  readonly inflight?: Set<Promise<unknown>>;
  /** Runs once the job settled either way, such as arming the next pass; a throw is logged too. */
  readonly settled?: () => void;
}

/**
 * Runs `job` without waiting for it. The returned promise never rejects: it resolves to the job's
 * value, or to undefined once a failure was logged.
 */
export function background<T>(
  job: () => Promise<T>,
  options: BackgroundOptions,
): Promise<T | undefined> {
  let started: Promise<T>;
  try {
    started = job();
  } catch (error) {
    started = Promise.reject(error);
  }
  const guarded = started.then(
    (value): T | undefined => value,
    (error: unknown) => {
      report(options, error);
      return undefined;
    },
  );
  const after = options.settled;
  const done =
    after === undefined
      ? guarded
      : guarded.then((value) => {
          try {
            after();
          } catch (error) {
            report(options, error);
          }
          return value;
        });
  const inflight = options.inflight;
  if (inflight !== undefined) {
    inflight.add(done);
    void done.then(() => inflight.delete(done));
  }
  return done;
}

/** The log fields of a failure: its message as `reason` and its code, when code-shaped, as `errorCode`. */
export function failureFields(error: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    reason: error instanceof Error ? error.message : String(error),
  };
  const code = errorCodeOf(error);
  if (code !== undefined) fields["errorCode"] = code;
  return fields;
}

/**
 * Error codes such as `SQLITE_IOERR`, `ENOSPC` or `office.refused`. The field is `errorCode`, not
 * `code`: the logger shows a `code` field only when it is a dipo code (0006 amendment of
 * 2026-10-15 (DIPO-91)), which would hide SQLite and system codes.
 */
const ERROR_CODE = /^[A-Za-z][\w.-]{0,63}$/;

/** The error's `code` property when it is a number or code-shaped, for an `errorCode` log field. */
export function errorCodeOf(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  if (typeof code === "number") return code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : undefined;
}

function report(options: BackgroundOptions, error: unknown): void {
  try {
    options.log?.(options.failed, { ...options.fields, ...failureFields(error) });
  } catch {
    // A failing log must not turn a logged failure into a rejection.
  }
}
