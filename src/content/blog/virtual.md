---
title: "虚拟列表探索"
description: "学习和研究虚拟列表/复杂虚拟列表的实现"
date: 2026-07-27
tags: [技术, 思考]
status: in-progress
---

## 为什么需要虚拟列表

在不分页的场景下，当数据量非常大时，一次性渲染所有数据会导致页面卡顿甚至崩溃。虚拟列表通过只渲染可视区域内的元素来解决这个问题。

最近遇到的场景是一个 4 小时会议的语音转写，有接近五千条记录。每条记录并不只是文本，还包含头像、昵称等内容，一次性渲染会明显卡顿，此时就需要虚拟列表。

## 原理

定高虚拟列表只需要做三件事：

1. 用一个空元素撑出完整列表的高度，让滚动条保持正确。
2. 根据 `scrollTop / rowHeight` 算出第一条可见数据。
3. 只渲染可视区域附近的数据，再用 `translateY` 把它们移动到正确位置。

下面是一个 5000 条数据的实际例子。视口高 `360px`，每行高 `52px`，上下各多渲染 3 行来避免快速滚动时出现空白。

<div class="virtual-demo" data-virtual-list>
  <div class="virtual-demo__viewport" role="list" aria-label="5000 条会议转写" tabindex="0">
    <div class="virtual-demo__spacer">
      <div class="virtual-demo__rows"></div>
    </div>
  </div>
  <p class="virtual-demo__status" aria-live="polite"></p>
</div>

<style>
  .virtual-demo {
    margin: 1.8em 0;
    font-family: var(--mono);
  }

  .virtual-demo__viewport {
    height: 360px;
    overflow-y: auto;
    border: 1px solid var(--line);
    background: #fff;
    contain: strict;
  }

  .virtual-demo__viewport:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
  }

  .virtual-demo__spacer {
    position: relative;
  }

  .virtual-demo__rows {
    position: absolute;
    inset: 0 0 auto;
    will-change: transform;
  }

  .virtual-demo__row {
    display: grid;
    grid-template-columns: 52px 64px minmax(0, 1fr);
    align-items: center;
    height: 52px;
    padding: 0 14px;
    border-bottom: 1px solid #e4e7e5;
    font-size: .76rem;
  }

  .virtual-demo__index {
    color: var(--muted);
  }

  .virtual-demo__speaker {
    font-weight: 700;
  }

  .virtual-demo__text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .virtual-demo .virtual-demo__status {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: .72rem;
  }
</style>

<script>
  const ROW_HEIGHT = 52;
  const OVERSCAN = 3;
  const TOTAL = 5000;
  const speakers = ['主持人', '小周', '小林'];

  function getVisibleRange({ scrollTop, viewportHeight, rowHeight, total, overscan }) {
    const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
    const visibleCount = Math.ceil(viewportHeight / rowHeight);
    return {
      start: Math.max(0, firstVisible - overscan),
      end: Math.min(total, firstVisible + visibleCount + overscan),
    };
  }

  document.querySelectorAll('[data-virtual-list]').forEach((root) => {
    const viewport = root.querySelector('.virtual-demo__viewport');
    const spacer = root.querySelector('.virtual-demo__spacer');
    const rows = root.querySelector('.virtual-demo__rows');
    const status = root.querySelector('.virtual-demo__status');
    let frame;

    spacer.style.height = `${TOTAL * ROW_HEIGHT}px`;

    const render = () => {
      const { start, end } = getVisibleRange({
        scrollTop: viewport.scrollTop,
        viewportHeight: viewport.clientHeight,
        rowHeight: ROW_HEIGHT,
        total: TOTAL,
        overscan: OVERSCAN,
      });

      rows.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
      rows.replaceChildren(...Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        const row = document.createElement('div');
        const number = document.createElement('span');
        const speaker = document.createElement('span');
        const text = document.createElement('span');

        row.className = 'virtual-demo__row';
        row.role = 'listitem';
        row.setAttribute('aria-posinset', String(index + 1));
        row.setAttribute('aria-setsize', String(TOTAL));
        number.className = 'virtual-demo__index';
        speaker.className = 'virtual-demo__speaker';
        text.className = 'virtual-demo__text';
        number.textContent = String(index + 1).padStart(4, '0');
        speaker.textContent = speakers[index % speakers.length];
        text.textContent = `这是第 ${index + 1} 条会议转写内容`;
        row.append(number, speaker, text);
        return row;
      }));

      status.textContent = `当前渲染 ${end - start} / ${TOTAL} 个列表项`;
    };

    viewport.addEventListener('scroll', () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    }, { passive: true });

    render();
  });
</script>

## 最小实现

去掉演示中的文案和无障碍属性后，核心实现只有下面这些。它不依赖框架，也不需要提前创建 5000 个 DOM 节点。

