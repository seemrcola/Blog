---
title: "给 Mini Coding Agent 加一个 Skill 系统"
description: "自动发现 Skill、按描述选择、按需加载指令，并把 Skill 作用域限制在当前任务"
date: 2026-08-11
tags: [Agent, JavaScript]
status: complete
---

在[上一篇](/blog/start-with-mini-agent/)中，我们实现了一个能够持续对话、调用工具并根据工具结果继续工作的 Mini Coding Agent。它已经拥有 `read`、`write`、`edit` 和 `bash`，但所有任务仍然使用同一套通用行为。

Skill 要解决的是另一个问题：怎样把代码审查、测试编写、发布检查等任务方法保存成独立模块，让 Agent 在遇到对应任务时再加载，而不是把所有规则都塞进 system message。

本篇会实现一套相对完整的 Skill 链路：

1. 启动时自动扫描 `skills/*/SKILL.md`。
2. 校验 Skill 的名称、描述和正文，配置错误时尽早失败。
3. 只把名称和描述放进 system message，控制初始上下文大小。
4. 用户明确指定 Skill，或任务与描述明显匹配时，模型调用 `skill` 工具。
5. `skill` 工具按需返回完整指令和 Skill 基础目录。
6. Skill 可以引用同目录下的参考资料和脚本。
7. Skill 内容只在当前任务中生效，不污染后续对话。

这里的“自动选择”仍然由模型根据描述判断，不是确定性的分类器。需要强制使用某个 Skill 时，用户可以直接说“使用 `code-review` skill”。

## Skill 系统的三层结构

Skill 系统可以分成三个互相独立的阶段：

| 阶段 | 输入 | 输出 |
| --- | --- | --- |
| 发现 | `skills/` 目录 | Skill 名称、描述和正文注册表 |
| 选择 | 用户任务和 Skill 描述 | 是否调用某个 Skill |
| 加载 | Skill 名称 | 完整指令和基础目录 |

发现发生在 Agent 启动时，选择发生在模型推理时，加载则通过工具完成。把它们分开后，我们不需要在每次请求中发送所有 Skill 正文。

完整流程如下：

```txt
启动 Agent
  → 扫描 skills/*/SKILL.md
  → 将名称和描述加入 system message
  → 用户提交任务
  → 模型判断是否需要 Skill
  → 调用 skill({ name })
  → 完整指令进入当前任务历史
  → Agent 按 Skill 继续调用 read、edit、bash 等工具
  → 只保存用户问题和最终回答
```

## 项目结构

在上一篇的三个 TypeScript 文件旁增加 `skill.ts` 和 `skills/`：

```txt
mini-coding-agent/
├─ agent.ts
├─ llm.ts
├─ tool.ts
├─ skill.ts
├─ skill.test.ts
└─ skills/
   ├─ code-review/
   │  ├─ SKILL.md
   │  └─ references/
   │     └─ checklist.md
   └─ test-writer/
      └─ SKILL.md
```

Skill 使用 YAML front matter 保存元数据。为了避免自己解析 YAML，安装 `gray-matter`：

```bash
npm install gray-matter
```

## 定义 Skill 格式

每个 Skill 使用独立目录，入口固定为 `SKILL.md`。目录名必须和 front matter 中的 `name` 一致。

```md
<!-- skills/code-review/SKILL.md -->
---
name: code-review
description: Review code changes for bugs, security issues, regressions, and missing tests
---

# Code Review

When reviewing code:

1. Read the changed files and their callers before judging the implementation.
2. Prioritize bugs, security issues, behavior regressions, and missing tests.
3. Report findings first, ordered by severity, with file and line references.
4. If no issue is found, state that clearly and describe the remaining risk.

For the detailed checklist, read `references/checklist.md` relative to this
skill's base directory.
```

对应的参考文件可以继续保持短小：

```md
<!-- skills/code-review/references/checklist.md -->
# Review Checklist

- Check boundary conditions and error paths.
- Check whether callers still satisfy the changed contract.
- Check permissions before file, process, or network access.
- Check that tests cover the behavior most likely to regress.
```

再增加一个测试编写 Skill，让模型确实有多个候选项可以选择：

```md
<!-- skills/test-writer/SKILL.md -->
---
name: test-writer
description: Add focused automated tests for an existing behavior or bug fix
---

# Test Writer

1. Read the implementation and existing tests first.
2. Add the smallest test that fails before the fix and passes after it.
3. Reuse the repository's current test framework and conventions.
4. Run the narrowest relevant test command before reporting completion.
```

`description` 是自动选择的关键。它应该描述“什么时候使用”，而不是重复 Skill 名称或罗列实现细节。

## 自动发现和校验

创建 `skill.ts`，先定义 Skill 在内存中的结构：

```ts
// skill.ts
import matter from "gray-matter";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { resolve } from "node:path";

export type Skill = {
  name: string;
  description: string;
  baseDirectory: string;
  instructions: string;
};

export type SkillRegistry = Map<string, Skill>;

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code;
}
```

