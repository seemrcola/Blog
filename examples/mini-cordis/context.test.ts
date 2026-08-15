import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createContext } from "./context.ts";

test("disposing a plugin removes the effects it registered", () => {
  const root = createContext();
  const bus = new EventEmitter();
  let messages = 0;

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

test("disposing a parent also disposes nested plugins in reverse order", () => {
  const root = createContext();
  const order: string[] = [];

  root.plugin((parent) => {
    parent.effect(() => () => order.push("parent:first"));

    parent.plugin((child) => {
      child.effect(() => () => order.push("child"));
    });

    parent.effect(() => () => order.push("parent:last"));
  });

  root.dispose();

  assert.deepEqual(order, ["parent:last", "child", "parent:first"]);
});

test("one failed disposer does not prevent the remaining cleanup", () => {
  const ctx = createContext();
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
  const ctx = createContext();

  ctx.dispose();

  assert.equal(ctx.active, false);
  assert.throws(
    () => ctx.effect(() => {}),
    /inactive context/,
  );
});
