---
title: "从 0 开始写一个 Mini Coding Agent"
description: "先实现可连续交互的对话，再加入对话记忆、四个基础工具和 Agent Loop。"
date: 2026-07-26
tags: [Agent, JavaScript]
status: complete
---

网上有一种说法：如果不能用 300 行代码实现一个 coding agent，就还没有真正理解 Agent。原话未必如此，但这个思路很适合用来学习：先放下框架，从最小闭环开始，看看一个 Agent 到底由哪些部分组成。

本篇的目标不是实现一个可以直接提供给外部用户的产品，而是做出一个能够持续对话、维护消息历史、读取和修改工作区文件、执行命令，并根据工具结果继续行动的命令行 Agent。完成后，我们可以直接给它一个小型代码任务，观察完整的“模型决定 → 本地执行 → 返回结果 → 模型继续”过程。

这篇文章不从“完整代码”倒推概念，而是按照每一步真正解决的问题来实现：

1. 调用一次模型，确认输入和输出是什么。
2. 先做一个能反复提问的命令行程序，理解“持续对话”只是交互循环。
3. 再加入 `history`，让模型真正记住前面的消息。
4. 给模型准备 `read`、`write`、`edit`、`bash` 四个基础工具。
5. 最后把工具调用放进 Agent Loop，让模型可以根据工具结果继续工作。

这个顺序很重要：持续对话解决“程序能不能一直运行”，对话记忆解决“模型能不能理解上一轮”；它们是两个不同的问题。

## 准备工作

下面的代码使用 TypeScript、OpenAI Node.js SDK 和 DeepSeek 的 OpenAI 兼容接口。示例假设运行在安装了 Node.js 的类 Unix 环境，因为后面的 Bash 工具会使用 `/bin/bash`。

先创建项目并安装依赖：

```bash
mkdir mini-coding-agent
cd mini-coding-agent
npm init -y
npm install openai
npm install -D tsx @types/node
```

再配置 DeepSeek API Key。不要把密钥直接写进代码或提交到版本库：

```bash
export DEEPSEEK_API_KEY="your-api-key"
```

本文会逐步创建三个文件：`llm.ts` 负责调用模型，`tool.ts` 定义和执行工具，`agent.ts` 维护消息历史与 Agent Loop。

## 调用模型

DeepSeek 提供了 OpenAI 兼容接口，因此直接使用 OpenAI SDK。请求封装交给 SDK，我们只关注传给模型的消息和模型返回的内容。

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

## 先实现持续对话

有了单次调用后，下一步不是立刻设计记忆，而是让程序能够反复接收输入。这样可以先验证命令行交互和程序生命周期，问题也更容易定位。

这版程序每一轮只发送当前输入，因此它是“持续运行的交互程序”，还不是“有记忆的对话”：

```ts
// agent.ts
import { createInterface } from "node:readline/promises";
import { callModel } from "./llm.ts";

const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});

try {
  while (true) {
    const input = (await terminal.question("You: ")).trim();
    if (input === "exit") break;
    if (!input) continue;

    // 每轮都是一次独立请求；此时模型看不到上一轮的输入。
    const answer = await callModel([
      { role: "user", content: input },
    ]);
    console.log(`Agent: ${answer}\n`);
  }
} finally {
  terminal.close();
}
```

这里的“持续”指 `readline` 和 `while` 会持续工作，而不是模型拥有长期记忆。比如先问“1 + 1 等于几？”，再问“再加 1 呢？”，第二次请求只包含后一句，模型自然无法可靠地理解“再加 1”指什么。

## 再加入对话记忆

要让模型理解上下文，需要把每一轮的消息保存下来，并在下一次请求时完整传回去。所谓对话记忆，在这个最小实现里就是一个按顺序排列的消息数组：

```ts
const history: Message[] = [
  { role: "user", content: "1 + 1 等于几？" },
  { role: "assistant", content: "2" },
  { role: "user", content: "再加 1 呢？" },
];
```

把记忆接回刚才的循环，只需要在调用前后分别追加用户消息和 assistant 消息：

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

现在每轮请求都会带上之前的消息，模型才拥有了跨轮上下文。这个实现有一个实际限制：`history` 会一直增长，最终可能超过模型的上下文窗口。生产环境通常还要做截断、摘要或持久化；但在学习 Agent 的核心机制时，数组已经足够。

