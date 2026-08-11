---
title: "Vela 01：建立 WebRTC DataChannel"
description: "从信令、SDP 和 ICE 开始，让两个浏览器建立 DataChannel"
date: 2026-07-27
tags: [技术, 思考]
status: in-progress
---

## 前言
简单来说，我想做一个基于 Web 的文件传输工具，这样可以方便地在不同的设备之间传输文件，又不需要安装第三方 App。

本篇只完成 Vela 的第一步：让两个浏览器通过信令服务协商并建立 WebRTC DataChannel，然后互发一段文本。文件分片、背压控制、完整性校验和断线重连会在后续文章中实现。

## 方案选择
对于浏览器之间的跨平台传输，WebRTC 是一个合适的选择。它可以让两个浏览器建立实时连接，并提供用于传输任意应用数据的 DataChannel。这个技术我也不甚了解，接下来就从一个最小闭环开始学习。

## 为什么选择 WebRTC
WebRTC 对这个项目的主要价值是：
- 跨平台：只要设备上的浏览器支持 WebRTC，就可以使用同一套前端代码。
- 优先尝试点对点直连：直连成功时可以减少服务器中转和带宽成本。
- 低延迟、高吞吐的潜力：设备直连时通常比应用层转发更直接，但实际效果取决于网络条件。
- 传输过程默认加密：DataChannel 会建立加密连接，但这不等于应用已经完成用户身份认证。
- 支持 NAT 穿透：ICE 会尝试多种连接路径；直连失败时仍可能需要 TURN 服务器中继。

## 完成本篇需要了解的基础概念

本篇会用到的专业名词：
- 信令（Signaling）：双方交换建立连接所需的信息，通常用 WebSocket 实现。
- SDP：描述双方支持的连接方式和通信能力。
- ICE：收集并尝试可用的网络连接路径。
- STUN / TURN：STUN 用于发现公网地址；TURN 在无法直连时负责中继。
- RTCDataChannel：WebRTC 中实际传输应用数据的双向通道，文件只是其中一种数据。

文件传输阶段还需要考虑：
- 文件分片：将大文件拆成小块发送，避免内存和消息大小限制。
- 背压控制：发送速度超过接收速度时暂停，防止缓冲区溢出。
- 完整性校验：通过文件大小、分片序号或哈希确认文件完整。
- 连接状态与异常恢复：处理断线、超时、取消和重传。

这些内容暂不在本篇实现，先把连接本身跑通。

### 1. 什么是信令
两个互不相识的端点（对等端），要先通过一条现有的通信渠道交换建连信息。信令服务器就像这个`介绍人`。
信令服务主要负责两件事：
- 让两个端点配对：知道哪两个页面属于同一次连接。
- 交换建连信息：转发 SDP、ICE Candidate 等信息。
它帮助双方交换“联系方式”，但并不负责建立 WebRTC 连接，也不负责传输 DataChannel 数据。

### 2. SDP
**SDP（Session Description Protocol，会话描述协议）** 是一种文本格式，用来描述端点的通信能力和连接参数。
它主要告诉对方：
- 我要建立什么类型的通信，例如音视频或 DataChannel。
- 我支持哪些协议和参数。
- ICE 连接所需的信息。
- 加密连接需要的身份指纹。

可以把 SDP 理解成双方交换的“通信配置清单”。它不负责寻找对方，也不传输文件，只负责协商双方该如何通信。  

### 3. ICE
**ICE（Interactive Connectivity Establishment）** 是 WebRTC 用来寻找两台设备之间可用连接路径的机制。
由于设备可能位于路由器、NAT 或防火墙后面，双方不一定能直接使用本地地址连接。ICE 会收集多种候选地址：
- Host：设备的本地网络地址。  
- Server Reflexive：通过 STUN 获取的公网映射地址。  
- Relay：由 TURN 服务器提供的中继地址。  
然后 ICE 会按候选优先级测试地址组合，选择一条能够连通的路径。为了便于理解，可以先把它概括为：
```txt
收集 Host、Server Reflexive、Relay 等 Candidate
    ↓
检查候选地址组合
    ↓ 直连成功       ↓ 直连失败
设备之间传输       使用 TURN 中继
```
简单说，SDP 协商“怎么通信”，ICE 负责找到“从哪里走才能连接成功”。

### 4. STUN / TURN
STUN：帮助设备发现自己经过 NAT 后的公网 IP 和端口，供 ICE 尝试点对点直连。STUN 服务器本身不负责转发文件。
TURN：当直连失败、双方无法建立可用路径时，由 TURN 服务器中转数据。
```txt
查询：A → STUN                 获取公网映射
直连：A ←────────→ B            设备之间传输
中继：A ←──────→ TURN ←──────→ B 服务器转发
```
简单理解：
- STUN 是“告诉你公网联系方式”，成本低，但不保证能直连。
- TURN 是“替双方转发数据”，成功率高，但会消耗服务器带宽。

ICE 会优先尝试直连，直连失败时再使用 TURN。本文暂不展开 NAT 穿透的具体算法。

### 5. RTCDataChannel
它是由 WebRTC 建立的双向数据通道，可以传输字符串、二进制数据和文件。本文先通过发送文本确认通道确实可用。

