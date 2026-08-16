export type Disposer = () => void;
export type Effect = () => void | Disposer;

export class Context {
  private isActive = true;
  private disposables: Disposer[] = [];

  get active(): boolean {
    return this.isActive;
  }

  effect(setup: Effect): Disposer {
    if (!this.isActive) {
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

    this.disposables.push(dispose);
    return dispose;
  }

  plugin(apply: (ctx: Context) => void): Context {
    const child = new Context();
    const disposeChild = this.effect(() => () => child.dispose());

    try {
      apply(child);
    } catch (error) {
      disposeChild();
      throw error;
    }

    return child;
  }

  dispose(): void {
    if (!this.isActive) return;
    this.isActive = false;

    const errors: unknown[] = [];
    for (const dispose of this.disposables.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "failed to dispose context");
    }
  }
}