到这里可以区分两个概念：

- **持续对话**：通过输入循环，让程序能接收很多轮请求。
- **对话记忆**：通过 `history`，让每次请求携带之前的消息。

## 定义工具

目前模型只能返回文本。要让它读取和修改代码，需要把一部分能力交给本地程序执行。这里选择四个最小但互补的工具：

| 工具 | 作用 | 为什么需要 |
| --- | --- | --- |
| `read` | 读取文件 | 让模型先观察现状，避免盲改 |
| `write` | 创建或覆盖文件 | 适合生成新文件或完整重写 |
| `edit` | 替换一段唯一文本 | 适合小范围修改，降低误改概率 |
| `bash` | 执行工作区命令 | 运行测试、构建和其他开发命令 |

四个工具不是四段散落的特例，而是遵循同一个契约：

1. `name`、`description`、`parameters` 是发给模型的工具定义，描述“什么时候用”和“需要哪些参数”。
2. `execute` 是只留在本地的实现，真正读写文件或执行命令。
3. 参数来自模型生成的 JSON，执行前必须校验类型和边界。
4. 成功返回结果，失败也返回可读的错误，让模型有机会修正参数或换方案。

可以先定义这个契约，再实现四个工具：

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
  // execute 不会发送给模型，只在本地收到工具调用时执行。
  execute(args: Record<string, unknown>): Promise<string>;
};
```

### 共享校验：先确认参数，再接触文件系统

工具输入属于外部输入，不能直接把 `unknown` 当成路径或命令使用。所有文件工具共用两个小函数：一个检查字符串参数，一个把相对路径解析到工作区，并阻止通过绝对路径或 `..` 进行的词法路径越界。

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
  // resolve 会处理 ..；前缀检查阻止路径在文本层面离开工作区。
  if (path !== workspace && !path.startsWith(`${workspace}${sep}`)) {
    throw new Error("path must stay inside the workspace");
  }
  return path;
}
```

这仍然不是完整的文件系统沙箱：工作区内的符号链接可能指向外部路径，底层文件 API 会继续跟随它。对于只处理自己代码的本地学习示例，这个限制可以接受；面对不受信任的输入时，还需要真实路径校验、权限隔离或独立沙箱。

### Read：先读再改

`read` 接收相对路径并返回 UTF-8 文本。它看起来最简单，却是 Agent 工作流的起点：模型通常需要先读文件，才能决定后续是完整写入还是精确编辑。

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
    // 文件不存在、权限不足等错误直接抛出，由统一入口转换成工具结果。
    return readFile(workspacePath(args.path), "utf8");
  },
};
```

### Write：完整创建或覆盖

`write` 的语义要明确：它接收完整文件内容，并允许覆盖已有文件。写入前创建父目录，避免“目录不存在”成为模型需要猜测的额外问题。

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
    // write 的覆盖行为是故意的；小范围修改应当使用 edit。
    await writeFile(path, stringArg(args, "content"), "utf8");
    return `Wrote ${args.path}`;
  },
};
```

### Edit：用唯一匹配降低误改

`edit` 不让模型传行号或自己拼补丁，而是要求提供一段精确的 `oldText`。只有这段文本恰好出现一次才写回文件：找不到说明上下文过期，出现多次说明定位不够精确，两种情况都应该让模型重新读取文件。

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

### Bash：设置运行约束，不等于沙箱

`bash` 让 Agent 能运行测试和构建，是能力最强、风险也最高的工具。这里让命令从工作区启动，并设置超时和输出上限，避免单条命令无限运行或一次返回过大的日志。

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
    const { stdout, stderr } = await execAsync(
      stringArg(args, "command"),
      {
        cwd: workspace, // 命令从工作区启动，但并没有被限制在工作区内。
        shell: "/bin/bash",
        timeout: 30_000, // 防止测试或脚本卡住整个 Agent Loop。
        maxBuffer: 1024 * 1024, // 防止巨量输出耗尽内存。
      },
    );
    return [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
  },
};
```

`cwd` 只设置命令的初始目录。命令仍然可以使用绝对路径或 `cd ..` 访问工作区外的内容，并拥有当前用户的命令执行权限。因此这套实现只适合自己信任的本地环境。若要服务外部用户，还需要沙箱、权限控制、资源限制和审计，不能只依靠这里的工作目录与超时配置。

## 汇总工具

把四个工具放进数组后，对外暴露两种形态：完整的 `tools` 留给本地执行，去掉 `execute` 的 `toolDefinitions` 发给模型。这样可以清楚地区分“模型能提出什么请求”和“程序实际允许做什么”。

```ts
export const tools = [readTool, writeTool, editTool, bashTool];

