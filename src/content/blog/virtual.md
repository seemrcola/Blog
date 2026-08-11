---
title: "虚拟列表探索：从定高到不定高"
description: "从可视区计算、动态测量和滚动锚定，一步步实现无头虚拟列表"
date: 2026-07-27
tags: [技术, 思考]
status: complete
---

## 为什么需要虚拟列表

在不分页的场景下，当数据量和单项 DOM 复杂度都比较高时，一次性渲染所有数据可能导致首次渲染变慢、内存占用升高和滚动卡顿。虚拟列表通过只渲染可视区域附近的元素来减少同时存在的 DOM 数量。

最近遇到的场景是一个 4 小时会议的语音转写，有接近五千条记录。每条记录并不只是文本，还包含头像、昵称等内容。在目标设备上确认完整渲染存在明显卡顿后，虚拟列表才成为值得采用的方案。数据量不是唯一判断标准，最好先通过实际性能测试确认瓶颈确实来自大量 DOM。

## 阅读路线

这篇文章从简单到复杂分为四层，不必一次读完：

1. **定高列表**：理解占位高度、可视区间和位置偏移，这是虚拟列表最小闭环。
2. **不定高列表**：加入估算高度、前缀和、二分查找、真实测量和滚动锚定。
3. **未知尺寸图片**：验证异步内容加载后，测量和锚点修正是否仍然成立。
4. **无头实现**：把数学计算、状态管理、DOM 适配和渲染拆开，方便接入不同框架。

如果目标只是理解虚拟列表原理，读完定高列表即可；如果业务中的列表项会换行或包含图片，再继续阅读不定高部分；最后的 TypeScript 无头实现主要讨论工程边界。生产项目如果没有特殊需求，应优先评估成熟虚拟列表库，再决定是否维护自己的实现。

## 定高虚拟列表

定高虚拟列表只需要做三件事：

1. 用一个空元素撑出完整列表的高度，让滚动条保持正确。
2. 根据 `scrollTop / rowHeight` 算出第一条可见数据。
3. 只渲染可视区域附近的数据，再用 `translateY` 把它们移动到正确位置。

