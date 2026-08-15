---
title: "为什么 Cordis 的 Context 能解决插件卸载"
description: "从一个真实的插件卸载问题出发，用函数式 Mini Context 理解 Cordis 的 effect、Fiber 和生命周期所有权。"
date: 2026-08-15
tags: [JavaScript, Cordis, Agent]
status: in-progress
---

最近 `deepseek-harness` 很火。我在了解它的实现时发现，Harness 使用了 Cordis，于是顺着这条线去了解了一下 Cordis。

真正让我感兴趣的不是“它使用了哪些服务”，而是 Cordis 如何处理插件卸载：一个插件注册了事件监听器、定时器、服务和子插件以后，框架怎样知道这些资源属于谁，并在插件离开时完整撤销？

这篇文章只解决一个核心问题：**Context 如何让插件的副作用拥有清晰的生命周期。**

我们会按这条顺序实现：

```txt
卸载问题
  → 副作用所有权
  → ctx.effect()
  → 函数式 createContext()
  → 父子 Context
  → Cordis 的 Fiber
```

服务、Proxy、`inject` 和 `isolate()` 先不展开。它们建立在同一条生命周期链路之上，等 Context 的作用域模型清楚以后再看会更容易。

本文主要参考 Cordis 上游的 [`context.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts)、[`registry.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/registry.ts)、[`fiber.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts)、[`reflect.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/reflect.ts) 和 [`utils.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/utils.ts)。DeepSeek Harness 是发现 Cordis 的入口，下面的分析以 Cordis 本身为主。

## 先从卸载失败开始

假设插件只是一个函数，拿到应用对象后注册几种资源：

```ts
function messagePlugin(app: App) {
  app.events.on("message", handleMessage);
  setInterval(refreshCache, 1000);
  app.commands.set("search", searchCommand);
}

messagePlugin(app);
```

加载没有难度。问题出现在卸载：

```ts
unload(messagePlugin);
```

这个 `unload()` 没有足够的信息回答下面的问题：

- 哪个 listener 是这个插件注册的？
- 哪个 interval 应该被 `clearInterval()`？
- `search` command 是这个插件创建的，还是其他插件创建的？
- 插件调用的 helper 有没有继续创建资源？

JavaScript 当然提供了 `off()`、`clearInterval()` 和 `delete()`。缺少的不是清理 API，而是**副作用和插件实例之间的所有权关系**。

## Context 的一句话答案

Cordis 给每个插件一个专属的 `ctx`。插件不直接把副作用散落到全局对象，而是通过这个 `ctx` 登记可撤销操作：

```ts
function messagePlugin(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(refreshCache, 1000);

    return () => clearInterval(timer);
  });
}
```

`ctx.effect(setup)` 做两件事：

1. 立即执行 `setup`，让插件创建资源。
2. 保存 `setup` 返回的 disposer，等 Context 卸载时调用它。

因此卸载不再需要重新分析插件代码，而只需要执行这个插件登记过的 disposer：

```txt
ctx.effect(setup)
  → setup 创建资源
  → setup 返回 disposer
  → 当前插件保存 disposer
  → 插件卸载时调用 disposer
```

这就是 Context 最重要的含义：**它是插件拿到的 effect scope，也是副作用的所有权边界。**

这里有一个必须说清楚的限制：Context 不是垃圾回收器，不能自动发现任意 JavaScript 副作用。

下面的定时器不受管理：

```ts
function plugin(ctx: Context) {
  setInterval(refreshCache, 1000);
}
```

必须显式登记：

```ts
function plugin(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(refreshCache, 1000);
    return () => clearInterval(timer);
  });
}
```

所以更准确的说法是：**Cordis 能清理通过 `effect`，或通过内部使用 `effect` 的 API 注册的副作用。**

## 先确定 Mini 版的边界

为了看清核心机制，Mini 版只实现三个操作：

```ts
const root = createContext();

const plugin = root.plugin((ctx) => {
  ctx.effect(() => {
    // 创建资源
    return () => {
      // 撤销资源
    };
  });
});

plugin.dispose();
```

- `effect(setup)`：登记一个可撤销副作用。
- `plugin(apply)`：创建一个拥有独立生命周期的子 Context。
- `dispose()`：逆序执行当前 Context 的所有 disposer。

这里故意不用 `class`。函数式版本把状态放在 `createContext()` 的闭包里，返回一个只暴露生命周期操作的对象：

```txt
createContext()
  → 闭包保存 active / disposables
  → 返回 effect / plugin / dispose
