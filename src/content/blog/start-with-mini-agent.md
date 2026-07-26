---
title: "从 0 开始写一个 Mini Coding Agent"
description: "从一次模型调用出发，逐步加入上下文记忆、四个基础工具和 Agent Loop。"
date: 2026-07-22
tags: [Agent, TypeScript]
---

网上有一种说法：如果不能用 300 行代码实现一个 coding agent，就还没有真正理解 Agent。原话未必如此，但这个思路很适合用来学习：先放下框架，从最小闭环开始，看看一个 Agent 到底由哪些部分组成。

这一篇从一次模型调用开始，逐步加入上下文记忆、对话循环和四个基础工具，最后用 Agent Loop 把它们连接起来。

## 调用模型

DeepSeek 提供了 OpenAI 兼容接口，因此直接使用 OpenAI SDK。请求封装交给 SDK，我们只关注传给模型的消息和模型返回的内容。

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

export async function callModel(messages: Message[]) {
  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages,
  });
  return response.choices[0].message.content ?? "";
}
```

传入一条用户消息，就能得到模型的回答：

```ts
const answer = await callModel([
  { role: "user", content: "你是谁？" },
]);
console.log(answer);
```

这里最重要的是 `messages`。模型每次只会看到这次请求携带的消息，接口本身不会替我们保存对话。

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
import { callModel, type Message } from "./llm.ts";

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
    const answer = await callModel(history);
    console.log(`Agent: ${answer}\n`);
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

## 定义工具

现在模型只能返回文本，还不能操作代码。一个最小的 coding agent 先准备四个工具就够了：

- `read`：读取文件
- `write`：创建或覆盖文件
- `edit`：精确修改文件中的一段内容
- `bash`：执行命令

每个工具都有两部分：一份给模型看的定义，以及一段真正执行操作的函数。

```ts
// tool.ts
type Tool = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      { type: "string"; description: string }
    >;
    required: string[];
  };
  execute(args: Record<string, unknown>): Promise<string>;
};
```

`name`、`description` 和 `parameters` 告诉模型如何调用工具，`execute` 则留在本地使用，不会发送给模型。

模型生成的参数属于外部输入，所以执行前需要做最基本的检查。文件工具还要把路径限制在当前工作目录中：

```ts
import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";

const workspace = process.cwd();
const execAsync = promisify(exec);

