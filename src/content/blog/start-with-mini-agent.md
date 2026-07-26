---
title: "从 0 开始写一个 Mini Coding Agent"
description: "从一次模型调用出发，逐步加入流式输出、持续对话和上下文记忆。"
date: 2026-07-22
tags: [Agent, TypeScript]
---

网上有一种说法：如果不能用 300 行代码实现一个 coding agent，就还没有真正理解 Agent。原话未必如此，但这个思路很适合用来学习：先放下框架，从最小闭环开始，看看一个 Agent 到底由哪些部分组成。

这一篇先搭好最基础的对话循环：

1. 调用大模型
2. 流式输出结果
3. 持续接收用户输入
4. 保存对话上下文

完成这些之后，我们会得到一个能连续对话的命令行程序。它还不是 coding agent，因为模型暂时不能读写文件或执行命令。工具调用和 Agent Loop 会放在下一步实现。

## 调用大模型

这里使用 DeepSeek 的 OpenAI 兼容接口。为了让后面的对话历史可以直接复用，`streamModel` 从一开始就接收一个消息数组，而不是单独的字符串。

```ts
export type Message = {
  role: "user" | "assistant";
  content: string;
};

type ChatCompletionChunk = {
  choices?: Array<{
    delta?: { content?: string | null };
  }>;
};

function parseSseLine(line: string): { content?: string; done?: boolean } {
  if (!line.startsWith("data:")) return {};

  const data = line.slice(5).trim();
  if (data === "[DONE]") return { done: true };
  if (!data) return {};

  return {
    content: (JSON.parse(data) as ChatCompletionChunk)
      .choices?.[0]?.delta?.content ?? undefined,
  };
}

export async function* streamModel(
  messages: Message[],
): AsyncGenerator<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY");
  }

  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`Model request failed (${response.status}): ${detail}`);
  }

  if (!response.body) {
    throw new Error("Model returned no response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const { content, done } = parseSseLine(line.trim());
      if (done) return;
      if (content) yield content;
    }
  }

  const { content } = parseSseLine((buffer + decoder.decode()).trim());
  if (content) yield content;
}
```

这段代码主要做了两件事：发送消息，以及解析服务端通过 SSE 持续返回的数据。`AsyncGenerator` 会在收到新内容时立刻 `yield`，因此调用方不需要等待完整回答生成完毕。

先用一条固定消息验证调用是否成功：

```ts
import { streamModel } from "./llm.ts";

async function main() {
  const messages = [{ role: "user", content: "你是谁？" }] as const;

  for await (const chunk of streamModel([...messages])) {
    process.stdout.write(chunk);
  }
}

main();
```

运行前需要配置 API Key：

```bash
export DEEPSEEK_API_KEY="your-api-key"
```

到这里，我们已经完成了最小的“输入 → 模型 → 输出”链路。但程序回答一次就退出了，下一步让它持续接收输入。

## 加入对话循环

持续对话的核心其实只是一个 `while` 循环。为了少写一些终端输入输出的样板代码，这里使用 `@clack/prompts`：

```bash
npm install @clack/prompts
```

```ts
import {
  cancel,
  intro,
  isCancel,
  log,
  outro,
  stream,
  text,
} from "@clack/prompts";

import { streamModel } from "./llm.ts";

intro("Mini Coding Agent");

async function agent() {
  while (true) {
    const input = await text({
      message: "You",
      placeholder: "输入 exit 或 quit 退出",
    });

    if (isCancel(input)) {
      cancel("已退出");
      break;
    }

    const prompt = input.trim();
    if (prompt === "exit" || prompt === "quit") {
      outro("再见");
      break;
    }

    if (!prompt) continue;

    try {
      await stream.message(
        streamModel([{ role: "user", content: prompt }]),
      );
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
    }
  }
}

agent();
```

现在程序不会在一次回答后结束了。不过，这里的每次请求仍然是独立的。比如：

```text
You: 1 + 1 等于几？
Agent: 2
You: 再加 1 呢？
Agent: 你想给什么数加 1？
```

模型没有“忘记”上一轮，因为它从来没有收到过上一轮内容。大模型接口本身是无状态的，记忆需要由调用方保存，并在下一次请求时重新发送。

## 保存对话上下文

增加一个 `history` 数组，在每轮对话中依次保存用户消息和模型回答：

```ts
import {
  cancel,
  intro,
  isCancel,
  log,
  outro,
  stream,
  text,
} from "@clack/prompts";

import { streamModel, type Message } from "./llm.ts";

intro("Mini Coding Agent");

async function agent() {
  const history: Message[] = [];

  while (true) {
    const input = await text({
      message: "You",
      placeholder: "输入 exit 或 quit 退出",
    });

    if (isCancel(input)) {
      cancel("已退出");
      break;
    }

    const prompt = input.trim();
    if (prompt === "exit" || prompt === "quit") {
      outro("再见");
      break;
    }

    if (!prompt) continue;

    history.push({ role: "user", content: prompt });
    let response = "";

    async function* collectResponse() {
      for await (const chunk of streamModel(history)) {
        response += chunk;
        yield chunk;
      }
    }

    try {
      await stream.message(collectResponse());
      history.push({ role: "assistant", content: response });
    } catch (error) {
      history.pop();
      log.error(error instanceof Error ? error.message : String(error));
    }
  }
}

agent();
```

`collectResponse` 一边把内容交给终端做流式展示，一边拼出完整回答。回答结束后，再把它写入 `history`。如果请求失败，就移除刚加入的用户消息，避免留下不完整的上下文。

至此，我们有了一个支持流式输出和多轮上下文的命令行聊天程序。它的核心并不复杂：保存状态，然后在循环中不断调用模型。

## 离 coding agent 还差什么

聊天程序只能生成文本，coding agent 还需要把文本变成行动。最小实现通常还要加入三部分：

1. **工具**：读取文件、写入文件、搜索代码和执行命令
2. **工具调用协议**：让模型用结构化数据说明要调用哪个工具、传入什么参数
3. **Agent Loop**：执行工具，把结果交还给模型，直到模型给出最终回答

下一步会在当前循环上加入第一个工具。到那时，模型才真正具备操作代码的能力。
