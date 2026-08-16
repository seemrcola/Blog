---
title: "插件卸载最难的不是清理，而是知道该清理什么"
description: "从一个会留下幽灵监听器的插件开始，用 class 语法实现 Mini Context，再看 Cordis 如何用 Fiber 管理副作用的生命周期。"
date: 2026-08-15
tags: [JavaScript, Cordis, Agent]
status: in-progress
---

插件热更新时，最让人困惑的 bug 往往不是“新插件没有生效”，而是旧插件还在生效：

- 同一条消息被打印两次；
- 定时任务越跑越多；
- 服务已经切换，旧服务却还在响应。

这些资源都能清理。`off()` 可以移除监听器，`clearInterval()` 可以停止定时器，问题是：**卸载时，框架怎么知道哪些资源属于这个插件？**

这正是 Cordis 的 Context 要解决的问题。它不是一个会自动扫描 JavaScript 的垃圾回收器，而是一条明确的所有权链：插件通过 Context 登记副作用，Context 在卸载时执行对应的 disposer。

本文只讲清楚这条链，并用一个小型的 `Context` 类把它实现出来。读完后，你应该能回答两个问题：

1. 为什么 `plugin()` 可以递归卸载子插件？
2. 为什么 Cordis 的 `ctx.on()`、`ctx.provide()` 能跟着插件一起消失？

## 先制造一个幽灵监听器

先看没有生命周期管理的插件：

```ts
function messagePlugin(app: App) {
  app.bus.on("message", handleMessage);
  setInterval(refreshCache, 1000);
}

messagePlugin(app);
```

加载很简单。卸载呢？下面的函数没有足够的信息：

```ts
unload(messagePlugin);
```

它不知道哪个 listener 是这次调用注册的，也不知道哪个 interval 应该停止。即使我们把 `off()` 和 `clearInterval()` 写对了，所有权信息已经丢了。

所以问题不是“缺少清理 API”，而是“资源没有归属”。如果一个插件只能通过全局对象做事，资源就很容易变成孤儿。

## 先写出我们想要的用法

一个可卸载的插件应该把资源登记到自己的作用域：

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
```

这段代码有一个很重要的约定：

```txt
setup() 现在执行，创建资源
setup() 返回 disposer
disposer 归当前 Context 所有
Context.dispose() 时执行 disposer
```

`plugin.dispose()` 之后，第二次 `emit()` 不再触发 listener。我们不需要让框架猜测资源，只需要要求插件在创建资源时登记它。

## 三个动作，刚好够用

Mini 版本只保留三个动作：

| 动作 | 作用 |
| --- | --- |
| `effect(setup)` | 创建资源，并登记它的清理函数 |
| `plugin(apply)` | 创建独立的子 Context |
| `dispose()` | 按逆序执行当前 Context 拥有的清理函数 |

这里选择 `class`，不是因为 class 更“高级”，而是因为这个对象确实有两类稳定状态：是否仍然 active，以及它拥有的 disposer 列表。把状态和操作放在同一个对象里，阅读实现时可以直接看到每个方法操作的边界。

## 第一步：让 Context 拥有 effect

先定义两个类型：

```ts
export type Disposer = () => void;
export type Effect = () => void | Disposer;
```

`Effect` 的外层函数是 setup，返回值是可选的 disposer。`effect()` 的核心实现只有四件事：检查状态、执行 setup、包装成幂等函数、保存到列表。

```ts
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
```

为什么要多包一层 `dispose`？因为资源既可以随插件整体卸载，也可以提前单独卸载：

```ts
const disposeTimer = ctx.effect(() => {
  const timer = setInterval(refreshCache, 1000);
  return () => clearInterval(timer);
});

disposeTimer();
disposeTimer(); // 第二次什么也不做
```

这个幂等性让 disposer 可以安全地同时被业务代码和 Context 调用。

## 第二步：为什么必须逆序卸载

资源通常按依赖顺序创建：

```txt
database → repository → command
```

拆除时应该反过来：

```txt
command → repository → database
```

因此 `dispose()` 会先关闭 Context，取走当前列表，再反转执行：

```ts
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
```

这里有两个边界值得记住：

- 先把 `isActive` 设为 `false`，卸载期间不能继续创建新 effect；
- 某个 disposer 抛错时，其他 disposer 仍然要继续执行，最后再报告错误。

## 第三步：用一条 disposer 边连接父子插件

如果所有插件共享一个 disposer 数组，只能关闭整个应用，不能单独关闭某个插件。因此每次 `plugin()` 都要创建一个新的 Context。

关键不是维护 `children` 数组，而是把子 Context 的卸载函数登记到父 Context：

```ts
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
```

这一行就是整棵树的关键：

```ts
this.effect(() => () => child.dispose());
```

外层函数现在执行，内层函数以后执行。于是父 Context 的 disposer 列表里出现了一条边：

```txt
parent.disposables
  └─ disposeChild() → child.dispose()