```html
<div id="viewport">
  <div id="spacer">
    <div id="rows"></div>
  </div>
</div>

<style>
  #viewport { height: 360px; overflow-y: auto; contain: strict; }
  #spacer { position: relative; }
  #rows { position: absolute; inset: 0 0 auto; }
  .row { height: 52px; }
</style>

<script>
  const data = Array.from({ length: 5000 }, (_, i) => `第 ${i + 1} 条数据`);
  const rowHeight = 52;
  const overscan = 3;

  const viewport = document.getElementById('viewport');
  const spacer = document.getElementById('spacer');
  const rows = document.getElementById('rows');

  // 纯计算：不读取 DOM，也不修改任何外部状态。
  function getVisibleRange({ scrollTop, viewportHeight, rowHeight, total, overscan }) {
    const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
    const visibleCount = Math.ceil(viewportHeight / rowHeight);
    return {
      start: Math.max(0, firstVisible - overscan),
      end: Math.min(total, firstVisible + visibleCount + overscan),
    };
  }

  spacer.style.height = `${data.length * rowHeight}px`;

  function render() {
    const { start, end } = getVisibleRange({
      scrollTop: viewport.scrollTop,
      viewportHeight: viewport.clientHeight,
      rowHeight,
      total: data.length,
      overscan,
    });

    rows.style.transform = `translateY(${start * rowHeight}px)`;
    rows.replaceChildren(...data.slice(start, end).map((text) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.textContent = text;
      return row;
    }));
  }

  viewport.addEventListener('scroll', render, { passive: true });
  render();
</script>
```

这版成立的关键是**每一行高度固定**。总高度是 `data.length * rowHeight`，偏移量是 `start * rowHeight`，因此不需要逐项测量，也不需要维护位置缓存。

`overscan` 不是必需的，但多渲染几行可以遮住快速滚动时浏览器来不及绘制的瞬间。这里只取 3，继续增大只会增加 DOM 数量。

## 把计算和 DOM 操作分开

上面的 `getVisibleRange` 不依赖浏览器，可以单独测试。它只负责回答一个问题：给定滚动状态，应该渲染哪一个半开区间 `[start, end)`。

```js
function getVisibleRange({ scrollTop, viewportHeight, rowHeight, total, overscan }) {
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visibleCount = Math.ceil(viewportHeight / rowHeight);

  return {
    start: Math.max(0, firstVisible - overscan),
    end: Math.min(total, firstVisible + visibleCount + overscan),
  };
}

// 不需要 DOM：顶部和底部都不会越界。
console.assert(
  JSON.stringify(getVisibleRange({
    scrollTop: 0,
    viewportHeight: 360,
    rowHeight: 52,
    total: 5000,
    overscan: 3,
  })) === JSON.stringify({ start: 0, end: 10 }),
);
```

DOM 层只消费计算结果：设置占位高度、移动行容器、创建当前区间的数据。以后换成 Vue、React 或别的渲染方式时，`getVisibleRange` 都可以原样复用。

## 不定高虚拟列表

定高版本的前提是：第 `i` 项的位置可以直接写成 `i * rowHeight`。不定高时，这个公式失效了。我们不能直接知道第 `i` 项的顶部位置，只能先估算，再用真实 DOM 高度逐步修正。

下面分四步实现。每一步都可以独立理解，最后再组合起来。

### 第一步：先用估算高度撑起列表

在任何一项被渲染前，我们都还不知道它的真实高度，所以先给每一项一个估算值。`offsets[i]` 表示第 `i` 项的顶部位置，`offsets[data.length]` 就是整个列表的高度。

```js
const estimatedHeight = 56;
const heights = new Float64Array(data.length).fill(estimatedHeight);
const offsets = new Float64Array(data.length + 1);

function rebuildOffsets() {
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i += 1) {
    offsets[i + 1] = offsets[i] + heights[i];
  }
}

rebuildOffsets();
spacer.style.height = `${offsets[offsets.length - 1]}px`;
```

此时列表可以正常滚动，但所有行的位置还是估算值。先把滚动条撑起来很重要，否则用户滚动到后面时，列表总高度会不断变化。

估算高度最好来自首屏样本的平均值、历史数据的均值，或者一个接近业务分布的经验值。它不需要很准，只要别偏得太离谱就行，因为后面会被真实测量逐步修正。

如果浏览器自己的滚动锚定和手动锚点修正同时生效，滚动位置有时会被来回拉扯。遇到这种情况，可以给滚动容器加上 `overflow-anchor: none;`，把锚点控制权交给自己的实现。

### 第二步：用前缀和查找可视区

