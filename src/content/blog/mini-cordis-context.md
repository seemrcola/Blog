---
title: "为什么 Cordis 的 Context 能解决插件卸载"
description: "从副作用所有权出发，实现 effect scope、父子 Context 和可组合的插件卸载。"
date: 2026-08-14
tags: [JavaScript, Cordis, Agent]
status: in-progress
---

最近 `deepseek-harness` 很火。我在了解它的实现时发现，Harness 并没有自己发明一套插件运行时，而是在底层大量使用了 [Cordis](https://github.com/cordiverse/cordis)。于是我顺着这条线去了解了一下 Cordis。

Cordis 把自己称为“时空可组合性元框架”。这个名字很抽象，但它解决的一个具体问题非常有意思：一个插件注册了服务、事件监听器、定时器和子插件以后，框架怎样才能把它完整卸载？

我最初以为 Context 主要是一个依赖容器，类似 `ctx.logger`、`ctx.database` 这样的服务集合。读完源码后才发现，这只是它的一部分用途。对插件系统来说，Context 更基础的价值是建立副作用的所有权：插件通过自己的 `ctx` 创建资源，Cordis 就知道这些资源属于谁，并在插件卸载时统一撤销。

这篇文章先只研究这条链路：

```txt
Plugin
  → Context
  → Fiber
  → Effect
  → Disposer
  → Plugin Unload
```

服务、Proxy、`inject` 和 `isolate()` 都很重要，但先放到后面。我们先回答最初的问题：Context 为什么能解决插件卸载？

本文主要参考 Cordis 上游的 [`context.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts)、[`registry.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/registry.ts)、[`fiber.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts) 和 [`reflect.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/reflect.ts)。DeepSeek Harness 是发现 Cordis 的入口，下面的实现和分析以 Cordis 本身为主。

## 一个很容易写、却无法卸载的插件

先不使用框架。假设插件只是一个接收应用对象的函数：

```ts
function messagePlugin(app: App) {
  app.events.on("message", handleMessage);
  setInterval(refreshCache, 1000);
  app.commands.set("search", searchCommand);
}
```

加载很简单：

```ts
messagePlugin(app);
```

但现在尝试卸载它：

```ts
unload(messagePlugin);
```

框架并不知道应该做什么。

- 哪个事件监听器是这个插件注册的？
- 哪个 interval 属于这个插件？
- `search` command 是它创建的，还是另一个插件创建的？
- 插件内部调用的 helper 又创建了哪些资源？

问题不在于 JavaScript 没有清理 API。`off()`、`clearInterval()` 和 `delete()` 都存在。真正丢失的是所有权信息：这些副作用属于哪个插件？

## 让插件返回 disposer

最直接的修复，是让插件返回一个清理函数：

```ts
function messagePlugin(app: App) {
  app.events.on("message", handleMessage);
  const timer = setInterval(refreshCache, 1000);
  app.commands.set("search", searchCommand);

  return () => {
    app.commands.delete("search");
    clearInterval(timer);
    app.events.off("message", handleMessage);
  };
}

const dispose = messagePlugin(app);
dispose();
```

对于一个很小的插件，这已经能工作。但插件开始组合以后，清理函数必须层层向上传递：

```ts
function installWatcher() {
  // 必须返回 disposer
}

function installCommands() {
  // 必须返回 disposer
}

function messagePlugin(app: App) {
  const disposeWatcher = installWatcher();
  const disposeCommands = installCommands();

  return () => {
    disposeCommands();
    disposeWatcher();
  };
}
```

每增加一层 helper，就增加一次遗漏 disposer 的机会。子插件还要继续把自己的 disposer 交给父插件，父插件再交给框架。

我们真正需要的不是“每个函数都返回清理函数”，而是一个当前插件共享的 effect scope。任何 helper 只要拿到这个 scope，就能直接登记自己的清理逻辑。

## Context 是插件拿到的 effect scope

在 Cordis 中，插件统一接收一个 `ctx`：

```ts
function plugin(ctx: Context) {
  ctx.effect(() => {
    const resource = acquire();
    return () => release(resource);
  });
}
```

`ctx.effect()` 接收一个 setup 函数。setup 创建资源，并返回 disposer。Context 会把 disposer 登记到当前插件的生命周期中。

```txt
ctx.effect(setup)
  → 执行 setup
  → 得到 disposer
  → 把 disposer 记到当前插件
```

插件卸载时，框架不需要重新分析插件代码。它只需要取出这个插件登记过的所有 disposer 并执行。

这里必须说明一个边界：Context 不是垃圾回收器，也不能自动发现任意副作用。

下面的 interval 不受管理：

```ts
function plugin(ctx: Context) {
  setInterval(refresh, 1000);
}
```

必须显式登记：

```ts
function plugin(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  });
}
```

Cordis 能解决插件卸载，前提是副作用通过 `ctx.effect()`，或通过内部已经使用 effect 的 API 创建。

## 先实现最小 effect

第一版 Context 只保存一个 disposer 数组：

```ts
export type Disposer = () => void;
export type Effect = () => void | Disposer;

export class Context {
  #active = true;
  #disposables: Disposer[] = [];

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
}
```

对外返回的 disposer 是幂等的。调用两次只会清理一次，这一点很重要：插件可以主动释放某个资源，后续整个 Context 卸载时再调用同一个 disposer 也不会产生重复清理。

```ts
const dispose = ctx.effect(() => {
  const timer = setInterval(refresh, 1000);
  return () => clearInterval(timer);
});

dispose();
dispose(); // no-op
```

`active` 则阻止已经卸载的 Context 创建新副作用。否则一个失效插件仍能继续向系统注册资源，生命周期边界就失去了意义。

## dispose() 才是真正的卸载

Context 卸载时，取出 disposer 并按注册的相反顺序执行：

```ts
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
```

为什么是反向？因为后创建的资源通常依赖先创建的资源：

```txt
注册 database
注册 repository，它依赖 database
注册 command，它依赖 repository

卸载 command
卸载 repository
卸载 database
```

构造顺序的逆序通常就是最自然的拆除顺序。

清理失败也不能立刻中断。如果一个 disposer 抛错，其他监听器和资源仍然应该继续释放。这里先收集错误，完成全部清理后再抛出 `AggregateError`。

## 每个插件都需要自己的 Context

只有一个全局 Context 仍然不够。如果所有插件把 disposer 放进同一个数组，框架只能关闭整个应用，不能只卸载其中一个插件。

因此 `plugin()` 为每个插件创建子 Context：

```ts
export class Context {
  readonly parent?: Context;

  constructor(parent?: Context) {
    this.parent = parent;
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
}
```

这里有两个所有权关系：

1. 插件创建的 effect 属于它的子 Context。
2. 子 Context 自己又作为一个 effect 属于父 Context。

于是插件自然组成一棵生命周期树：

```txt
root Context
├─ plugin A Context
│  ├─ listener
│  └─ plugin A.1 Context
│     └─ timer
└─ plugin B Context
   └─ command
```

调用 `pluginA.dispose()` 只会卸载 A 和 A.1。调用 `root.dispose()` 则会递归卸载整棵树。

这也是 Context 相比“插件返回一个 disposer”更容易组合的地方。任意深度的 helper 或子插件只需要拿到当前 `ctx`，不必把 disposer 一层层传回入口。

## 用事件监听器验证卸载

事件监听器很适合观察泄漏。先在插件中注册监听器，并把移除操作返回给 effect：

```ts
const root = new Context();
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
```

第二次 `emit()` 没有再触发 listener，说明插件卸载后没有留下事件监听器。

## 嵌套插件也应当自动卸载

再验证父子 Context 的所有权：

```ts
const root = new Context();
const order: string[] = [];

root.plugin((parent) => {
  parent.effect(() => () => order.push("parent:first"));

  parent.plugin((child) => {
    child.effect(() => () => order.push("child"));
  });

  parent.effect(() => () => order.push("parent:last"));
});

root.dispose();

assert.deepEqual(order, [
  "parent:last",
  "child",
  "parent:first",
]);
```

父 Context 的最后一个 effect 先释放，然后释放子插件，最后释放父 Context 最早注册的 effect。插件树不需要额外遍历逻辑，因为子 Context 本身已经登记在父 Context 中。

## 完整的 Mini Context

到这里，最小实现只有三个核心操作：`effect()`、`plugin()` 和 `dispose()`。

```ts
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
```

可运行代码位于 `examples/mini-cordis/context.ts`，测试使用 Node.js 内置的 `node:test`：

```bash
node --test examples/mini-cordis/context.test.ts
```

当前测试固定了四个行为：

1. 卸载插件会移除它注册的事件监听器。
2. 卸载父 Context 会递归卸载子插件，并保持逆序。
3. 某个 disposer 失败不会阻止其他资源继续清理。
4. 已卸载 Context 不能继续创建 effect。

## 回到 Cordis 源码

Mini 版本把 disposer 直接存在 Context 中。真实 Cordis 多了一层 Fiber，因为它除了卸载，还要管理 PENDING、LOADING、ACTIVE、FAILED、UNLOADING 和 DISPOSED 等状态。

但插件卸载的所有权链与 Mini 版本是一致的。

### 1. ctx.plugin() 创建 Fiber

Cordis 的 `RegistryService.plugin()` 会为每次插件挂载创建 Fiber：

```ts
const fiber = new Fiber(
  this.ctx,
  config,
  Inject.resolve(plugin.inject),
  runtime,
  getOuterStack,
);
```

一个插件函数可以被多次挂载，因此 Registry 保存的是插件运行时信息，Fiber 表示其中一次具体挂载。

### 2. Fiber 创建插件专属 Context

Fiber 构造函数派生子 Context，并把自己放到 `ctx.fiber`：

```ts
this.ctx = this.context = parent.extend({ fiber: this });
```

插件最终收到的不是根 Context，而是绑定当前 Fiber 的子 Context。

这行代码就是所有权成立的关键。后续任何 API 只要读取 `ctx.fiber`，就知道这次注册属于哪个插件实例。

### 3. ctx.effect() 实际调用 Fiber.effect()

Cordis 把 Fiber 的 `effect` 暴露到 Context 接口：

```ts
export interface Context extends Pick<Fiber, "effect"> {
  fiber: Fiber;
}
```

反射层再把 `fiber.effect` mixin 到 `ctx.effect`：

```ts
this.mixin("fiber", ["runtime", "effect"]);
```

所以插件写的是：

```ts
ctx.effect(setup);
```

实际拥有 disposer 的是：

```ts
ctx.fiber._disposables;
```

Context 是插件使用的作用域入口，Fiber 是作用域背后的生命周期状态。

### 4. 子 Fiber 归属于父 Fiber

Fiber 自己的 `dispose` 又被注册为父 Fiber 的 effect：

```ts
this.dispose = parent.fiber.effect(() => {
  // 注册和启动当前 Fiber
  return async () => {
    // 卸载当前 Fiber
  };
}, "ctx.plugin()");
```

这与 Mini 版本中的代码对应：

```ts
this.effect(() => () => child.dispose());
```

因此 Cordis 的插件实例天然形成父子 Fiber 树。父插件卸载时，它创建的子插件也会进入卸载流程。

### 5. Fiber 卸载时清空 effects

Fiber 的 `_unload()` 会取出当前 Fiber 的 disposables 并执行：

```ts
await Promise.all(
  this._disposables.clear().map(async (dispose) => {
    try {
      await dispose();
    } catch (reason) {
      this.ctx.logger.error(reason);
    }
  }),
);
```

`DisposableList.clear()` 会先把列表反转：

```ts
clear() {
  const values = [...this.map.values()];
  this.map.clear();
  return values.reverse();
}
```

Cordis 还支持 Promise、generator 和 async generator effect，并处理异步清理、错误日志和状态切换。Mini 版本只保留同步的所有权模型。

## 为什么 provide() 也能自动卸载

现在再看服务就容易理解了。`ctx.provide()` 能在插件卸载时自动移除服务，并不是因为 Context 会扫描服务表，而是因为 `provide()` 内部本身就是一个 effect：

```ts
provide(name: string, value?: any) {
  return this.ctx.fiber.effect(() => {
    this.store[key] = impl;

    return async () => {
      delete this.store[key];
      // 通知依赖这个服务的 Fiber
    };
  });
}
```

事件监听器也是同一个思路。只要 `ctx.on()` 内部通过 effect 注册对应的移除操作，它就自然属于当前插件。

因此 Cordis 的 Context 不只是装着很多 API。这些 API 共享同一个隐藏约定：所有有副作用的操作都必须登记到当前 Fiber。

```txt
ctx.provide() ─┐
ctx.on()      ├─→ ctx.effect() → current Fiber
ctx.plugin()  ┘
```

这才是插件可以整体卸载的原因。

## Context 解决了什么，又没有解决什么

Context 与 Fiber 解决了：

- 副作用属于哪个插件实例。
- helper 不需要层层返回 disposer。
- 子插件如何归属于父插件。
- 插件卸载时如何找到全部资源。
- 服务和监听器如何共享同一生命周期。

它们不能自动解决：

- 没有通过 effect 登记的原始副作用。
- 插件写入的外部数据库数据。
- 已经发送到网络或其他进程的不可逆操作。
- disposer 自己没有实现完整清理的情况。

Context 管理的是可撤销副作用的所有权，不是让所有操作自动变得可逆。

## 回到 DeepSeek Harness

现在再看 DeepSeek Harness 使用 Cordis 就更容易理解了。

Harness 的工具、模型、会话、提示词片段和界面能力都由插件贡献。一个插件可能注册工具、监听模型事件、启动后台任务，还可能继续加载子插件。如果这些注册散落在全局对象中，配置切换和插件热更新会不断留下旧资源。

Cordis 给每次插件挂载分配独立 Context/Fiber。插件只通过这个 `ctx` 对外产生影响，卸载时 Fiber 就能撤销它的全部贡献。

DeepSeek Harness 让我注意到 Cordis，但真正值得学习的不是 Harness 使用了哪些服务，而是 Cordis 建立的这条规则：

> 所有可撤销的副作用，都必须归属于一个 Context。

## 下一步

本文先实现了 Context 最核心的生命周期能力。下一步再加入具名服务，并回答两个问题：

1. 为什么插件可以直接读取 `ctx.logger`，而不需要导入具体实现？
2. 当服务提供方卸载后，依赖它的插件为什么会自动停止，并在服务恢复后重新启动？

那时才需要引入 Proxy、`provide()`、`inject` 和 Fiber 状态机。

在继续之前，可以先尝试回答三个问题：

<details>
<summary>插件卸载最难的部分是什么？</summary>

不是调用清理 API，而是保留副作用与插件实例之间的所有权关系。
</details>

<details>
<summary>为什么每个插件需要独立的子 Context？</summary>

如果所有 disposer 都放在根 Context 中，框架只能关闭整个应用，无法只卸载某个插件及其子插件。
</details>

<details>
<summary>直接调用 setInterval() 为什么不会被 Cordis 自动清理？</summary>

Context 无法自动观察任意 JavaScript 副作用。必须通过 `ctx.effect()` 登记 `clearInterval()`，或使用内部已经登记 effect 的 Cordis API。
</details>
