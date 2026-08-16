import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Context } from "./context.ts";

test("disposing a plugin removes the effects it registered", () => {
  const root = new Context();
  const bus = new EventEmitter();
  let messages = 0;

  // listener 注册到 child，而不是 root；plugin.dispose() 应该只清理这个插件。
  const plugin = root.plugin((ctx) => {
    const listener = () => messages++;
    ctx.effect(() => {
      bus.on("message", listener);
      return () => bus.off("message", listener);
    });
  });

  bus.emit("message");
  plugin.dispose();
  bus.emit("message");

  assert.equal(messages, 1);
  assert.equal(bus.listenerCount("message"), 0);
});

test("parent disposal follows the plugin ownership tree in reverse order", () => {
  const root = new Context();
  const order: string[] = [];

  // A 的 dispose 被登记到 root，B 的 dispose 被登记到 A。
  root.plugin((pluginA) => {
    pluginA.effect(() => () => order.push("A:listener"));

    pluginA.plugin((pluginB) => {
      pluginB.effect(() => () => order.push("B:timer"));
    });

    pluginA.effect(() => () => order.push("A:last"));
  });

  root.dispose();

  assert.deepEqual(order, ["A:last", "B:timer", "A:listener"]);
});

test("one failed disposer does not prevent the remaining cleanup", () => {
  const ctx = new Context();
  const order: string[] = [];

  ctx.effect(() => () => order.push("first"));
  ctx.effect(() => () => {
    throw new Error("broken cleanup");
  });
  ctx.effect(() => () => order.push("last"));

  assert.throws(() => ctx.dispose(), AggregateError);
  assert.deepEqual(order, ["last", "first"]);
});

test("an inactive context cannot create new effects", () => {
  const ctx = new Context();

  ctx.dispose();

  assert.equal(ctx.active, false);
  assert.throws(
    () => ctx.effect(() => {}),
    /inactive context/,
  );
});
