# Mission: 理解 Cordis Context 如何解决插件卸载

## Why
从 DeepSeek Harness 使用 Cordis 这条线索出发，写出一个能可靠卸载事件监听器、定时器和嵌套插件的 Mini Context，并把它整理成一篇可以对照 Cordis 源码阅读的文章。

## Success looks like
- 能解释普通插件系统为什么容易在卸载后留下副作用
- 能准确描述 Context、Fiber、effect 和 disposer 的职责边界
- 能实现并测试一个支持嵌套插件卸载的最小 Context
- 能指出哪些副作用 Cordis 可以自动清理，哪些不能
- 能将 Mini 实现逐项对应到 Cordis 源码

## Constraints
- 以 Cordis 为主体，DeepSeek Harness 只作为发现 Cordis 的背景
- 使用 TypeScript 和 Node.js 标准能力，不增加运行时依赖
- 先解决插件卸载，再讨论服务、Proxy、inject 和 isolate
- 结论以 Cordis 上游源码为主，Harness 文档作为补充

## Out of scope
- 第一阶段不实现服务容器、依赖注入、事件总线、配置加载和 HMR
- Mini 版本只实现同步 effect，不追求完整 Cordis 兼容性