`offsets` 是单调递增的，可以对它做二分查找。给定 `scrollTop`，找到最后一个 `offsets[i] <= scrollTop` 的索引，就是当前第一项。

```js
function findIndex(offsets, scrollTop) {
  const last = offsets.length - 2;
  if (last < 0) return 0;

  let left = 0;
  let right = last;
  const target = Math.max(0, scrollTop);

  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    if (offsets[middle] <= target) left = middle;
    else right = middle - 1;
  }

  return left;
}

function getVariableRange({ scrollTop, viewportHeight, offsets, overscan }) {
  const start = Math.max(0, findIndex(offsets, scrollTop) - overscan);
  const end = Math.min(
    offsets.length - 1,
    findIndex(offsets, scrollTop + viewportHeight) + 1 + overscan,
  );

  return { start, end };
}
```

和定高版本一样，`end` 使用半开区间 `[start, end)`。区别是现在每一项都要使用自己的 `offsets[index]` 定位，而不是使用统一的 `index * rowHeight`。

### 第三步：用 `ResizeObserver` 获取真实高度

只观察当前已经渲染的行。某一行的高度发生变化时，更新 `heights[index]`，重建位置表，然后重新渲染。

```js
const observer = new ResizeObserver((entries) => {
  let changed = false;

  for (const entry of entries) {
    const index = Number(entry.target.dataset.index);
    const nextHeight = Math.max(1, entry.target.getBoundingClientRect().height);

    if (Math.abs(heights[index] - nextHeight) < 0.5) continue;
    heights[index] = nextHeight;
    changed = true;
  }

  if (!changed) return;
  rebuildOffsets();
  spacer.style.height = `${offsets[offsets.length - 1]}px`;
  render();
});
```

`ResizeObserver` 不只会捕获文字换行，也能捕获字体加载、图片加载导致的高度变化。这里读取 `getBoundingClientRect().height`，因此 padding 和 border 也会被计入。

### 第四步：修正滚动锚点

如果当前屏幕上方的行从 `56px` 变成了 `100px`，只更新总高度会让下面的内容突然跳动。更新高度前先记住锚点项和它在视口中的相对位置，更新后把这个相对位置恢复。

```js
function updateMeasuredHeights(entries) {
  const anchor = findIndex(offsets, viewport.scrollTop);
  const anchorDelta = viewport.scrollTop - offsets[anchor];
  let changed = false;

  for (const entry of entries) {
    const index = Number(entry.target.dataset.index);
    const nextHeight = Math.max(1, entry.target.getBoundingClientRect().height);
    if (Math.abs(heights[index] - nextHeight) < 0.5) continue;
    heights[index] = nextHeight;
    changed = true;
  }

  if (!changed) return;
  rebuildOffsets();
  spacer.style.height = `${offsets[offsets.length - 1]}px`;
  viewport.scrollTop = offsets[anchor] + anchorDelta;
  render();
}
```

实际代码里可以把这个函数作为 `ResizeObserver` 的回调。这样前面行高变化时，用户仍然停留在原来的内容位置。

### 组合成一个可运行版本

下面的示例把上面四步组合起来。每条转写内容故意使用不同长度，滚动时可以看到行高被逐步测量；状态栏则显示当前实际渲染的 DOM 数量。

<div class="variable-demo" data-variable-list>
  <div class="variable-demo__viewport" role="list" aria-label="不定高会议转写" tabindex="0">
    <div class="variable-demo__spacer">
      <div class="variable-demo__rows"></div>
    </div>
  </div>
  <p class="variable-demo__status" aria-live="polite"></p>
</div>

<style>
  .variable-demo {
    margin: 1.8em 0;
    font-family: var(--mono);
  }

  .variable-demo__viewport {
    height: 360px;
    overflow-y: auto;
    border: 1px solid var(--line);
    background: #fff;
    contain: strict;
  }

  .variable-demo__viewport:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
  }

  .variable-demo__spacer {
    position: relative;
  }

  .variable-demo__rows {
    position: absolute;
    inset: 0 0 auto;
  }

  .variable-demo__row {
    position: absolute;
    right: 0;
    left: 0;
    display: grid;
    grid-template-columns: 52px 64px minmax(0, 1fr);
    gap: 0;
    padding: 12px 14px;
    border-bottom: 1px solid #e4e7e5;
    font-size: .76rem;
    overflow-wrap: anywhere;
  }

  .variable-demo__index {
    color: var(--muted);
  }

  .variable-demo__speaker {
    font-weight: 700;
  }

  .variable-demo__status {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: .72rem;
  }
</style>

