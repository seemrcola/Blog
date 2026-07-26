---
title: "从 0 开始写一个 Mini Coding Agent"
description: "从一次模型调用出发，逐步加入流式输出、持续对话和上下文记忆。"
date: 2026-07-22
tags: [Agent, TypeScript]
---

网上有一种说法：如果不能用 300 行代码实现一个 coding agent，就还没有真正理解 Agent。原话未必如此，但这个思路很适合用来学习：先放下框架，从最小闭环开始，看看一个 Agent 到底由哪些部分组成。

这一篇先完成三件事：调用模型、保存上下文、持续对话。最后得到的仍然是聊天程序；等它拥有工具和 Agent Loop，才算真正的 coding agent。

## 调用模型

DeepSeek 提供了 OpenAI 兼容接口，因此直接使用 OpenAI SDK。SSE 解析、请求封装等工作交给 SDK，我们只关注传给模型的消息和模型返回的内容。

```bash
npm install openai
```

```ts
// llm.ts
import OpenAI from "openai";

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");

const client = new OpenAI({
  apiKey,
  baseURL: "https://api.deepseek.com",
});

export async function* streamModel(messages: Message[]) {
  const stream = await client.chat.completions.create({
    model: "deepseek-chat",
    messages,
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta.content;
    if (content) yield content;
  }
}
```

传入一条用户消息，就能得到模型的流式回答：

```ts
for await (const text of streamModel([
  { role: "user", content: "你是谁？" },
])) {
  process.stdout.write(text);
}
```

这里最重要的不是流式输出，而是 `messages`。模型每次只会看到这次请求携带的消息，接口本身不会替我们保存对话。

## 保存上下文

例如连续问两个问题：

```text
You: 1 + 1 等于几？
Agent: 2
You: 再加 1 呢？
```

模型要理解“再加 1”，必须同时收到前面的对话：

```ts
const history: Message[] = [
  { role: "user", content: "1 + 1 等于几？" },
  { role: "assistant", content: "2" },
  { role: "user", content: "再加 1 呢？" },
];
```

所谓对话记忆，就是保存这些消息，并在下一次调用时完整地传回去。

## 持续对话

最后用 Node.js 自带的 `readline` 接收输入，再用一个 `while` 循环把整个过程串起来：

```ts
// agent.ts
import { createInterface } from "node:readline/promises";
import { streamModel, type Message } from "./llm.ts";

const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const history: Message[] = [];

try {
  while (true) {
    const input = (await terminal.question("You: ")).trim();
    if (input === "exit") break;
    if (!input) continue;

    history.push({ role: "user", content: input });
    let answer = "";

    process.stdout.write("Agent: ");
    for await (const text of streamModel(history)) {
      answer += text;
      process.stdout.write(text);
    }
    process.stdout.write("\n\n");

    history.push({ role: "assistant", content: answer });
  }
} finally {
  terminal.close();
}
```

整个程序的核心只有四步：

1. 接收用户输入
2. 把输入加入 `history`
3. 将 `history` 交给模型
4. 把模型回答也加入 `history`

`while` 让这四步不断重复，这就是最小的对话循环。

## 离 coding agent 还差什么

现在模型只能返回文本，还不能操作代码。下一步只需要在这个循环里加入：

1. **工具**：读取文件、写入文件、搜索代码和执行命令
2. **工具调用**：让模型决定何时使用哪个工具
3. **Agent Loop**：执行工具，再把结果交给模型，直到任务完成

对话历史和循环都可以继续复用。我们不需要推倒重来，只需要让模型的回答从“只有文本”扩展到“文本或工具调用”。