### 可运行示例

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
    const offset = Math.max(0, scrollTop);
    const firstVisible = Math.floor(offset / rowHeight);
    const endVisible = Math.ceil((offset + viewportHeight) / rowHeight);
    return {
      start: Math.max(0, firstVisible - overscan),
      end: Math.min(total, endVisible + overscan),
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

滚动示例时，状态栏中的总数据量始终是 5000，但实际渲染的列表项通常只有十几条。可以在浏览器开发者工具中检查 `.virtual-demo__row` 的数量，确认 DOM 数量不会随着滚动持续增长。

### 最小实现

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
    const offset = Math.max(0, scrollTop);
    const firstVisible = Math.floor(offset / rowHeight);
    const endVisible = Math.ceil((offset + viewportHeight) / rowHeight);
    return {
      start: Math.max(0, firstVisible - overscan),
      end: Math.min(total, endVisible + overscan),
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

### 把计算和 DOM 操作分开

上面的 `getVisibleRange` 不依赖浏览器，可以单独测试。它只负责回答一个问题：给定滚动状态，应该渲染哪一个半开区间 `[start, end)`。

```js
function getVisibleRange({ scrollTop, viewportHeight, rowHeight, total, overscan }) {
  const offset = Math.max(0, scrollTop);
  const firstVisible = Math.floor(offset / rowHeight);
  const endVisible = Math.ceil((offset + viewportHeight) / rowHeight);

  return {
    start: Math.max(0, firstVisible - overscan),
    end: Math.min(total, endVisible + overscan),
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

此时列表可以正常滚动，但所有行的位置还是估算值。先用估算值把滚动条撑起来很重要，否则总高度会从零开始随着已测量内容不断增长。真实测量仍会修正总高度，但变化会小得多。

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

到这里，不定高虚拟列表的反馈闭环已经完整：先估算位置并渲染，浏览器测量真实高度，再更新位置表并修正滚动锚点。验证时可以重点观察两件事：长文本换行后是否重叠，以及上方行高变化时当前内容是否明显跳动。

## 列表项包含未知尺寸的图片

图片是最常见的不定高来源。这里假设接口只返回图片地址，不返回宽高：图片下载前，浏览器无法知道它最终会占多高；图片下载后，行高才从估算值变成真实值。

不需要给每张图片单独写一套测量逻辑。继续观察整行即可：图片加载、文字换行、字体变化最终都会改变行元素的高度，`ResizeObserver` 会统一更新 `heights` 和 `offsets`。

创建图片时只做三件事：原生懒加载、异步解码，以及给未知尺寸留一个最低限度的占位。

```js
const media = document.createElement('div');
const image = document.createElement('img');

media.className = 'variable-row__media';
image.className = 'variable-row__image';
image.src = item.imageUrl;
image.alt = item.imageAlt ?? '';
image.loading = 'lazy';
image.decoding = 'async';
media.append(image);
row.append(media);

// 仍然只观察行，不需要监听 image.onload。
observer.observe(row);
```

```css
.variable-row__media {
  min-height: 160px;
  background: #f3f4f4;
}

.variable-row__image {
  display: block;
  width: 100%;
  height: auto;
}
```

`160px` 不是图片的真实高度，只是避免图片加载前该区域完全塌陷。图片实际高度超过它时，容器会自然撑开；随后 `ResizeObserver` 测到新的整行高度，前缀和与 `spacer` 高度会被重新计算，前面的锚点修正则负责避免内容跳动。这个值应该接近业务中图片区域的常见高度。

如果列表里有的项带图、有的项只有文字，可以从一开始就使用不同估算值：

```js
const heights = Float64Array.from(
  data,
  (item) => item.imageUrl ? 240 : 56,
);
```

这样首屏尚未测量时，总高度会更接近真实结果。估算仍然不要求准确，因为每个渲染过的行最终都会被真实高度替换。

原生 `loading="lazy"` 只控制何时请求图片，并不能解决高度问题。虚拟列表本身已经只创建可视区和 overscan 内的节点，所以不需要再用 `IntersectionObserver` 实现一遍图片懒加载。图片加载失败时，占位容器仍保留 `min-height`，行高也不会突然缩成零。

还有一个边界：行滚出渲染区后会被移除，`observer.disconnect()` 已经停止观察旧节点。即使旧图片稍后完成下载，也不会修改 `heights`；它再次进入可视区时，新行会重新创建并重新测量。因此当前实现不需要额外处理过期的 `load` 回调。只有以后改成 DOM 节点池复用时，才需要用数据唯一 ID 检查节点是否仍对应原来的列表项。

### 图片列表示例

下面的示例把上面的方案组合起来。数据只提供图片 URL，不提供图片宽高；每条转写内容也使用不同长度。滚动时图片会陆续加载，行高会被重新测量，状态栏则显示当前实际渲染的 DOM 数量。

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

  .variable-demo__image {
    grid-column: 1 / -1;
    display: block;
    width: 100%;
    min-height: 160px;
    margin-bottom: 10px;
    background: #f3f4f4;
    object-fit: cover;
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
  const VARIABLE_ROW_ESTIMATE = 240;
  const VARIABLE_OVERSCAN = 3;
  const VARIABLE_TOTAL = 5000;
  const variableSpeakers = ['主持人', '小周', '小林'];
  const variableImageSizes = [[640, 360], [640, 480], [640, 720], [640, 426]];
  const variableData = Array.from({ length: VARIABLE_TOTAL }, (_, index) => {
    const [width, height] = variableImageSizes[index % variableImageSizes.length];
    return {
      speaker: variableSpeakers[index % variableSpeakers.length],
      imageUrl: `https://picsum.photos/seed/virtual-${index}/${width}/${height}`,
      text: `这是第 ${index + 1} 条会议转写内容。${'这段内容用于模拟不同长度的语音转写。'.repeat(index % 4 + 1)}`,
    };
  });

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
        const image = document.createElement('img');
        const item = variableData[index];

        row.className = 'variable-demo__row';
        row.dataset.index = String(index);
        row.role = 'listitem';
        row.setAttribute('aria-posinset', String(index + 1));
        row.setAttribute('aria-setsize', String(VARIABLE_TOTAL));
        row.style.top = `${offsets[index]}px`;
        image.className = 'variable-demo__image';
        image.src = item.imageUrl;
        image.alt = `第 ${index + 1} 条转写配图`;
        image.loading = 'lazy';
        image.decoding = 'async';
        number.className = 'variable-demo__index';
        speaker.className = 'variable-demo__speaker';
        text.className = 'variable-demo__text';
        number.textContent = String(index + 1).padStart(4, '0');
        speaker.textContent = item.speaker;
        text.textContent = item.text;
        row.append(image, number, speaker, text);
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