export const toolDefinitions = tools.map(({ execute, ...definition }) => ({
  type: "function" as const,
  function: definition,
}));
```

再增加一个统一入口，根据模型返回的名称找到工具并执行。JSON 解析失败、工具不存在和工具内部异常，都转成文本结果放回对话，让模型可以看到错误而不是让整个进程直接退出。

```ts
export async function runTool(name: string, input: string) {
  const tool = tools.find((tool) => tool.name === name);
  if (!tool) return `Error: unknown tool ${name}`;

  try {
    const parsed: unknown = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("tool arguments must be an object");
    }
    return await tool.execute(parsed as Record<string, unknown>);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
```

## 把工具交给模型

工具准备好以后，把 `toolDefinitions` 放进模型请求。这里有一个重要变化：`callModel` 不再只返回文本，而是返回完整的 assistant 消息，因为工具调用也保存在这条消息里。

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

现在改造之前的对话循环。在用户的一次提问中，只要模型还在调用工具，内层循环就会继续；没有工具调用时，内层循环才结束，并等待下一轮用户输入。

这里有意不限制内层循环的工具轮数：只要模型仍然返回工具调用，任务就继续执行，直到模型给出最终文本回答。单个 Bash 命令仍受前面的超时限制，但整个 Agent 任务没有固定步数上限；需要人工停止时可以直接中断进程。

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

    while (true) {
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
    }
  }
} finally {
  terminal.close();
}
```

完整流程可以归纳为五步：

1. 把消息和工具定义交给模型。
2. 模型决定直接回答，或者提出一个或多个工具调用。
3. 本地校验参数并执行工具。
4. 用 `tool_call_id` 把工具结果加入消息历史。
5. 再次调用模型，直到得到最终回答。

外层循环保证 Agent 能持续接收用户问题，`history` 保证跨轮上下文，内层循环则保证一次任务中的“思考 → 工具 → 观察”可以反复进行。三者职责分开后，Agent 的结构就清楚了：模型负责决定下一步做什么，程序负责维护消息并执行被允许的操作。

## 运行与验证

三个文件准备好后启动 Agent：

```bash
npx tsx agent.ts
```

可以先给它一个范围明确、结果容易检查的任务：

```txt
请依次使用 read、write、edit 和 bash 完成任务：读取 package.json 并总结依赖；
创建 note.txt，写入 hello agent；把 hello 修改成 hello mini agent；
最后运行命令读取文件并确认结果。
```

运行过程中应该能看到 `Tool: read`、`Tool: write`、`Tool: edit` 和 `Tool: bash` 等日志，最后得到模型的总结。任务结束后检查 `note.txt`，确认文件内容确实是 `hello mini agent`。这个结果同时验证了工具定义、工具结果回传和内层 Agent Loop。

## 回顾

至此，这个 Mini Coding Agent 已经可以读取和修改代码、执行命令，并根据执行结果继续完成任务。它的核心不是某个框架，而是三个互相配合的循环状态：外层交互循环负责接收任务，消息历史负责保存上下文，内层 Agent Loop 负责持续执行“模型 → 工具 → 结果”。

这仍然是一个可信本地环境中的学习实现，不是安全沙箱。真正面向外部用户的产品还需要更严格的权限隔离、上下文压缩、日志、测试和失败恢复，但这些能力都建立在本文的基础环节之上。

## 参考资料

- [DeepSeek API 文档](https://api-docs.deepseek.com/)
- [DeepSeek：Function Calling](https://api-docs.deepseek.com/guides/function_calling/)
- [OpenAI Node.js SDK](https://github.com/openai/openai-node)
- [Node.js：Child Process](https://nodejs.org/api/child_process.html)
