export type Disposer = () => void;
export type Effect = () => void | Disposer;

export class Context {
  #active = true;
  #disposables: Disposer[] = [];
  readonly parent?: Context;

  constructor(parent?: Context) {
    this.parent = parent;
  }

  get active() {
    return this.#active;
  }

  effect(setup: Effect): Disposer {
    if (!this.#active) {
      throw new Error("cannot create effect on inactive context");
    }

    const teardown = setup();
    if (teardown !== undefined && typeof teardown !== "function") {
      throw new TypeError("effect must return a disposer or nothing");
    }

    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      teardown?.();
    };

    this.#disposables.push(dispose);
    return dispose;
  }

  plugin(apply: (ctx: Context) => void): Context {
    const child = new Context(this);
    const disposeChild = this.effect(() => () => child.dispose());

    try {
      apply(child);
    } catch (error) {
      disposeChild();
      throw error;
    }

    return child;
  }

  dispose() {
    if (!this.#active) return;
    this.#active = false;

    const errors: unknown[] = [];
    for (const dispose of this.#disposables.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length) {
      throw new AggregateError(errors, "failed to dispose context");
    }
  }
}