## TypeScript 无头虚拟列表

前面的纯函数只能复用区间计算，高度缓存、测量更新和滚动锚点仍然写在 DOM 代码里。换成 Vue 或 React 时，这些状态逻辑还要再实现一次，因此还不算真正的无头层。

如果只需要解决当前页面中的不定高列表，可以停在上一节。下面的内容不再增加新的虚拟列表算法，而是把已有算法整理成可测试、可替换渲染层的工程结构。

更合适的边界是：核心层接收数量、估算高度、视口状态和测量结果，输出 `VirtualItem[]`、总高度与滚动修正量；DOM 适配层负责读取 `scrollTop`、调用 `ResizeObserver` 和应用修正；渲染层决定最终创建 DOM，还是交给框架组件渲染。

```txt
geometry.ts       纯数学计算
      ↓
virtualizer.ts    无头状态核心
      ↓
dom-adapter.ts    浏览器适配
      ↓
main.ts           具体渲染
```

下面给出完整的 TypeScript + Vite 示例。项目结构如下：

```txt
virtual-list/
├─ index.html
├─ package.json
├─ tsconfig.json
└─ src/
   ├─ main.ts
   ├─ style.css
   └─ virtual/
      ├─ geometry.ts
      ├─ virtualizer.ts
      └─ dom-adapter.ts
```

### 纯计算层：`src/virtual/geometry.ts`

```ts
export type VisibleRange = {
  start: number;
  end: number;
};

export type ScrollAnchor = {
  index: number;
  delta: number;
};

export function buildOffsets(sizes: ArrayLike<number>): Float64Array {
  const offsets = new Float64Array(sizes.length + 1);

  for (let index = 0; index < sizes.length; index += 1) {
    offsets[index + 1] = offsets[index] + sizes[index];
  }

  return offsets;
}

export function findIndex(
  offsets: ArrayLike<number>,
  scrollOffset: number,
): number {
  const last = offsets.length - 2;
  if (last < 0) return 0;

  let left = 0;
  let right = last;
  const target = Math.max(0, scrollOffset);

  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    if (offsets[middle] <= target) left = middle;
    else right = middle - 1;
  }

  return left;
}

export function getVisibleRange(options: {
  scrollOffset: number;
  viewportSize: number;
  offsets: ArrayLike<number>;
  overscan: number;
}): VisibleRange {
  const { scrollOffset, viewportSize, offsets, overscan } = options;
  const total = offsets.length - 1;
  if (total === 0) return { start: 0, end: 0 };

  const first = findIndex(offsets, scrollOffset);
  const last = findIndex(offsets, scrollOffset + viewportSize);

  return {
    start: Math.max(0, first - overscan),
    end: Math.min(total, last + 1 + overscan),
  };
}

export function getScrollAnchor(
  offsets: ArrayLike<number>,
  scrollOffset: number,
): ScrollAnchor {
  const index = findIndex(offsets, scrollOffset);
  return {
    index,
    delta: scrollOffset - offsets[index],
  };
}
```

这一层没有类、缓存或浏览器 API，可以直接单测，也可以被任何渲染环境复用。

### 无头核心：`src/virtual/virtualizer.ts`

