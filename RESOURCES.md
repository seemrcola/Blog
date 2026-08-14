# Cordis Context Resources

## Knowledge

- [Cordis README](https://github.com/cordiverse/cordis/blob/main/packages/core/README.md)
  上游对 Cordis 的定位和论文入口。用于确认项目自称“时空可组合性元框架”。
- [Cordis context.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts)
  Context 本体、根 Context 初始化与 `extend()` 的实现。用于观察 Context 自身为什么很薄。
- [Cordis fiber.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts)
  effect 收集、Fiber 状态、加载和卸载的核心源码。本文关于插件卸载的主要依据。
- [Cordis registry.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/registry.ts)
  `ctx.plugin()` 如何创建 Fiber，并把插件函数转换为受生命周期管理的运行实例。
- [Cordis reflect.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/reflect.ts)
  `ctx.provide()` 如何调用 `ctx.fiber.effect()`。用于证明服务注册也是一种受 Context 管理的副作用。
- [Cordis utils.ts](https://github.com/cordiverse/cordis/blob/main/packages/core/src/utils.ts)
  `DisposableList.clear()` 的逆序清理语义。用于核对嵌套资源的释放顺序。
- [DeepSeek Harness: Cordis 入门](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md)
  Harness 插件作者视角的 Cordis 概览。用于连接 Cordis 原理和 Harness 中的工具、模型与 Agent 服务。
- [DeepSeek Harness: 生命周期与 effect](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md)
  插件如何通过 `ctx.effect()` 注册可撤销资源的实践教程。

## Wisdom (Communities)

- [Cordis GitHub Issues](https://github.com/cordiverse/cordis/issues)
  查询生命周期边界、异步 effect 和行为变化的主要上游讨论场所。
- [DeepSeek Harness GitHub Issues](https://github.com/deepseek-ai/deepseek-harness/issues)
  观察 Cordis 在大型插件化 Agent 项目中遇到的真实问题。