```

这不是为了宣称 Cordis 内部也是函数式的。真实 Cordis 的 Fiber 是类；我们只是用闭包把同一个所有权模型压缩成最小实现。

## 第一步：用闭包保存 effect

先定义两个类型：setup 可以不返回任何东西，也可以返回 disposer。

```ts
export type Disposer = () => void;
export type Effect = () => void | Disposer;
```

然后写 `createContext()` 的状态：

```ts
export function createContext(parent?: Context): Context {
  let active = true;
  const disposables: Disposer[] = [];
```

`active` 防止已经卸载的 Context 继续创建资源；`disposables` 保存当前作用域拥有的清理函数。

接着实现 `effect()`：

```ts
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
```

这里有两个容易忽略的细节。

第一，`setup()` 在登记时立即执行。插件调用 `ctx.effect()` 的时刻，就是资源创建的时刻。

第二，返回的 `dispose()` 是幂等的。插件可以主动清理某个资源，之后 Context 整体卸载时再次遇到同一个 disposer 也不会重复执行：

```ts
const dispose = ctx.effect(() => {
  const timer = setInterval(refresh, 1000);
  return () => clearInterval(timer);
});

dispose();
dispose(); // no-op
```

## 第二步：逆序执行 disposer

资源通常按依赖顺序创建：

```txt
database
  → repository
    → command
```

拆除时自然应该反过来：

```txt
command
  → repository
    → database
```

所以 `dispose()` 先关闭 Context，再取出 disposer 的副本并反转：

```ts
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
```

为什么不遇到第一个错误就停止？因为一个资源清理失败，不应该让其他 listener、timer 和 service 永远留在系统里。先完成全部清理，最后再把错误聚合抛出，卸载才不会因为一个坏 disposer 变成半完成状态。

## 第三步：让插件拥有子 Context

单个全局 Context 仍然不够。如果所有插件共享同一个 disposer 数组，框架只能关闭整个应用，不能只卸载某一个插件。

`plugin()` 要做的事情很少：

1. 创建 child Context。
2. 把 `child.dispose` 登记到父 Context。
3. 执行插件函数，让它使用 child Context 注册 effect。

```ts
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
```

这里的关键不是多了一个 `parent` 属性，而是这行关系：

```ts
effect(() => () => child.dispose());
```

子 Context 自己就是父 Context 的一个 effect。于是插件树自动变成生命周期树：

```txt
root Context
├─ plugin A Context
│  ├─ listener
│  └─ plugin A.1 Context
│     └─ timer
└─ plugin B Context
   └─ command
```

调用 `pluginA.dispose()` 只会卸载 A 以及 A.1；调用 `root.dispose()` 则会递归卸载整棵树。我们不需要另外写树遍历，因为子 Context 已经登记在父 Context 的 disposer 列表里。

## 完整的函数式 Mini Context

把前面三步合在一起，得到可运行的实现：

```ts
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
```

完整代码位于 [`examples/mini-cordis/context.ts`](../../examples/mini-cordis/context.ts)。它的状态没有挂在实例字段上，而是被 `createContext()` 的闭包保护；返回对象只提供操作入口。

## 用测试确认卸载行为

先测最直观的事件监听器：

```ts
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
```

第二次 `emit()` 没有再触发 listener，说明插件卸载后没有留下事件监听器。

再看父子插件的清理顺序：

```ts
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

assert.deepEqual(order, [
  "parent:last",
  "child",
  "parent:first",
]);
```

为什么是这个顺序？父 Context 的 disposer 按注册顺序是：

```txt
parent:first
child Context
parent:last
```

整体卸载时逆序执行，所以先是 `parent:last`，然后进入 child Context，最后才是 `parent:first`。

当前测试还覆盖两个边界：一个 disposer 抛错时其他 disposer 仍然继续执行；Context 进入 inactive 后不能再创建新的 effect。运行：

```bash
node --test examples/mini-cordis/context.test.ts
```

## 回到 Cordis：Context 为什么看起来很薄

到这里再读 Cordis 源码，重点就不再是“Context 里有哪些属性”，而是追踪一次插件挂载时所有权如何传递。

### 1. Registry 为插件挂载创建 Fiber

Cordis 的 `RegistryService.plugin()` 会为一次具体的插件挂载创建 `Fiber`：

```ts
const fiber = new Fiber(
  this.ctx,
  config,
  Inject.resolve(plugin.inject),
  runtime,
  getOuterStack,
);
```

同一个插件函数可以被多次挂载，所以 Registry 管理插件运行时，Fiber 表示其中一次具体实例。

### 2. Fiber 派生插件专属 Context

Fiber 构造时会从父 Context 派生一个子 Context，并把当前 Fiber 绑定进去：

```ts
this.ctx = this.context = parent.extend({ fiber: this });
```

插件最终拿到的是这个绑定了 Fiber 的 Context。后续 API 只要读取 `ctx.fiber`，就能知道这次操作归属于哪个插件实例。

### 3. `ctx.effect()` 的真正拥有者是 Fiber

Cordis 将 Fiber 的 `effect` 暴露到 Context：

```ts
export interface Context extends Pick<Fiber, "effect"> {
  fiber: Fiber;
}
```

反射层再把它 mixin 到 `ctx.effect`：

```ts
this.mixin("fiber", ["runtime", "effect"]);
```

所以插件写的是：

```ts
ctx.effect(setup);
```

真正保存 disposer 和状态的是当前 Fiber。可以把两者的分工记成：

```txt
Context：插件使用的作用域入口
Fiber：作用域背后的状态机和 disposer 所有者
```

### 4. 子 Fiber 归属于父 Fiber

Cordis 创建子插件时，会把当前 Fiber 的卸载逻辑注册到父 Fiber 的 effect 中。Mini 版对应的是：

```ts
effect(() => () => child.dispose());
```

因此父插件卸载时，子插件自然会进入卸载流程，插件树也就变成了生命周期树。

### 5. Fiber 逆序清理 effects

Fiber 卸载时会清空 disposables，并执行清理函数：

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

而 `DisposableList.clear()` 会返回逆序列表：

```ts
clear() {
  const values = [...this.map.values()];
  this.map.clear();
  return values.reverse();
}
```

真实 Cordis 还处理 Promise、generator、async generator 以及 PENDING、LOADING、ACTIVE、FAILED、UNLOADING、DISPOSED 等状态。Mini 版只保留最重要的所有权模型：**effect 被哪个插件创建，就由哪个插件的 Context/Fiber 负责撤销。**

## `provide()` 为什么也能自动卸载

现在再看服务注册就不会觉得神秘。`ctx.provide()` 能在插件卸载时移除服务，不是因为 Context 会扫描某张服务表，而是因为 `provide()` 内部也登记了 effect：

```ts
provide(name: string, value?: any) {
  return this.ctx.fiber.effect(() => {
    this.store[key] = value;

    return async () => {
      delete this.store[key];
    };
  });
}
```

事件监听器、服务、mixin 等 API 也是同一个思路：创建资源时登记撤销操作，卸载时由当前 Fiber 统一执行。

```txt
ctx.provide() ─┐
ctx.on()      ├─→ effect() → current Fiber
ctx.plugin()  ┘
```

所以 Context 的价值不是“里面放了很多 API”，而是这些 API 共享了一个生命周期约定：**所有可撤销的副作用，都必须归属于当前 Context/Fiber。**

## Context 能解决什么，不能解决什么

它能解决：

- 副作用属于哪个插件实例。
- helper 不需要层层返回 disposer。
- 子插件如何归属于父插件。
- 卸载时如何找到完整的资源集合。
- 服务、监听器和插件如何共享同一生命周期。

它不能自动解决：

- 没有通过 effect 登记的原始副作用。
- 插件写入的外部数据库数据。
- 已经发送到网络或其他进程的不可逆操作。
- disposer 自己没有实现完整清理的情况。

Context 管理的是**可撤销副作用的所有权**，不是让所有操作自动变得可逆。

## 回到 DeepSeek Harness

现在再看 DeepSeek Harness 使用 Cordis，关注点就清楚了。Harness 的工具、模型、会话、提示词片段和界面能力都由插件贡献；插件还可能监听模型事件、启动后台任务或加载子插件。

如果这些注册散落在全局对象里，配置切换和插件热更新就很容易留下旧资源。Cordis 给每次插件挂载分配独立 Context/Fiber，插件通过这个作用域贡献能力，卸载时由同一个作用域撤销贡献。

DeepSeek Harness 是我注意到 Cordis 的入口，但真正值得带走的规则只有一句：

> 所有可撤销的副作用，都必须归属于一个 Context。

## 小结与下一步

这次没有把 Context 当成依赖容器来讲，而是先建立了它更基础的生命周期含义：

```txt
插件拿到 Context
  → Context 记录 effect
  → Fiber 持有插件实例的生命周期状态
  → disposer 逆序执行
  → 插件及其子插件完整卸载
```

下一篇再加入具名服务，并回答两个问题：

1. 为什么插件可以直接读取 `ctx.logger`，却不需要导入具体实现？
2. 服务提供方卸载后，依赖它的插件为什么会停止，并在服务恢复后重新启动？

那时再引入 Proxy、`provide()`、`inject` 和 Fiber 状态机，顺序会更自然。

如果要自测，可以先回答：

<details>
<summary>插件卸载最难的部分是什么？</summary>

不是调用清理 API，而是保留副作用与插件实例之间的所有权关系。
</details>

<details>
<summary>为什么子 Context 要登记到父 Context？</summary>

因为子 Context 本身就是父 Context 的一个 effect；这样父插件卸载时会递归卸载所有子插件。
</details>

<details>
<summary>直接调用 setInterval() 为什么不会被 Cordis 自动清理？</summary>

Context 无法自动观察任意 JavaScript 副作用。必须通过 `ctx.effect()` 登记 `clearInterval()`，或使用内部已经登记 effect 的 Cordis API。
</details>