```ts
import {
  buildOffsets,
  getScrollAnchor,
  getVisibleRange,
} from './geometry';

export type ItemKey = string | number;

export type VirtualItem = {
  key: ItemKey;
  index: number;
  start: number;
  size: number;
  end: number;
};

export type VirtualSnapshot = {
  items: VirtualItem[];
  totalSize: number;
};

export type Measurement = {
  index: number;
  size: number;
};

export type MeasureResult = {
  changed: boolean;
  scrollAdjustment: number;
  snapshot: VirtualSnapshot;
};

export type VirtualizerOptions = {
  count: number;
  estimateSize: (index: number) => number;
  getItemKey?: (index: number) => ItemKey;
  overscan?: number;
};

export class Virtualizer {
  private count: number;
  private readonly estimateSize: (index: number) => number;
  private readonly getItemKey: (index: number) => ItemKey;
  private readonly overscan: number;
  private sizes: Float64Array;
  private offsets: Float64Array;
  private scrollOffset = 0;
  private viewportSize = 0;

  constructor(options: VirtualizerOptions) {
    this.count = Math.max(0, options.count);
    this.estimateSize = options.estimateSize;
    this.getItemKey = options.getItemKey ?? ((index) => index);
    this.overscan = Math.max(0, options.overscan ?? 0);
    this.sizes = Float64Array.from(
      { length: this.count },
      (_, index) => this.getEstimate(index),
    );
    this.offsets = buildOffsets(this.sizes);
  }

  setViewport(scrollOffset: number, viewportSize: number): VirtualSnapshot {
    this.scrollOffset = Math.max(0, scrollOffset);
    this.viewportSize = Math.max(0, viewportSize);
    return this.getSnapshot();
  }

  setCount(count: number): VirtualSnapshot {
    const nextCount = Math.max(0, count);
    const nextSizes = new Float64Array(nextCount);
    const preserved = Math.min(this.count, nextCount);

    nextSizes.set(this.sizes.subarray(0, preserved));
    for (let index = preserved; index < nextCount; index += 1) {
      nextSizes[index] = this.getEstimate(index);
    }

    this.count = nextCount;
    this.sizes = nextSizes;
    this.offsets = buildOffsets(this.sizes);
    return this.getSnapshot();
  }

  measure(measurements: readonly Measurement[]): MeasureResult {
    const anchor = getScrollAnchor(this.offsets, this.scrollOffset);
    const previousAnchorStart = this.offsets[anchor.index] ?? 0;
    let changed = false;

    for (const measurement of measurements) {
      const { index } = measurement;
      const size = Math.max(1, measurement.size);

      if (index < 0 || index >= this.count) continue;
      if (Math.abs(this.sizes[index] - size) < 0.5) continue;

      this.sizes[index] = size;
      changed = true;
    }

    if (!changed) {
      return {
        changed: false,
        scrollAdjustment: 0,
        snapshot: this.getSnapshot(),
      };
    }

    this.offsets = buildOffsets(this.sizes);
    const nextAnchorStart = this.offsets[anchor.index] ?? 0;
    const scrollAdjustment = nextAnchorStart - previousAnchorStart;
    this.scrollOffset += scrollAdjustment;

    return {
      changed: true,
      scrollAdjustment,
      snapshot: this.getSnapshot(),
    };
  }

  getSnapshot(): VirtualSnapshot {
    const { start, end } = getVisibleRange({
      scrollOffset: this.scrollOffset,
      viewportSize: this.viewportSize,
      offsets: this.offsets,
      overscan: this.overscan,
    });
    const items: VirtualItem[] = [];

    for (let index = start; index < end; index += 1) {
      const itemStart = this.offsets[index];
      const size = this.sizes[index];
      items.push({
        key: this.getItemKey(index),
        index,
        start: itemStart,
        size,
        end: itemStart + size,
      });
    }

    return {
      items,
      totalSize: this.offsets[this.count] ?? 0,
    };
  }

  private getEstimate(index: number): number {
    return Math.max(1, this.estimateSize(index));
  }
}
```

### DOM 适配层：`src/virtual/dom-adapter.ts`

