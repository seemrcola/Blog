---
title: "Vela"
description: "实现一个基于 Web 的文件传输工具"
date: 2026-07-27
tags: [技术, 思考]
status: in-progress
---

## 前言
简单来说，我想做一个基于 Web 的文件传输工具，这样可以方便的在不同的设备之间传输文件，又可以不依赖第三方的app。

## 方案选择
跨平台文件传输，首选就是WebRTC技术。这个技术我也不甚了解。接下来我们就一起学习一下。

## 为什么选择WebRTC
首先就是WebRTC的优势：
- 跨平台：浏览器、移动端、桌面端均可支持。
- 点对点直传：减少服务器中转和带宽成本。
- 低延迟、高吞吐：设备间直接建立数据通道。
- 默认加密：保障文件传输安全。
- 支持 NAT 穿透：适应多数网络环境。

## 完成这个功能所需要了解的基础概念
专业名词：
- 信令（Signaling）：双方交换建立连接所需的信息，通常用 WebSocket 实现。
- SDP：描述双方支持的连接方式和通信能力。
- ICE：收集并尝试可用的网络连接路径。
- STUN / TURN：STUN 用于发现公网地址；TURN 在无法直连时负责中继。
- RTCDataChannel：WebRTC 中实际传输文件数据的通道。
技术方案：
- 文件分片：将大文件拆成小块发送，避免内存和消息大小限制。
- 背压控制：发送速度超过接收速度时暂停，防止缓冲区溢出。
- 完整性校验：通过文件大小、分片序号或哈希确认文件完整。
- 连接状态与异常恢复：处理断线、超时、取消和重传。

### 1. 什么是信令
两个互不相识的端点（对等端），为了能够找到对方，需要一个“介绍人”，信令服务器就是这个“介绍人”。  
信令服务主要负责两件事：
- 让两个端点配对：让他们彼此能够找到对方。
- 交换建连信息：转发 SDP、ICE Candidate 等信息。
它帮助双方交`换联系方式`，但并不负责`连接`，也不负责`传输数据`。

### 2. SDP
**SDP（Session Description Protocol，会话描述协议）**是一种文本格式，用来描述端点的通信能力和连接参数。
它主要告诉对方：
- 我要建立什么类型的通信，例如音视频或 DataChannel。
- 我支持哪些协议和参数。
- ICE 连接所需的信息。
- 加密连接需要的身份指纹。

可以把 SDP 理解成双方交换的“通信配置清单”。它不负责寻找对方，也不传输文件，只负责协商双方该如何通信。  

### 3. ICE
**ICE（Interactive Connectivity Establishment）**是 WebRTC 用来寻找两台设备之间可用连接路径的机制。
由于设备通常位于路由器、NAT 或防火墙后面，不能直接使用局域网地址连接。ICE 会收集多种候选地址：  
- Host：设备的本地网络地址。  
- Server Reflexive：通过 STUN 获取的公网映射地址。  
- Relay：由 TURN 服务器提供的中继地址。  
然后 ICE 会测试这些候选路径，选择最合适的一条：  
```txt
优先尝试直接连接
    ↓ 失败
尝试公网映射地址
    ↓ 失败
使用 TURN 服务器中继
```
简单说，SDP 协商“怎么通信”，ICE 负责找到“从哪里走才能连接成功”。  

### 4. STUN / TURN
STUN：帮助设备发现自己经过 NAT 后的公网 IP 和端口，用于尝试点对点直连，也就是常说的 NAT 打洞  
TURN：当打洞失败、双方无法直连时，由 TURN 服务器中转数据。  
```txt
STUN：A ←────────→ B       直接传输
TURN：A ←→ TURN ←→ B       服务器中转
```
简单理解：
- STUN 是“告诉你公网联系方式”，成本低，但不保证能直连。
- TURN 是“替双方转发数据”，成功率高，但会消耗服务器带宽。

ICE 会优先尝试直连，失败后再使用 TURN。  
> 关于NAT穿透，后面我们会做补充资料

### 5. RTCDataChannel
它是由 WebRTC 建立的双向数据通道，用于传输文件。当我们一切就绪，就可以通过这个通道发送文件了。

## 一次 DataChannel 连接经历哪些阶段

写代码前，需要先分清三个容易混淆的概念：

| 概念 | 出现阶段 | 作用 |
| --- | --- | --- |
| Offer | 协商开始 | 发起端生成的 SDP，表示“我准备这样通信” |
| Answer | 收到 Offer 后 | 响应端生成的 SDP，表示“我接受并使用这些参数通信” |
| ICE Candidate | 网络选路阶段 | 描述一个可能可用的网络地址和端口 |

Offer 和 Answer 都是 SDP，只是它们在协商中扮演的角色不同。Candidate 不是最终连接，它只是 ICE 可以尝试的一条候选路径。在这个示例使用的 Trickle ICE 模式中，Candidate 会作为独立消息交换。这些信息都通过信令服务转发，不会直接传输文件。

### 阶段 1：信令配对

两个页面先连接 WebSocket 信令服务。信令服务让双方配对，并指定谁是发起端、谁是响应端。此时两个端点还没有建立 WebRTC 连接。

### 阶段 2：发起端创建 Offer

发起端先创建 `RTCPeerConnection` 和 `RTCDataChannel`，再调用：

```ts
const offer = await peer.createOffer()
await peer.setLocalDescription(offer)
```

`createOffer()` 生成一份类型为 `offer` 的 SDP，其中描述了 DataChannel、传输协议、加密信息和 ICE 参数。`setLocalDescription()` 表示将这份描述设为自己的本地配置，并开始收集 ICE Candidate。

Offer 随后通过信令服务发送给响应端。它只是在协商通信方式，还没有建立点对点通道。

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

Candidate 的交换可能和 SDP 协商同时发生。因此 Candidate 可能先于远端 SDP 到达，后面的示例使用 `pendingCandidates` 暂存这些过早到达的 Candidate，等 `setRemoteDescription()` 完成后再添加。

### 阶段 5：ICE 选路并打开 DataChannel

双方拥有 SDP 和 Candidate 后，ICE 会测试不同的候选地址组合，选择一条能够连通的路径。随后 WebRTC 完成加密连接和 DataChannel 建立。

当 `open` 事件触发时，才表示通道真正可以发送数据：

```ts
channel.onopen = () => {
  channel.send('hello')
}
```

完整顺序可以概括为：

```txt
信令配对
  → 发起端发送 Offer
  → 响应端返回 Answer
  → 双方交换 ICE Candidate
  → ICE 测试并选择路径
  → DataChannel open
  → 点对点传输数据
```

## 基本功能简单实现

先只实现最小闭环：两个页面通过信令服务交换 SDP 和 ICE Candidate，建立 DataChannel 后互发文本。这个版本不处理房间、文件分片、TURN 和断线重连，只用于理解连接过程。

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

  // 这是自己的 Local Candidate，发送给对方后会成为它的 Remote Candidate。
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
4. 双方通过信令服务交换 ICE Candidate。
5. DataChannel 的 `open` 事件触发后，数据开始在两个端点之间传输。
