# Design Document — ModBus Slave Simulator
# 设计文档 — ModBus 从站模拟器

## Overview / 概述

ModBus Slave is a web-based ModBus slave (server) simulator. It simulates one or more ModBus slave devices, responding to read/write requests from ModBus masters via TCP or serial (RTU/ASCII). The web UI provides real-time register inspection, manual value editing, and comprehensive request logging.

ModBus Slave 是一个基于 Web 的 ModBus 从站（服务器）模拟器。它模拟一个或多个 ModBus 从站设备，通过 TCP 或串口（RTU/ASCII）响应来自 ModBus 主站的读写请求。Web UI 提供实时寄存器查看、手动值编辑和全面的请求日志。

This project is the **slave counterpart** to `modbus-master`, sharing the same tech stack, component library, and visual design language for a cohesive user experience.

本项目是 `modbus-master` 的**从站配套应用**，共享相同的技术栈、组件库和视觉设计语言，提供一致的用户体验。

## Architecture / 架构

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (Client)                      │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  SlavePanel │  │RegisterViewer│  │   LogViewer   │  │
│  └──────┬──────┘  └──────┬───────┘  └──────┬────────┘  │
│         │                │                  │           │
│         └────────────────┼──────────────────┘           │
│                          │                              │
│              ┌───────────┴────────────┐                 │
│              │  useAppState (React)   │                 │
│              │  useModbusWs           │                 │
│              └───────────┬────────────┘                 │
│                          │ WebSocket                    │
└──────────────────────────┼──────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────┐
│                    Node.js Server                        │
│                          │                              │
│              ┌───────────┴────────────┐                 │
│              │  ws-handlers/slave.ts  │                 │
│              │  (message routing)     │                 │
│              └───────────┬────────────┘                 │
│                          │                              │
│              ┌───────────┴────────────┐                 │
│              │ ModbusSlaveServer      │                 │
│              │ (register memory +     │                 │
│              │  request dispatching)  │                 │
│              └───────────┬────────────┘                 │
│                          │                              │
│              ┌───────────┴────────────┐                 │
│              │   net.Server (TCP)     │                 │
│              │   (ModBus TCP listener)│                 │
│              └────────────────────────┘                 │
│                                                          │
│   [SerialPort — future integration via SerialPort lib]   │
└─────────────────────────────────────────────────────────┘
```

### Key design principles / 关键设计原则

1. **Multi-slave by default** — Users can create and manage multiple slave devices, each with its own address, memory space, and transport (TCP port / serial).
2. **Shared register memory model** — All four register areas are stored as typed arrays for fast, direct access.
3. **WebSocket for realtime** — Slave state changes (new requests, register writes) are pushed to all connected clients immediately.
4. **Stateless UI, stateful server** — The UI is a thin view layer; the server holds ground truth about slave state and register values.
5. **Consistency with modbus-master** — Same folder structure, same component library, same design system, same i18n pattern, same state management approach.

1. **默认多从站** — 用户可创建和管理多个从站设备，每个有自己的地址、内存空间和传输方式（TCP 端口 / 串口）。
2. **共享寄存器内存模型** — 四大寄存器区都存储为类型化数组，实现快速直接访问。
3. **WebSocket 实时通信** — 从站状态变化（新请求、寄存器写入）立即推送到所有连接的客户端。
4. **UI 无状态，服务端有状态** — UI 是薄视图层；服务端持有从站状态和寄存器值的真实数据。
5. **与 modbus-master 一致** — 相同的文件夹结构、相同的组件库、相同的设计系统、相同的 i18n 模式、相同的状态管理方式。

## Protocol Support / 协议支持

| Feature / 功能 | Supported / 支持 | Notes / 备注 |
|---|---|---|
| ModBus TCP (MBAP) | ✅ | 主传输方式；单端口 + Unit ID 路由 |
| Serial RTU | ✅ | 依赖 `serialport`（已列入 `dependencies`）；需要真实串口设备 |
| Serial ASCII | ✅ | 同上 |
| ModBus RTU / ASCII **over TCP** | ❌ | 未实现：TCP 连接恒按 MBAP 解析 |
| FC01 Read Coils | ✅ |  |
| FC02 Read Discrete Inputs | ✅ |  |
| FC03 Read Holding Registers | ✅ |  |
| FC04 Read Input Registers | ✅ |  |
| FC05 Write Single Coil | ✅ |  |
| FC06 Write Single Register | ✅ |  |
| FC15 Write Multiple Coils | ✅ |  |
| FC16 Write Multiple Registers | ✅ |  |
| Broadcast (Unit 0) | ✅ | 仅写操作；作用于该端点全部从站，不回响应 |

## Register Memory Model / 寄存器内存模型

Each slave device maintains four independent register areas. Sizes are configurable per slave and fixed at start time.

每个从站设备维护四个独立的寄存器区。每个从站的大小可配置，且在启动时固定。

| Area / 区域 | Type / 类型 | Default Size / 默认大小 | Access / 访问 |
|---|---|---|---|
| Coils (FC01/05/15) | Bit | 100 | Read/Write |
| Discrete Inputs (FC02) | Bit | 100 | Read Only |
| Holding Registers (FC03/06/16) | 16-bit word | 100 | Read/Write |
| Input Registers (FC04) | 16-bit word | 100 | Read Only |

Register memory is stored as typed arrays (`Uint16Array` for registers, `Uint8Array` for bits) — **1 byte per bit, not bit-packed**. Protocol limits (`MODBUS_MAX`) are independent of per-slave capacity.

寄存器内存用类型化数组存储（寄存器 `Uint16Array`，位区 `Uint8Array`）——**每个位占 1 字节，并非按位打包**。协议上限（`MODBUS_MAX`）与从站容量彼此独立。

### Slave Address / 从站地址

- Supports slave addresses 1–247 (standard ModBus range)
- Broadcast address 0 supported for FC05/06/15/16 write operations
- Each slave has a configurable unit ID

- 支持从站地址 1–247（标准 ModBus 范围）
- 广播地址 0 支持 FC05/06/15/16 写操作
- 每个从站有可配置的单元 ID

### TCP Addressing / TCP 寻址

- 一个 `host:port` **只监听一次**（`tcpEndpoints`），请求按 MBAP 中的 Unit ID 路由到对应从站
- 同一端口可并存多个不同 Unit ID 的从站；同端口同 Unit ID 启动会被明确拒绝
- Unit 0 广播作用于该端点上的全部从站，且不回响应
- 仅当该端点再无任何从站时才释放监听器（同时销毁残留连接）
- 畸形 MBAP（`protocolId != 0`、`length` 越界）会关闭连接；PDU 长度不足回异常码 `0x03`

## WebSocket API / WebSocket API

Endpoint: `/ws/slave`。统一信封 `{ type, payload }`；应用层心跳 `ping` → `pong`。
（与代码同步的完整契约表见工作空间 [`AGENTS.md`](../AGENTS.md:200) 第 7 节。）

```
// Client → Server
{ type: 'start_slave',    payload: { slaveId, config } }
{ type: 'stop_slave',     payload: { slaveId } }
{ type: 'restart_slave',  payload: { slaveId, config } }   // 先停后起，服务端串行执行
{ type: 'read_registers', payload: { tabId, slaveId, area, startAddress, quantity } }
{ type: 'write_register', payload: { slaveId, area, address, value } }
{ type: 'write_registers',payload: { slaveId, area, startAddress, values } }
{ type: 'ping' }

