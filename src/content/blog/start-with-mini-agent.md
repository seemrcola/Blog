---
title: "从Agent开始"
description: "从Agent开始，记录值得反复阅读和继续思考的内容。"
date: 2026-07-22
tags: [随笔, 开始]
---

## 300行代码实现一个coding agent
有大神说，如果不能300行代码实现一个coding agent，那就还是不懂agent(大意如此)。

### 先最简单调用一下llm
```ts
type ChatCompletion = {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
};

export async function callModel(prompt: string): Promise<string> {
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
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`Model request failed (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as ChatCompletion;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Model returned an empty response");
  }

  return content;
}


async function agent() {
  const result = await callModel("你是谁");
  console.log(result);
}
```
现在，我们执行agent()函数，可以看到输出的结果。但是现在这个对话执行完之后就会结束，我们希望它能持续对话下去。

### 持续对话