## 一次 DataChannel 连接经历哪些阶段

写代码前，需要先分清三个容易混淆的概念：

| 概念 | 出现阶段 | 作用 |
| --- | --- | --- |
| Offer | 协商开始 | 发起端生成的 SDP，表示“我准备这样通信” |
| Answer | 收到 Offer 后 | 响应端生成的 SDP，表示“我接受并使用这些参数通信” |
| ICE Candidate | 网络选路阶段 | 描述一个可能可用的网络地址和端口 |

Offer 和 Answer 都是 SDP，只是它们在协商中扮演的角色不同。Candidate 不是最终连接，它只是 ICE 可以尝试的一条候选路径。在本文采用的 Trickle ICE 模式中，Candidate 会作为独立消息交换。SDP 和 Candidate 都通过信令服务转发，但它们不会在信令通道中传输文件。

### 阶段 1：信令配对

两个页面先连接 WebSocket 信令服务。信令服务让双方配对，并指定谁是发起端、谁是响应端。此时两个端点还没有建立 WebRTC 连接。

### 阶段 2：发起端创建 Offer

发起端先创建 `RTCPeerConnection` 和 `RTCDataChannel`，再调用：

```ts
const offer = await peer.createOffer()
await peer.setLocalDescription(offer)
```

`createOffer()` 生成一份类型为 `offer` 的 SDP，其中描述了 DataChannel、传输协议、加密信息和 ICE 参数。`setLocalDescription()` 表示将这份描述设为自己的本地配置，并开始收集 ICE Candidate。

Offer 随后通过信令服务发送给响应端。它只是在协商通信方式，还没有建立可用的数据通道。

### 阶段 3：响应端创建 Answer

响应端收到 Offer 后，先把它设为远端描述，再生成 Answer：

```ts
await peer.setRemoteDescription(offer)
const answer = await peer.createAnswer()
await peer.setLocalDescription(answer)
```

Answer 也是 SDP，它表示响应端根据 Offer 得出的协商结果。Answer 通过信令服务返回后，发起端调用 `setRemoteDescription(answer)`。到这里，双方已经知道该用什么参数通信，但还需要找到真正可用的网络路径。

### 阶段 4：交换 ICE Candidate

设置本地描述后，浏览器会不断发现可尝试的网络路径，并触发 `icecandidate` 事件：

```ts
peer.onicecandidate = ({ candidate }) => {
  if (candidate) signal(candidate.toJSON())
}
```

一个端点通常会产生多个 Candidate，例如本地地址、STUN 得到的公网映射地址，以及 TURN 提供的中继地址。对方收到后调用：

```ts
await peer.addIceCandidate(candidate)
```

Candidate 的交换可能和 SDP 协商同时发生，甚至可能先于远端 SDP 到达。后面的示例使用 `pendingCandidates` 暂存这些过早到达的 Candidate，等 `setRemoteDescription()` 完成后再添加。

### 阶段 5：ICE 选路并打开 DataChannel

双方拥有 SDP 和 Candidate 后，ICE 会测试不同的候选地址组合，选择一条能够连通的路径。随后 WebRTC 完成加密连接和 DataChannel 建立。

当 `open` 事件触发时，才表示通道真正可以发送数据：

```ts
channel.onopen = () => {
  channel.send('hello')
}
```

为了突出可能交错的部分，完整过程可以概括为：

```txt
信令配对
  → 发起端创建并发送 Offer ──────┐
  → 响应端返回 Answer ────────────┤ 通过信令服务转发
  → 双方交错发送 ICE Candidate ───┘
  → ICE 测试候选地址组合并选择路径
  → DataChannel open
  → 直连或 TURN 中继传输数据
```

## 基本功能简单实现

先只实现最小闭环：两个页面通过信令服务交换 SDP 和 ICE Candidate，建立 DataChannel 后互发文本。这个版本不处理房间、文件分片、TURN 和断线重连，只用于理解连接过程。

### 准备工作

示例需要 Node.js、一个可以运行 TypeScript 的前端开发服务器，以及 `ws` 和 `tsx` 依赖。下面以 Vite 的 vanilla TypeScript 模板为例，信令服务保存为 `signaling.ts`，浏览器代码保存为 `src/main.ts`。

先创建一个独立的示例项目并安装依赖：

```bash
npm create vite@latest vela-demo -- --template vanilla-ts
cd vela-demo
npm install
npm install ws
npm install -D tsx @types/ws
```

在一个终端启动信令服务，再启动前端开发服务器：

```bash
npx tsx signaling.ts
npm run dev -- --host 0.0.0.0
```

然后在浏览器打开前端地址两次。使用同一台设备的两个页面可以先验证建连流程；要测试不同设备，需要让它们都能访问前端地址和 `3303` 端口。示例使用 `ws://`，适合本地开发；部署到 HTTPS 页面时应改用 `wss://`。

验证成功时，两个页面都会显示 `DataChannel 已连接`，并在日志中收到对方发送的 `hello from 发起端` 或 `hello from 响应端`。

### 信令服务