接下来扫描 `skills/` 下的一级目录，解析每个 `SKILL.md`。不存在 `skills/` 时返回空注册表；发现格式错误时直接抛错，避免 Agent 带着一份不完整的 Skill 清单继续运行。

```ts
export function discoverSkills(
  root = resolve(process.cwd(), "skills"),
): SkillRegistry {
  let entries: Dirent[];

  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return new Map();
    throw error;
  }

  const registry: SkillRegistry = new Map();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const filename = resolve(root, entry.name, "SKILL.md");
    const source = readFileSync(filename, "utf8");
    const { data, content } = matter(source);
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const description =
      typeof data.description === "string" ? data.description.trim() : "";
    const instructions = content.trim();

    if (!skillNamePattern.test(name) || name.length > 64) {
      throw new Error(`Invalid skill name in ${filename}`);
    }
    if (name !== entry.name) {
      throw new Error(`Skill name must match directory: ${entry.name}`);
    }
    if (!description || description.length > 1024) {
      throw new Error(`Invalid skill description in ${filename}`);
    }
    if (!instructions) {
      throw new Error(`Skill instructions are empty in ${filename}`);
    }
    if (registry.has(name)) {
      throw new Error(`Duplicate skill: ${name}`);
    }

    registry.set(name, {
      name,
      description,
      baseDirectory: `skills/${entry.name}`,
      instructions,
    });
  }

  return registry;
}
```

这里没有递归扫描所有 Markdown 文件。只有固定位置的 `SKILL.md` 是入口，其他文件都是 Skill 自己的参考资料，由 Skill 指令决定是否读取。

## 生成轻量 Skill 清单

模型要做自动选择，必须先知道有哪些 Skill，但没有必要提前看到所有正文。把名称和描述整理成 system message：

```ts
export function createSkillSystemPrompt(registry: SkillRegistry): string {
  const catalog = [...registry.values()]
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");

  if (!catalog) {
    return "No skills are currently available.";
  }

  return [
    "Reusable skills are available for this coding agent.",
    "Available skills:",
    catalog,
    "",
    "Skill rules:",
    "- If the user names a skill, load it before acting.",
    "- If the task clearly matches a description, load that skill before acting.",
    "- Load only the smallest relevant set of skills.",
    "- Skill instructions apply only to the current user task.",
    "- User instructions take priority over skill instructions.",
  ].join("\n");
}
```

启动时创建注册表和 system message：

```ts
export const skillRegistry = discoverSkills();
export const skillSystemPrompt = createSkillSystemPrompt(skillRegistry);
```

假设存在前面的两个 Skill，模型最初只会看到：

```txt
Available skills:
- code-review: Review code changes for bugs, security issues, regressions, and missing tests
- test-writer: Add focused automated tests for an existing behavior or bug fix
```

这就是自动路由所需的最小信息。

## 按需加载完整 Skill

在 `skill.ts` 中增加加载函数。它只从已经校验过的注册表取值，不直接把模型提供的名称拼进文件路径，因此不存在 `../` 路径穿越问题。

```ts
export function loadSkill(
  name: string,
  registry = skillRegistry,
): string {
  const skill = registry.get(name);

  if (!skill) {
    const available = [...registry.keys()].join(", ") || "none";
    throw new Error(`Unknown skill: ${name}. Available: ${available}`);
  }

  return [
    `Loaded skill: ${skill.name}`,
    `Base directory: ${skill.baseDirectory}`,
    "These instructions apply only to the current user task.",
    "",
    skill.instructions,
  ].join("\n");
}
```

返回基础目录很重要。Skill 如果要求读取 `references/checklist.md`，模型就能通过现有 `read` 工具读取：

```txt
skills/code-review/references/checklist.md
```

Skill 也可以包含 `scripts/`，但脚本仍然必须通过现有 `bash` 工具显式执行。加载 Skill 本身不会自动执行任何代码。

## 增加 `skill` 工具

回到上一篇的 `tool.ts`，导入 `loadSkill`：

```ts
import { loadSkill } from "./skill.ts";
```

然后使用现有 `Tool` 契约增加第五个工具：

```ts
const skillTool: Tool = {
  name: "skill",
  description: "Load one available skill by name before performing a matching task",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact skill name" },
    },
    required: ["name"],
  },
  async execute(args) {
    return loadSkill(stringArg(args, "name"));
  },
};
```

把它加入原来的工具数组：

```ts
export const tools = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  skillTool,
];
```

`runTool()` 和 `toolDefinitions` 不需要修改。对 Agent Loop 来说，Skill 和其他工具一样：模型提出调用，本地执行，再把结果用 `tool_call_id` 放回消息历史。

## 把 Skill 清单交给模型

在 `agent.ts` 中导入生成好的 system message：

```ts
import { skillSystemPrompt } from "./skill.ts";
```

上一篇直接把所有消息保存在一个 `history` 中。加入 Skill 后，这会产生一个新问题：某个任务加载的 Skill 工具结果会永久留在历史里，可能影响后续不相关任务。

