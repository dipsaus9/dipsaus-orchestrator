// A partner of a service that the engine builds after it (DIPO-318). The engine builds its services
// in one written order; where two services call each other, the one built first gets a `Partner`
// and the engine connects it in one step right after both exist. A call before that step is a
// wiring error and throws, never a silent no-op.

/** Thrown when a service calls a partner the engine has not connected yet. */
export class PartnerNotConnectedError extends Error {
  constructor(readonly partner: string) {
    super(`The engine called ${partner} before connecting it; this is a wiring error.`);
    this.name = "PartnerNotConnectedError";
  }
}

export class Partner<T> {
  readonly #name: string;
  #value: T | undefined;

  constructor(name: string) {
    this.#name = name;
  }

  get name(): string {
    return this.#name;
  }

  get connected(): boolean {
    return this.#value !== undefined;
  }

  /** Connects the partner once; a second connect is a wiring error. */
  connect(value: T): void {
    if (this.#value !== undefined) {
      throw new Error(`The engine connected ${this.#name} twice; this is a wiring error.`);
    }
    this.#value = value;
  }

  /** The connected partner; throws `PartnerNotConnectedError` before the connect step. */
  get(): T {
    if (this.#value === undefined) throw new PartnerNotConnectedError(this.#name);
    return this.#value;
  }
}