```ts
import {
  Virtualizer,
  type Measurement,
  type VirtualSnapshot,
} from './virtualizer';

export type DOMAdapterOptions = {
  scrollElement: HTMLElement;
  virtualizer: Virtualizer;
  onChange: (snapshot: VirtualSnapshot) => void;
};

export class DOMVirtualizerAdapter {
  private readonly scrollElement: HTMLElement;
  private readonly virtualizer: Virtualizer;
  private readonly onChange: (snapshot: VirtualSnapshot) => void;
  private readonly rowObserver: ResizeObserver;
  private readonly viewportObserver: ResizeObserver;
  private frame: number | null = null;

  constructor(options: DOMAdapterOptions) {
    this.scrollElement = options.scrollElement;
    this.virtualizer = options.virtualizer;
    this.onChange = options.onChange;

    this.rowObserver = new ResizeObserver((entries) => {
      const measurements: Measurement[] = entries.map((entry) => ({
        index: Number((entry.target as HTMLElement).dataset.index),
        size: entry.target.getBoundingClientRect().height,
      }));
      const result = this.virtualizer.measure(measurements);

      if (!result.changed) return;
      if (Math.abs(result.scrollAdjustment) >= 0.5) {
        this.scrollElement.scrollTop += result.scrollAdjustment;
      }
      this.onChange(result.snapshot);
    });

    this.viewportObserver = new ResizeObserver(() => this.scheduleUpdate());
  }

  start(): void {
    this.scrollElement.addEventListener('scroll', this.scheduleUpdate, {
      passive: true,
    });
    this.viewportObserver.observe(this.scrollElement);
    this.update();
  }

  observeRows(elements: readonly HTMLElement[]): void {
    this.rowObserver.disconnect();
    elements.forEach((element) => this.rowObserver.observe(element));
  }

  destroy(): void {
    this.scrollElement.removeEventListener('scroll', this.scheduleUpdate);
    this.rowObserver.disconnect();
    this.viewportObserver.disconnect();

    if (this.frame !== null) cancelAnimationFrame(this.frame);
  }

  private scheduleUpdate = (): void => {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.update();
    });
  };

  private update(): void {
    const snapshot = this.virtualizer.setViewport(
      this.scrollElement.scrollTop,
      this.scrollElement.clientHeight,
    );
    this.onChange(snapshot);
  }
}
```

适配器只翻译两类信息：把浏览器的滚动和测量结果送进核心，再把核心给出的修正量应用到滚动容器。它不关心列表项具体长什么样。

### 渲染层：`src/main.ts`

```ts
import './style.css';
import { DOMVirtualizerAdapter } from './virtual/dom-adapter';
import {
  Virtualizer,
  type VirtualItem,
  type VirtualSnapshot,
} from './virtual/virtualizer';

type Transcript = {
  id: number;
  speaker: string;
  imageUrl: string;
  text: string;
};

const TOTAL = 5000;
const speakers = ['主持人', '小周', '小林'];
const imageSizes = [[640, 360], [640, 480], [640, 720], [640, 426]];

// 模拟接口数据：列表项只有 URL，没有可供虚拟列表使用的宽高字段。
const data: Transcript[] = Array.from({ length: TOTAL }, (_, index) => {
  const [width, height] = imageSizes[index % imageSizes.length];
  return {
    id: index + 1,
    speaker: speakers[index % speakers.length],
    imageUrl: `https://picsum.photos/seed/virtual-${index}/${width}/${height}`,
    text: `这是第 ${index + 1} 条会议转写内容。${'这段内容用于模拟不同长度的语音转写。'.repeat(index % 4 + 1)}`,
  };
});

function getElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const viewport = getElement<HTMLDivElement>('#viewport');
const spacer = getElement<HTMLDivElement>('#spacer');
const rows = getElement<HTMLDivElement>('#rows');
const status = getElement<HTMLParagraphElement>('#status');

const virtualizer = new Virtualizer({
  count: data.length,
  estimateSize: () => 240,
  getItemKey: (index) => data[index].id,
  overscan: 3,
});

function createRow(virtualItem: VirtualItem): HTMLElement {
  const item = data[virtualItem.index];
  const row = document.createElement('article');
  const image = document.createElement('img');
  const meta = document.createElement('div');
  const number = document.createElement('span');
  const speaker = document.createElement('strong');
  const text = document.createElement('p');

  row.className = 'row';
  row.dataset.index = String(virtualItem.index);
  row.setAttribute('role', 'listitem');
  row.setAttribute('aria-posinset', String(virtualItem.index + 1));
  row.setAttribute('aria-setsize', String(data.length));
  row.style.transform = `translateY(${virtualItem.start}px)`;

  image.className = 'row__image';
  image.src = item.imageUrl;
  image.alt = `第 ${item.id} 条转写配图`;
  image.loading = 'lazy';
  image.decoding = 'async';

  meta.className = 'row__meta';
  number.textContent = String(item.id).padStart(4, '0');
  speaker.textContent = item.speaker;
  meta.append(number, speaker);

  text.className = 'row__text';
  text.textContent = item.text;
  row.append(image, meta, text);
  return row;
}

