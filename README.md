# ModBus Slave Simulator / ModBus 从站模拟器

A modern web-based ModBus slave (server) simulator with a professional industrial dark theme. Simulate multiple ModBus TCP / serial (RTU/ASCII) slave devices, inspect and edit register data, and monitor all master requests in real time.

现代 Web 版 ModBus 从站（服务器）模拟器，专业工业暗色主题。可同时模拟多个 ModBus TCP / 串口（RTU/ASCII）从站设备，实时查看和编辑寄存器数据，并监控所有主站请求。

## Features / 功能特性

- **Multi-slave support** — Run multiple slave devices simultaneously, each with independent register memory
- **ModBus TCP** — Listen on configurable port and IP; one port serves many unit IDs (standard gateway addressing)
- **Serial port support** — RTU / ASCII over serial (COM port), provided by the `serialport` dependency
- **Restart-safe config changes** — Editing a running slave shows "restart required" and applies via `restart_slave`
- **Four register areas** — Coils, Discrete Inputs, Holding Registers, Input Registers
- **Real-time data view** — Multi-tab register viewer with hex/decimal/binary/long/float/double formats
- **Live request logging** — All master read/write requests logged with timestamps and raw data
- **Real-time register deltas** — Master/UI writes are pushed to the viewer as precise per-address updates
- **Editable registers** — Manually modify coil and holding register values from the UI
- **Byte order configuration** — Configurable 32-bit (ABCD/DCBA/BADC/CDAB) and 64-bit byte order
- **i18n** — Bilingual (English / 中文) interface
- **Local storage** — All slave configurations and view tabs persisted locally
- **WebSocket real-time** — Live state sync between server and UI

- **多从站支持** — 同时运行多个从站设备，各自拥有独立的寄存器内存
- **ModBus TCP** — 可配置的监听端口和 IP
- **串口支持** — RTU / ASCII 串口（COM 口）— 后续集成
- **四大寄存器区** — 线圈、离散输入、保持寄存器、输入寄存器
- **实时数据查看** — 多标签页寄存器查看器，支持十六进制/十进制/二进制/长整型/浮点/双精度格式
- **实时请求日志** — 所有主站读写请求都带时间戳和原始数据记录
- **可编辑寄存器** — 从 UI 手动修改线圈和保持寄存器的值
- **字节序配置** — 可配置 32 位（ABCD/DCBA/BADC/CDAB）和 64 位字节序
- **国际化** — 双语（英文 / 中文）界面
- **本地存储** — 所有从站配置和查看标签本地持久化
- **WebSocket 实时同步** — 服务端与 UI 间实时状态同步

## Tech Stack / 技术栈

- Next.js 16 (App Router)
- React 19
- TypeScript 5
- Tailwind CSS v4
- shadcn/ui (new-york variant)
- WebSocket (ws library) — realtime communication
- Node.js native `net` module — ModBus TCP server
- LocalStorage — client-side persistence

## Getting Started / 快速开始

```bash
# Install dependencies / 安装依赖
pnpm install

# Development / 开发模式，端口 5001，自定义服务器已挂载 /ws/slave
pnpm run dev
# Open http://localhost:5001

# Build / 构建
pnpm run build

# Production / 生产模式，同样运行自定义服务器以保证 WebSocket 可用
pnpm run start
# 端口由 DEPLOY_RUN_PORT 决定，缺省 5001
```

> 生产模式 **必须** 通过 `scripts/start.sh` 运行 `src/server.ts`（内部使用 `tsx`）。
> 直接使用 `next start` 只会启动 Next 内置服务器，`/ws/slave` 端点不会注册。

## Project Structure / 项目结构

```
modbus-slave/
├── src/
│   ├── app/              # Next.js App Router (pages, layout, globals.css)
│   ├── components/       # React components
│   │   └── ui/           # shadcn/ui base components
│   ├── hooks/            # React hooks (use-app-state, use-i18n, use-modbus-ws)
│   ├── lib/              # Core logic (modbus-slave-server, types, utils, i18n)
│   ├── ws-handlers/      # WebSocket message handlers
│   └── server.ts         # Custom Next.js server with WebSocket upgrade
├── scripts/              # Dev/build/start shell scripts
├── public/               # Static assets
├── package.json
├── tsconfig.json
└── tailwind.config.ts
```

## Architecture / 架构设计

See [DESIGN.md](./DESIGN.md) for detailed architecture, protocol support, and register memory model.

详细架构、协议支持和寄存器内存模型请见 [DESIGN.md](./DESIGN.md)。

## Companion Project / 配套项目

This is the slave counterpart to [modbus-master](https://github.com/thouen/modbus-master) — a ModBus master (client) web application built with the same tech stack and design language. Use both together for complete ModBus testing and simulation.

本项目是 [modbus-master](https://github.com/thouen/modbus-master) 的从站配套应用。两者使用相同的技术栈和设计语言，搭配使用可完成完整的 ModBus 测试与仿真。

## License / 许可证

MIT