```

父插件卸载时，这条边会递归进入子插件。我们没有遍历树，因为树已经被编码进了 disposer 的所有权关系。

## 看一次真实的卸载顺序

```ts
const root = new Context();

root.plugin((pluginA) => {
  pluginA.effect(() => () => offAListener());

  pluginA.plugin((pluginB) => {
    pluginB.effect(() => () => offBTimer());
  });

  pluginA.effect(() => () => offALastResource());
});

root.dispose();
```

注册完成后，A 的列表是：

```txt
[offAListener, disposeB, offALastResource]
```

所以卸载顺序是：

```txt
offALastResource()
  → disposeB()
    → offBTimer()
  → offAListener()
```

注意这里的细节：B 不是被 root 找到的，B 是 A 的一个 effect。父子插件关系和副作用关系使用同一种机制，这就是实现保持简单的原因。

## 完整的 Mini Context

把三个动作合起来，完整代码只有一个类：

```ts
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
```

完整文件在 [`examples/mini-cordis/context.ts`](../../examples/mini-cordis/context.ts)。实现刻意没有加入服务容器、依赖注入或异步状态机，因为它们都不是理解“副作用属于谁”的前置条件。

## 用测试确认模型

第一组测试确认插件自己的监听器会被移除：

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

第二组测试确认父子关系和逆序清理：

```ts
assert.deepEqual(order, [
  "A:last",
  "B:timer",
  "A:listener",
]);
```

还应测试两个边界：一个 disposer 失败时其他 disposer 仍会运行，以及 Context 进入 inactive 后不能再创建 effect。运行：

```bash
node --test examples/mini-cordis/context.test.ts
```

先预测顺序，再运行测试。这个小练习比背诵 `reverse()` 更有用：你需要从“B 是 A 的一个 disposer”推导出结果。

## 从 Mini 版回到 Cordis

现在再读 Cordis 源码，可以把名字对应起来，而不会先迷失在 API 数量里。重点参考 Cordis 的 [`context.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts)、[`registry.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/registry.ts) 和 [`fiber.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts)。

| Mini 版 | Cordis | 职责 |
| --- | --- | --- |
| `Context` 实例 | 插件拿到的 `Context` | 提供当前插件的作用域入口 |
| `disposables` | `Fiber` 的 disposable list | 保存可撤销副作用 |
| `effect()` | `Fiber.effect()` | 登记 setup 返回的 disposer |
| `plugin()` 创建 child | `Registry` 创建 Fiber 并派生 Context | 为一次插件挂载建立独立生命周期 |
| `dispose()` | Fiber 的卸载流程 | 逆序执行并处理卸载状态 |

真实 Cordis 的 Context 看起来很薄，是因为真正的运行时状态在 Fiber 里。Context 负责让插件拿到入口；Fiber 负责记住这次插件实例拥有哪些副作用，以及它当前处于什么状态。

`ctx.on()` 和 `ctx.provide()` 之所以能自动卸载，也不是 Context 在扫描监听器或服务表，而是这些 API 在内部把撤销动作登记到了当前 Fiber：

```txt
ctx.on()       ┐
ctx.provide()  ├─→ effect() → 当前 Fiber
ctx.plugin()   ┘
```

因此最值得记住的不是某个 API，而是这条规则：

> 所有可撤销的副作用，都必须归属于一个 Context；在 Cordis 内部，它最终归属于当前 Fiber。

## 能解决什么，不能解决什么

Context 可以管理：

- 事件监听器、定时器和服务注册；
- helper 创建的资源，只要 helper 使用了当前 Context；
- 子插件及其全部副作用；
- 可重复调用的单个 disposer。

Context 不会自动管理：

- 没有通过 `effect()` 登记的原始副作用；
- 已经写入外部数据库的数据；
- 已经发出的网络请求或其他不可逆操作；
- disposer 自己没有实现完整清理的资源。

它管理的是**可撤销副作用的所有权**，不是把所有操作变成可逆操作。

## 最后回到切入点

DeepSeek Harness 是我认识 Cordis 的入口。Harness 里的工具、模型、会话和界面能力都可以由插件贡献；当配置切换或插件热更新发生时，旧插件留下的 listener、timer 和 service 就会变成真实问题。

Cordis 的答案很克制：给每次插件挂载一个 Context/Fiber，让插件通过它贡献能力，也通过它撤销能力。卸载不需要全局猜测，只需要沿着已经登记好的所有权链执行 disposer。

如果只带走一句话，就带走这句：

> 卸载不是“找到所有资源再清理”，而是“创建资源时就记录它归谁所有”。

下一步可以继续研究 `provide()`、`inject` 和服务依赖的启停；它们会复用本文建立的同一个生命周期模型。

如果有任何一步不清楚，可以直接追问。也可以先打开[第一课：Context 记录副作用的所有权](../../lessons/0001-context-owns-effects.html)，再对照[Context 生命周期速查页](../../reference/cordis-context-lifecycle.html)。