<script>
  const VARIABLE_ROW_ESTIMATE = 56;
  const VARIABLE_OVERSCAN = 3;
  const VARIABLE_TOTAL = 5000;
  const variableSpeakers = ['主持人', '小周', '小林'];
  const variableData = Array.from({ length: VARIABLE_TOTAL }, (_, index) => ({
    speaker: variableSpeakers[index % variableSpeakers.length],
    text: `这是第 ${index + 1} 条会议转写内容。${'这段内容用于模拟不同长度的语音转写。'.repeat(index % 4 + 1)}`,
  }));

  function findVariableIndex(offsets, scrollTop) {
    const last = offsets.length - 2;
    if (last < 0) return 0;

    let left = 0;
    let right = last;
    const target = Math.max(0, scrollTop);

    while (left < right) {
      const middle = Math.ceil((left + right) / 2);
      if (offsets[middle] <= target) left = middle;
      else right = middle - 1;
    }

    return left;
  }

  document.querySelectorAll('[data-variable-list]').forEach((root) => {
    const viewport = root.querySelector('.variable-demo__viewport');
    const spacer = root.querySelector('.variable-demo__spacer');
    const rows = root.querySelector('.variable-demo__rows');
    const status = root.querySelector('.variable-demo__status');
    const heights = new Float64Array(VARIABLE_TOTAL).fill(VARIABLE_ROW_ESTIMATE);
    const offsets = new Float64Array(VARIABLE_TOTAL + 1);
    let frame;

    const rebuildOffsets = () => {
      offsets[0] = 0;
      for (let index = 0; index < VARIABLE_TOTAL; index += 1) {
        offsets[index + 1] = offsets[index] + heights[index];
      }
    };

    const getRange = () => {
      const start = Math.max(0, findVariableIndex(offsets, viewport.scrollTop) - VARIABLE_OVERSCAN);
      const end = Math.min(
        VARIABLE_TOTAL,
        findVariableIndex(offsets, viewport.scrollTop + viewport.clientHeight) + 1 + VARIABLE_OVERSCAN,
      );
      return { start, end };
    };

    const observer = new ResizeObserver((entries) => {
      const anchor = findVariableIndex(offsets, viewport.scrollTop);
      const anchorDelta = viewport.scrollTop - offsets[anchor];
      let changed = false;

      for (const entry of entries) {
        const index = Number(entry.target.dataset.index);
        const nextHeight = Math.max(1, entry.target.getBoundingClientRect().height);
        if (Math.abs(heights[index] - nextHeight) < 0.5) continue;
        heights[index] = nextHeight;
        changed = true;
      }

      if (!changed) return;
      rebuildOffsets();
      spacer.style.height = `${offsets[VARIABLE_TOTAL]}px`;
      viewport.scrollTop = offsets[anchor] + anchorDelta;
      render();
    });

    const render = () => {
      const { start, end } = getRange();
      const fragment = document.createDocumentFragment();
      observer.disconnect();

      for (let index = start; index < end; index += 1) {
        const row = document.createElement('div');
        const number = document.createElement('span');
        const speaker = document.createElement('span');
        const text = document.createElement('span');
        const item = variableData[index];

        row.className = 'variable-demo__row';
        row.dataset.index = String(index);
        row.role = 'listitem';
        row.setAttribute('aria-posinset', String(index + 1));
        row.setAttribute('aria-setsize', String(VARIABLE_TOTAL));
        row.style.top = `${offsets[index]}px`;
        number.className = 'variable-demo__index';
        speaker.className = 'variable-demo__speaker';
        text.className = 'variable-demo__text';
        number.textContent = String(index + 1).padStart(4, '0');
        speaker.textContent = item.speaker;
        text.textContent = item.text;
        row.append(number, speaker, text);
        fragment.append(row);
        observer.observe(row);
      }

      rows.replaceChildren(fragment);
      status.textContent = `当前渲染 ${end - start} / ${VARIABLE_TOTAL} 个列表项`;
    };

    rebuildOffsets();
    spacer.style.height = `${offsets[VARIABLE_TOTAL]}px`;
    viewport.addEventListener('scroll', () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    }, { passive: true });
    render();
  });
</script>

这里有一个故意保留的简化：每次高度变化都会从头重建 `offsets`，所以更新成本是 `O(n)`。5000 条转写记录通常够用；如果测量更新已经成为瓶颈，再把位置表替换成 Fenwick 树或线段树，查询和更新都可以降到 `O(log n)`。

## 这版不处理什么

这版已经处理动态行高，但仍不处理滚动到指定项、数据异步加载和列表项焦点保持。这些能力会继续增加实现复杂度；真正遇到这些需求时，可以在当前算法上继续补齐，或者使用成熟的虚拟列表库。

补一条更具体的：如果后面要支持插入、删除，或者向上加载历史消息，`offsets` 都需要重新计算；而 `scrollToIndex` 之所以麻烦，也是因为它必须先通过前缀和定位，再把滚动位置精确落到目标项上。