function stringArg(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function workspacePath(value: unknown) {
  if (typeof value !== "string") throw new Error("path must be a string");

  const path = resolve(workspace, value);
  if (path !== workspace && !path.startsWith(`${workspace}${sep}`)) {
    throw new Error("path must stay inside the workspace");
  }
  return path;
}
```

## Read

`read` 接收一个相对路径，返回文件内容：

```ts
const readTool: Tool = {
  name: "read",
  description: "Read a UTF-8 text file from the workspace",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path" },
    },
    required: ["path"],
  },
  async execute(args) {
    return readFile(workspacePath(args.path), "utf8");
  },
};
```

## Write

`write` 直接写入完整内容。如果父目录不存在，就先创建目录：

```ts
const writeTool: Tool = {
  name: "write",
  description: "Create or overwrite a UTF-8 text file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path" },
      content: { type: "string", description: "Complete file content" },
    },
    required: ["path", "content"],
  },
  async execute(args) {
    const path = workspacePath(args.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, stringArg(args, "content"), "utf8");
    return `Wrote ${args.path}`;
  },
};
```

## Edit

`edit` 使用精确字符串替换。只有 `oldText` 在文件中出现一次时才执行，这样可以避免改错位置：

```ts
const editTool: Tool = {
  name: "edit",
  description: "Replace one exact, unique string in a text file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path" },
      oldText: { type: "string", description: "Exact text to find" },
      newText: { type: "string", description: "Replacement text" },
    },
    required: ["path", "oldText", "newText"],
  },
  async execute(args) {
    const path = workspacePath(args.path);
    const oldText = stringArg(args, "oldText");
    const newText = stringArg(args, "newText");
    const content = await readFile(path, "utf8");

    const first = content.indexOf(oldText);
    if (first === -1) throw new Error("oldText not found");
    if (content.indexOf(oldText, first + oldText.length) !== -1) {
      throw new Error("oldText must be unique");
    }

    const updated =
      content.slice(0, first) + newText + content.slice(first + oldText.length);
    await writeFile(path, updated, "utf8");
    return `Edited ${args.path}`;
  },
};
```

## Bash

`bash` 在工作目录中执行命令。这里设置了超时时间和输出上限，避免命令无限运行或返回过多内容：

```ts
const bashTool: Tool = {
  name: "bash",
  description: "Run a bash command in the workspace",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to run" },
    },
    required: ["command"],
  },
  async execute(args) {
    const { stdout, stderr } = await execAsync(stringArg(args, "command"), {
      cwd: workspace,
      shell: "/bin/bash",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
  },
};
```

`bash` 拥有当前用户的命令执行权限，只适合运行在自己信任的本地环境中，不能直接暴露给外部用户。

## 汇总工具

最后把四个工具放进一个数组，并移除本地的 `execute`，得到可以传给模型的工具定义：

```ts
export const tools = [readTool, writeTool, editTool, bashTool];

export const toolDefinitions = tools.map(({ execute, ...definition }) => ({
  type: "function" as const,
  function: definition,
}));
```

再增加一个入口，根据模型返回的名称找到工具并执行。工具失败时也返回一条结果，让模型有机会理解错误并换一种方式继续：

```ts
export async function runTool(name: string, input: string) {
  const tool = tools.find((tool) => tool.name === name);
  if (!tool) return `Error: unknown tool ${name}`;

  try {
    return await tool.execute(JSON.parse(input));
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
```

## 把工具交给模型

工具准备好以后，把 `toolDefinitions` 放进模型请求。这里还有一个重要变化：`callModel` 不再只返回文本，而是返回完整消息，因为工具调用也在这条消息中。

```ts
// llm.ts
import OpenAI from "openai";
import { toolDefinitions } from "./tool.ts";

export type Message =
  OpenAI.Chat.Completions.ChatCompletionMessageParam;

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");

const client = new OpenAI({
  apiKey,
  baseURL: "https://api.deepseek.com",
});

export async function callModel(messages: Message[]) {
  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages,
    tools: toolDefinitions,
  });
  return response.choices[0].message;
}
```

不使用工具时，assistant 消息的 `content` 是最终回答。需要使用工具时，消息中会出现 `tool_calls`，大致长这样：

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_123",
      "type": "function",
      "function": {
        "name": "read",
        "arguments": "{\"path\":\"package.json\"}"
      }
    }
  ]
}
```

`arguments` 是 JSON 字符串。执行工具后，需要用相同的 `tool_call_id` 把结果放回消息历史，模型才知道这段结果对应哪一次调用。

## Agent Loop

现在改造之前的对话循环。在用户的一次提问中，只要模型还在调用工具，内层循环就会继续：

```ts
// agent.ts
import { createInterface } from "node:readline/promises";
import { callModel, type Message } from "./llm.ts";
import { runTool } from "./tool.ts";

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

    for (let step = 0; step < 20; step++) {
      const message = await callModel(history);
      history.push(message);

      if (!message.tool_calls?.length) {
        console.log(`Agent: ${message.content ?? ""}\n`);
        break;
      }

      for (const call of message.tool_calls) {
        if (call.type !== "function") continue;

        console.log(`Tool: ${call.function.name}`);
        const result = await runTool(
          call.function.name,
          call.function.arguments,
        );

        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }

      if (step === 19) throw new Error("Agent reached the 20-step limit");
    }
  }
} finally {
  terminal.close();
}
```

完整流程可以归纳为五步：

1. 把消息和工具定义交给模型
2. 模型决定回答问题，或者调用工具
3. 本地执行工具
4. 把工具结果加入消息历史
5. 再次调用模型，直到得到最终回答

这个内层循环就是最小的 Agent Loop。模型负责决定下一步做什么，我们的程序只负责执行工具并维护消息历史。20 步上限可以防止模型陷入无限调用。至此，这个 Mini Coding Agent 已经可以读取和修改代码、执行命令，并根据执行结果继续完成任务。