let adapter: DOMVirtualizerAdapter;

function render(snapshot: VirtualSnapshot): void {
  const elements = snapshot.items.map(createRow);
  spacer.style.height = `${snapshot.totalSize}px`;
  rows.replaceChildren(...elements);
  adapter.observeRows(elements);
  status.textContent = `当前渲染 ${elements.length} / ${data.length} 个列表项`;
}

adapter = new DOMVirtualizerAdapter({
  scrollElement: viewport,
  virtualizer,
  onChange: render,
});
adapter.start();
```

### 页面入口：`index.html`

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>未知图片高度的虚拟列表</title>
  </head>
  <body>
    <main>
      <div id="viewport" role="list" aria-label="不定高图片列表" tabindex="0">
        <div id="spacer">
          <div id="rows"></div>
        </div>
      </div>
      <p id="status" aria-live="polite"></p>
    </main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

### 样式：`src/style.css`

```css
* { box-sizing: border-box; }

body {
  max-width: 760px;
  margin: 40px auto;
  padding: 0 16px;
  color: #18201d;
  font-family: system-ui, sans-serif;
}

#viewport {
  height: 520px;
  overflow-y: auto;
  border: 1px solid #d8ddda;
  background: #fff;
  contain: strict;
  overflow-anchor: none;
}

#spacer { position: relative; }

#rows {
  position: absolute;
  inset: 0 0 auto;
}

.row {
  position: absolute;
  right: 0;
  left: 0;
  padding: 14px;
  border-bottom: 1px solid #e4e7e5;
}

.row__image {
  display: block;
  width: 100%;
  height: auto;
  min-height: 160px;
  background: #f3f4f4;
  object-fit: cover;
}

.row__meta {
  display: flex;
  gap: 16px;
  margin-top: 10px;
  font: 13px/1.5 ui-monospace, monospace;
}

.row__meta span { color: #66706c; }

.row__text {
  margin: 8px 0 0;
  line-height: 1.65;
}

#status {
  margin: 8px 0 0;
  color: #66706c;
  font: 12px/1.5 ui-monospace, monospace;
}
```

### 工程配置

`package.json`：

```json
{
  "name": "headless-virtual-list",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build"
  },
  "devDependencies": {
    "typescript": "^5.9.2",
    "vite": "^7.1.0"
  }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

安装依赖后运行：

```sh
npm install
npm run dev
```

这套 API 的关键不是类本身，而是边界：`Virtualizer` 不知道滚动元素和列表项 DOM，渲染方也不需要理解前缀和与锚点算法。接入 React 或 Vue 时，保留 `geometry.ts` 与 `virtualizer.ts`，用框架自己的生命周期替换 `dom-adapter.ts` 和 `main.ts` 即可。

## 回顾与取舍

虚拟列表真正需要维护的不是一组 DOM，而是三类状态：列表项尺寸、列表项位置和当前可视区。定高列表可以直接通过乘法得到位置；不定高列表则需要先估算，再通过测量逐步修正。

实现时可以按下面的顺序控制复杂度：

1. 能固定行高时优先使用定高方案。
2. 行高不可控时，再加入高度缓存、前缀和与二分查找。
3. 高度修正造成跳动时，再处理滚动锚点。
4. 只有多个渲染环境需要复用时，才抽取无头核心和 DOM 适配层。
5. 数据规模继续增大且 `O(n)` 重建已经成为真实瓶颈时，再考虑 Fenwick 树等结构。

本文实现主要用于理解原理和验证业务边界。生产环境还要处理数据插入、删除、排序、稳定 key、滚动到指定项、服务端渲染和浏览器最大滚动高度等问题；如果这些能力都需要，采用成熟库通常比继续扩展示例代码更合适。

## 参考资料

- [MDN：Element.scrollTop](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollTop)
- [MDN：ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver)
- [MDN：overflow-anchor](https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-anchor)
- [TanStack Virtual](https://tanstack.com/virtual/latest/docs/introduction)