信令服务最多接收两个客户端。第二个端点加入后，它会指定发起端，并把 `signal` 消息转发给另一个端点，不参与 DataChannel 中的数据传输。

```ts
import { WebSocket, WebSocketServer } from 'ws'

const peers = new Set<WebSocket>()
const server = new WebSocketServer({ port: 3303, maxPayload: 64 * 1024 })
const send = (peer: WebSocket, message: object) => peer.send(JSON.stringify(message))

server.on('connection', (socket) => {
  if (peers.size === 2) return socket.close(1013, 'Only two peers are supported')
  peers.add(socket)

  if (peers.size === 2) {
    let initiator = true
    peers.forEach((peer) => {
      send(peer, { type: 'ready', initiator })
      initiator = false
    })
  }

  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString())
      if (message.type === 'signal') {
        peers.forEach((peer) => peer !== socket && send(peer, message))
      }
    } catch {
      socket.close(1003, 'Invalid message')
    }
  })

  socket.on('close', () => {
    peers.delete(socket)
    peers.forEach((peer) => send(peer, { type: 'reset' }))
  })
})

console.log('Signaling: ws://localhost:3303')
```

### 前端页面

页面只保留连接状态和日志，不需要 CSS。打开两个页面后会自动开始连接。

```html
<h1>WebRTC DataChannel</h1>
<p id="status">连接信令服务...</p>
<pre id="log"></pre>
<script type="module" src="/src/main.ts"></script>
```

### 建立 DataChannel

```ts
type Signal = RTCSessionDescriptionInit | RTCIceCandidateInit
type Message = {
  type: 'ready' | 'signal' | 'reset'
  initiator?: boolean
  data?: Signal
}

const status = document.querySelector<HTMLParagraphElement>('#status')!
const log = document.querySelector<HTMLPreElement>('#log')!
const socket = new WebSocket(`ws://${location.hostname}:3303`)

let peer: RTCPeerConnection | undefined
let channel: RTCDataChannel | undefined
let role = ''
let pendingCandidates: RTCIceCandidateInit[] = []

const sendSignal = (data: Signal) => socket.send(JSON.stringify({ type: 'signal', data }))

function useChannel(nextChannel: RTCDataChannel) {
  channel = nextChannel
  channel.onopen = () => {
    status.textContent = 'DataChannel 已连接'
    channel?.send(`hello from ${role}`)
  }
  channel.onmessage = ({ data }) => (log.textContent += `收到: ${data}\n`)
  channel.onclose = () => (status.textContent = 'DataChannel 已关闭')
}

function createPeer() {
  if (peer) return peer

  peer = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })

  // 这是自己的 Local Candidate；发送给对方后，会成为对方的 Remote Candidate。
  peer.onicecandidate = ({ candidate }) => candidate && sendSignal(candidate.toJSON())
  peer.ondatachannel = ({ channel }) => useChannel(channel)
  return peer
}

async function createOffer() {
  role = '发起端'
  const connection = createPeer()
  useChannel(connection.createDataChannel('channel'))
  await connection.setLocalDescription(await connection.createOffer())
  sendSignal(connection.localDescription!)
}

async function handleSignal(data: Signal) {
  const connection = createPeer()

  if ('type' in data) {
    await connection.setRemoteDescription(data)
    for (const candidate of pendingCandidates) await connection.addIceCandidate(candidate)
    pendingCandidates = []

    if (data.type === 'offer') {
      role = '响应端'
      await connection.setLocalDescription(await connection.createAnswer())
      sendSignal(connection.localDescription!)
    }
  } else if (connection.remoteDescription) {
    await connection.addIceCandidate(data)
  } else {
    pendingCandidates.push(data)
  }
}

function reset() {
  channel?.close()
  peer?.close()
  channel = peer = undefined
  pendingCandidates = []
  status.textContent = '等待另一个页面...'
}

socket.onopen = () => (status.textContent = '等待另一个页面...')
socket.onmessage = async ({ data }) => {
  const message = JSON.parse(data) as Message
  if (message.type === 'ready') {
    role = message.initiator ? '发起端' : '响应端'
    if (message.initiator) await createOffer()
  } else if (message.type === 'signal' && message.data) {
    await handleSignal(message.data)
  } else if (message.type === 'reset') {
    reset()
  }
}
socket.onerror = () => (status.textContent = '信令连接失败')
socket.onclose = () => (status.textContent = '信令连接已关闭')
```

建连顺序如下：

1. 两个页面分别连接 WebSocket 信令服务。
2. 发起端创建 DataChannel 和 SDP Offer。
3. 响应端接收 Offer，创建 SDP Answer。
4. 双方通过信令服务交错交换 ICE Candidate。
5. DataChannel 的 `open` 事件触发后，数据开始在两个端点之间传输。

## 下一步

现在的最小闭环只证明连接可以建立，传输的还是一段文本。下一篇会在这个 DataChannel 上加入文件元数据、分片、背压控制和完整性校验，逐步把它变成真正可用的文件传输工具。

## 参考资料

- [MDN：WebRTC Connectivity](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity)
- [MDN：RTCPeerConnection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)
- [MDN：RTCDataChannel](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel)