因此把消息分成两层：

- `conversation`：跨任务保留，只保存 system message、用户问题和最终回答。
- `taskMessages`：只服务当前任务，包含 Skill、文件内容、命令输出等工具过程。

完整的 `agent.ts` 调整如下，内层 Agent Loop 仍然不限制轮数：

```ts
// agent.ts
import { createInterface } from "node:readline/promises";
import { callModel, type Message } from "./llm.ts";
import { skillSystemPrompt } from "./skill.ts";
import { runTool } from "./tool.ts";

const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const conversation: Message[] = [
  { role: "system", content: skillSystemPrompt },
];

try {
  while (true) {
    const input = (await terminal.question("You: ")).trim();
    if (input === "exit") break;
    if (!input) continue;

    const taskMessages: Message[] = [
      ...conversation,
      { role: "user", content: input },
    ];

    while (true) {
      const message = await callModel(taskMessages);
      taskMessages.push(message);

      if (!message.tool_calls?.length) {
        const answer = message.content ?? "";
        console.log(`Agent: ${answer}\n`);
        conversation.push(
          { role: "user", content: input },
          { role: "assistant", content: answer },
        );
        break;
      }

      for (const call of message.tool_calls) {
        if (call.type !== "function") continue;

        console.log(`Tool: ${call.function.name}`);
        const result = await runTool(
          call.function.name,
          call.function.arguments,
        );

        taskMessages.push({
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

这次拆分不只是为了 Skill。文件内容和命令日志通常也没有必要永久保留，只保存最终回答可以明显减缓跨轮上下文增长。

## 验证自动选择

启动 Agent：

```bash
npx tsx agent.ts
```

先明确指定 Skill：

```txt
使用 code-review skill 审查 tool.ts。
```

日志应该先出现：

```txt
Tool: skill
Tool: read
```

再测试按描述自动选择，不提 Skill 名称：

```txt
检查最近的代码改动，优先报告 bug、安全问题和缺失测试。
```

模型已经在 system message 中看到 `code-review` 的描述，因此应该先加载它。这里的“应该”不是协议保证：模型路由具有概率性，关键流程仍应由用户显式指定，或者在应用层增加确定性规则。

还要验证作用域是否正确。完成代码审查后，再输入一个无关问题：

```txt
解释 package.json 中的 scripts。
```

上一轮的 Skill 正文已经随 `taskMessages` 丢弃，这一轮只会继承用户问题和最终回答，不会继续携带代码审查清单。

## 给发现逻辑加一个检查

Skill 的发现和元数据校验包含目录遍历与解析，值得留下一个最小测试：

```ts
// skill.test.ts
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkillSystemPrompt,
  discoverSkills,
  loadSkill,
} from "./skill.ts";

const root = mkdtempSync(join(tmpdir(), "mini-agent-skills-"));

try {
  const directory = join(root, "code-review");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "SKILL.md"),
    [
      "---",
      "name: code-review",
      "description: Review code for bugs",
      "---",
      "",
      "Report findings first.",
    ].join("\n"),
  );

  const registry = discoverSkills(root);
  assert.equal(registry.size, 1);
  assert.match(createSkillSystemPrompt(registry), /code-review/);
  assert.match(loadSkill("code-review", registry), /Report findings first/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
```

运行检查：

```bash
npx tsx skill.test.ts
```

## 这套系统支持什么

现在的 Skill 系统已经具备完整的核心链路：

- 自动发现：启动时扫描所有 Skill。
- 自动路由：模型根据名称和描述选择 Skill。
- 显式路由：用户可以强制指定 Skill。
- 渐进加载：system message 只包含元数据，正文按需加载。
- 资源定位：加载结果提供基础目录，可继续读取参考资料或脚本。
- 格式校验：错误 Skill 在启动时直接暴露。
- 任务隔离：Skill 正文不会永久留在跨轮历史中。
- 可测试性：发现、清单和加载逻辑可以脱离模型单独测试。

它仍然有清晰的边界：

- Skill 在进程启动时读取，新增或修改后需要重启 Agent。
- 自动匹配依赖模型判断，不保证每次选择完全一致。
- Skill 文件被当作可信本地配置，没有解决恶意指令或提示注入。
- 多个 Skill 同时匹配时由模型选择最小集合，没有实现确定性优先级。
- Skill 脚本仍通过 Bash 运行，继承上一篇讨论过的权限风险。

这些边界并不妨碍它成为一个真正可用的 Skill 系统：发现、选择、加载、执行和作用域已经形成闭环。只有当实际项目需要热更新、远程 Skill、版本解析或确定性路由时，再继续增加相应机制。

## 参考资料

- [Agent Skills Specification](https://agentskills.io/specification)
- [gray-matter](https://github.com/jonschlinkert/gray-matter)
- [Node.js File System](https://nodejs.org/api/fs.html)
- [DeepSeek：Function Calling](https://api-docs.deepseek.com/guides/function_calling/)
