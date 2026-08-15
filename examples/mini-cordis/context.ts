export type Disposer = () => void;
export type Effect = () => void | Disposer;

export type Context = {
  readonly parent?: Context;
  readonly active: boolean;
  effect(setup: Effect): Disposer;
  plugin(apply: (ctx: Context) => void): Context;
  dispose(): void;
};

export function createContext(parent?: Context): Context {
  let active = true;
  const disposables: Disposer[] = [];

  function effect(setup: Effect): Disposer {
    if (!active) {
      throw new Error("cannot create effect on inactive context");
    }

    const teardown = setup();
    if (teardown !== undefined && typeof teardown !== "function") {
      throw new TypeError("effect must return a disposer or nothing");
    }

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      teardown?.();
    };

    disposables.push(dispose);
    return dispose;
  }

  function plugin(apply: (ctx: Context) => void): Context {
    const child = createContext(context);
    const disposeChild = effect(() => () => child.dispose());

    try {
      apply(child);
    } catch (error) {
      disposeChild();
      throw error;
    }

    return child;
  }

  function dispose() {
    if (!active) return;
    active = false;

    const errors: unknown[] = [];
    for (const dispose of disposables.splice(0).reverse()) {
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

  const context: Context = {
    parent,
    get active() {
      return active;
    },
    effect,
    plugin,
    dispose,
  };

  return context;
}
