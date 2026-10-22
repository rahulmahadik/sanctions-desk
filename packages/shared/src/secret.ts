const REDACTED = "[REDACTED]";

/**
 * Wraps a secret value so it cannot be printed, logged or serialised by accident.
 * The only way to read it is the explicit `reveal()` call, which makes every use easy to audit.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Secret(${REDACTED})`;
  }
}