// Server → Client
{ type: 'slave_snapshot',     payload: { running: [{ slaveId, config }] } }  // 连接建立时回放
{ type: 'slave_started',      payload: { slaveId, config } }                 // config 为服务端实际生效配置
{ type: 'slave_stopped',      payload: { slaveId } }
{ type: 'slave_error',        payload: { slaveId, message } }
{ type: 'log_entry',          payload: LogEntry }
{ type: 'read_response',      payload: { tabId, data } }
{ type: 'write_response',     payload: { success, error? } }
{ type: 'register_update',    payload: { slaveId, changes: [{ area, address, value }] } }
{ type: 'error',              payload: { message } }
{ type: 'pong' }
```

> ⚠️ 命名陷阱：WS 载荷中的 `slaveId` 是**应用内部 id（string）**，而 `SlaveConfig.slaveId` 是 **ModBus 单元号（1–247）**。
>
> ⚠️ `slaveId` in the WS payload is the **internal app id (string)**, while `SlaveConfig.slaveId` is the **ModBus unit id (1–247)**.

`register_update` 只包含**实际发生变更**的地址（写入相同值不产生事件），并且一次 PDU 的多个变更合并为一条消息。

## Data Display Formats / 数据显示格式

| Format / 格式 | Description / 说明 | Size / 大小 |
|---|---|---|
| `hex` | Hexadecimal / 十六进制 | 16-bit |
| `ushort` | Unsigned 16-bit integer / 无符号 16 位整数 | 16-bit |
| `short` | Signed 16-bit integer / 有符号 16 位整数 | 16-bit |
| `binary` | Binary / 二进制 | 16-bit |
| `ulong` | Unsigned 32-bit integer / 无符号 32 位整数 | 32-bit (2 registers) |
| `long` | Signed 32-bit integer / 有符号 32 位整数 | 32-bit (2 registers) |
| `float` | IEEE 754 single-precision / 单精度浮点 | 32-bit (2 registers) |
| `double` | IEEE 754 double-precision / 双精度浮点 | 64-bit (4 registers) |
| `led` | LED indicator (0/1) / LED 指示 | 1-bit |

### Byte Order / 字节序

- **32-bit**: ABCD (Big-Endian), DCBA (Little-Endian), BADC (Mid-Big), CDAB (Mid-Little)
- **64-bit**: ABCDEFGH, HGFEDCBA, BADCFEHG, GHEFCDAB

## State Management / 状态管理

- **Client side**: React Context + useReducer pattern (`useAppState`)
  - Slave configurations, view tabs, register data cache, logs
  - Persisted to localStorage (configs + view tabs); runtime state is never persisted
  - `runningConfigs` holds the **server-authoritative config** of running slaves, used to show "restart required"
- **Server side**: in-memory `runningSlaves` (per slave) + `tcpEndpoints` (per `host:port` listener)
  - **Server is the single source of truth for running state**; on connect it pushes `slave_snapshot`
  - Register writes are broadcast to all WebSocket clients as precise deltas
  - Config fields fixed at listen time (port / unit id / capacities) require `restart_slave` to take effect

- **客户端**: React Context + useReducer 模式 (`useAppState`)
  - 从站配置、查看标签、寄存器数据缓存、日志
  - 持久化到 localStorage（配置 + 查看标签）；运行时状态一概不持久化
  - `runningConfigs` 保存运行中从站的**服务端权威配置**，用于提示"需重启生效"
- **服务端**: 内存中的 `runningSlaves`（按从站）+ `tcpEndpoints`（按 `host:port` 的监听端点）
  - **服务端是运行状态的唯一事实源**：连接建立即下发 `slave_snapshot`
  - 寄存器写入以精确增量广播给全部 WebSocket 客户端
  - 监听期固定的配置字段（端口 / 单元号 / 容量）必须通过 `restart_slave` 才能生效

## Roadmap / 路线图

- [x] Serial port support (RTU / ASCII via `serialport`, already a dependency)
- [x] Multi-slave on a single TCP port via Unit ID routing
- [x] Real-time register deltas pushed to the UI (`register_update`)
- [x] Run-time config changes via `restart_slave`
- [ ] ModBus RTU / ASCII **over TCP** (currently TCP is always MBAP)
- [ ] ModBus UDP support
- [ ] Register value simulation (ramp, sine wave, random)
- [ ] Slave response delay simulation (for testing timeouts)
- [ ] Error injection (CRC errors, exception responses)
- [ ] Import/export register memory snapshots
- [ ] Automated tests for the protocol layer

- [x] 串口支持（通过 `serialport` 的 RTU / ASCII，依赖已就位）
- [x] 单 TCP 端口多从站（Unit ID 路由）
- [x] 寄存器实时增量推送（`register_update`）
- [x] 运行中改配置（`restart_slave`）
- [ ] ModBus RTU / ASCII **over TCP**（当前 TCP 恒为 MBAP）
- [ ] ModBus UDP 支持
- [ ] 寄存器值模拟（斜坡、正弦波、随机）
- [ ] 从站响应延迟模拟（用于测试超时）
- [ ] 错误注入（CRC 错误、异常响应）
- [ ] 导入/导出寄存器内存快照
- [ ] 协议层自动化测试
