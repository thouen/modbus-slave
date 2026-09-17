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
| ModBus TCP | ✅ | Primary transport / 主要传输方式 |
| ModBus RTU over TCP | ✅ | Emulation / 模拟支持 |
| ModBus ASCII over TCP | ✅ | Emulation / 模拟支持 |
| Serial RTU | ⏳ | Planned / 计划中 |
| Serial ASCII | ⏳ | Planned / 计划中 |
| FC01 Read Coils | ✅ |  |
| FC02 Read Discrete Inputs | ✅ |  |
| FC03 Read Holding Registers | ✅ |  |
| FC04 Read Input Registers | ✅ |  |
| FC05 Write Single Coil | ✅ |  |
| FC06 Write Single Register | ✅ |  |
| FC15 Write Multiple Coils | ✅ |  |
| FC16 Write Multiple Registers | ✅ |  |

## Register Memory Model / 寄存器内存模型

Each slave device maintains four independent register areas. Sizes are configurable per slave.

每个从站设备维护四个独立的寄存器区。每个从站的大小可配置。

| Area / 区域 | Type / 类型 | Default Size / 默认大小 | Access / 访问 |
|---|---|---|---|
| Coils (FC01/05/15) | Bit (boolean) | 2000 bits | Read/Write |
| Discrete Inputs (FC02) | Bit (boolean) | 2000 bits | Read Only |
| Holding Registers (FC03/06/16) | 16-bit word | 2000 registers | Read/Write |
| Input Registers (FC04) | 16-bit word | 2000 registers | Read Only |

Register memory is stored as typed arrays (`Uint16Array` for registers, `Uint8Array` bit-packed for coils/inputs) for maximum performance and memory efficiency.

寄存器内存存储为类型化数组（寄存器用 `Uint16Array`，线圈/输入用 `Uint8Array` 按位打包），以实现最高性能和内存效率。

### Slave Address / 从站地址

- Supports slave addresses 1–247 (standard ModBus range)
- Broadcast address 0 supported for FC05/06/15/16 write operations
- Each slave has a configurable unit ID

- 支持从站地址 1–247（标准 ModBus 范围）
- 广播地址 0 支持 FC05/06/15/16 写操作
- 每个从站有可配置的单元 ID

## WebSocket API / WebSocket API

### Message format / 消息格式

```typescript
// Client → Server
{ action: 'listSlaves' }
{ action: 'addSlave', config: SlaveConfig }
{ action: 'updateSlave', id, config }
{ action: 'deleteSlave', id }
{ action: 'startSlave', id }
{ action: 'stopSlave', id }
{ action: 'readRegisters', tabId, slaveId, area, startAddress, quantity }
{ action: 'writeRegister', slaveId, area, address, value }
{ action: 'getSlaveStatus', id }

// Server → Client
{ event: 'slaveList', slaves: SlaveConfig[] }
{ event: 'slaveStarted', id, config }
{ event: 'slaveStopped', id }
{ event: 'slaveError', id, message }
{ event: 'registerData', tabId, data: RegisterData[] }
{ event: 'logEntry', slaveId, entry: LogEntry }
{ event: 'slaveStatus', id, status: 'running'|'stopped'|'error' }
```

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
  - Persisted to localStorage (configs + view tabs)
- **Server side**: In-memory map of running slave instances
  - Each `ModbusSlaveServer` instance owns its register memory and TCP listener
  - Register writes broadcast to all connected WebSocket clients

- **客户端**: React Context + useReducer 模式 (`useAppState`)
  - 从站配置、查看标签、寄存器数据缓存、日志
  - 持久化到 localStorage（配置 + 查看标签）
- **服务端**: 运行中从站实例的内存映射
  - 每个 `ModbusSlaveServer` 实例拥有自己的寄存器内存和 TCP 监听器
  - 寄存器写入广播到所有连接的 WebSocket 客户端

## Roadmap / 路线图

- [ ] Serial port support (RTU / ASCII via SerialPort library)
- [ ] ModBus UDP support
- [ ] Register value simulation (ramp, sine wave, random)
- [ ] Slave response delay simulation (for testing timeouts)
- [ ] Error injection (CRC errors, exception responses)
- [ ] Import/export register memory snapshots
- [ ] Project save/load (multi-slave configuration files)

- [ ] 串口支持（通过 SerialPort 库的 RTU / ASCII）
- [ ] ModBus UDP 支持
- [ ] 寄存器值模拟（斜坡、正弦波、随机）
- [ ] 从站响应延迟模拟（用于测试超时）
- [ ] 错误注入（CRC 错误、异常响应）
- [ ] 导入/导出寄存器内存快照
- [ ] 项目保存/加载（多从站配置文件）
