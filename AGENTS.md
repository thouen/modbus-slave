# Agents & Roles / 智能体与角色分工

This project uses a single Agent (`编程专家`) responsible for full-stack development. Development follows these internal rules:

本项目由单个 Agent（`编程专家`）负责全栈开发。开发遵循以下内部规则：

## Agent Rules / 智能体规则

1. **Consistency with modbus-master** — This slave project is the counterpart to `modbus-master`. All architectural, component, and style decisions should align with that project.
2. **Small, incremental steps** — Build feature by feature. Verify each step compiles before moving on.
3. **Read existing code first** — Before adding features, read related existing files to match patterns.
4. **Type safety first** — All TypeScript, strict mode, no `any` unless absolutely necessary.
5. **Tailwind v4 patterns** — Use CSS variables via `@theme`, not tailwind.config.js customizations.
6. **No heavy dependencies** — Prefer lightweight libraries or custom implementations.
7. **Industrial aesthetic** — Dark theme, small typography, monospace data, minimal decoration.

1. **与 modbus-master 保持一致** — 这个从站项目是 `modbus-master` 的配套应用。所有架构、组件和样式决策都应与该项目对齐。
2. **小步增量** — 逐个功能构建。每步都验证编译通过后再继续。
3. **先读已有代码** — 添加功能前，先阅读相关现有文件以匹配模式。
4. **类型安全优先** — 全 TypeScript，严格模式，非必要不用 `any`。
5. **Tailwind v4 模式** — 通过 `@theme` 使用 CSS 变量，不用 tailwind.config.js 自定义。
6. **不加重依赖** — 优先使用轻量库或自定义实现。
7. **工业美学** — 暗色主题，小字号，等宽数据，最少装饰。

## File Map / 文件地图

### Core Logic (src/lib/)
- `modbus-types.ts` — All shared TypeScript types (SlaveConfig, RegisterArea, etc.)
- `modbus-utils.ts` — Formatting, CRC/LRC calculation, byte order utilities
  - ⚠️ `formatRegisterValue(registers: RegisterData[], startIndex, format, order32, order64)` 的签名与输出语义**必须与 modbus-master 同步**（hex 不带 `0x`、`bits` 为 16 位串、float 6 位 / double 10 位小数）
  - 逐行类型映射：`getBitsPerValue` / `getSpanForFormat` / `formatFitsAt` / `resolveRegisterLayout`（32 位占 2 个寄存器、64 位占 4 个；位区域恒为 1）
  - 输入解析与编码：`parseDisplayValue` / `encodeValueToRegisters`（行内编辑写入宽类型时使用）
- `modbus-slave-server.ts` — **核心**：ModBus 从站协议处理 + TCP 服务器
- `i18n.ts` — Translations (EN/ZH)
- `utils.ts` — `cn` class merging utility

### Hooks (src/hooks/)
- `use-app-state.tsx` — Global app state (React Context + useReducer)；`migrateViewTab()` 负责旧持久化标签的字段迁移（formatOverrides / 数量），已废弃的字段（如 `writeMode`、**已改归从站的 `byteOrder32/64`**）会被自然丢弃
- `use-i18n.tsx` — i18n provider + hook
- `use-modbus-ws.ts` — WebSocket connection + action dispatchers

### Components (src/components/)
- `slave-panel.tsx` — Left panel: slave list + config + start/stop controls
- `register-viewer.tsx` — 寄存器视图：标签栏（**绑定从站实例**，跨从站显示全部标签 + 从站名徽标，双击重命名）+ 内联配置条（区域 / 起始地址 / 数量 / 默认格式 + **只读**字节序[跟随从站]）+ 数据表（逐行类型 + 行内编辑草稿写入）
- ⚠️ **字节序不属于标签**（2026-09-20 改绑）：唯一数据源是 `SlaveConfig`，在**从站配置对话框**里改；标签侧只读显示
- `log-viewer.tsx` — Real-time request log viewer
- `ui/` — shadcn/ui base components

### Server (src/)
- `server.ts` — Custom Next.js server with WebSocket upgrade (**生产也必须用它启动**，否则 `/ws/slave` 不存在)
- `ws-handlers/slave.ts` — WebSocket message routing；TCP 端点复用（`tcpEndpoints`）+ Unit ID 路由 + 启停串行化；`write_response` 必须回传 `slaveId`（失败信息要能被前端落到按从站筛选的错误日志）

### Tests (src/\\*\\*/__tests__/)
- `modbus-slave-server.test.ts` — PDU 编解码、CRC/LRC、地址与长度校验、广播、组帧防御
- `modbus-utils.test.ts` — 字节序换算、显示格式化、逐行类型映射（`resolveRegisterLayout` / `formatFitsAt`）、输入解析与编码往返
- `use-app-state.test.ts` — reducer 纯函数（快照校准、增量补丁、删除清理、日志环形缓冲、视图标签迁移与从站绑定联动）

### Pages (src/app/)
- `layout.tsx` — Root layout (fonts, metadata, theme)
- `page.tsx` — Main application page

## Register Viewer Contract / 寄存器视图契约

视图标签（`RegisterViewTab`）绑定**从站实例**（`slaveId` = 应用内部 id），并携带读取窗口与显示配置：

| 字段 | 语义 |
|---|---|
| `area` | 数据区域：`coils` / `discreteInputs` / `holdingRegisters` / `inputRegisters`。⚠️ **不决定可编辑性**（见下） |
| `startAddress` / `registerCount` | 读取窗口，⭐**均为「寄存器」单位**（Q19/Q20）。`registerCount` 也是表格渲染行数 —— **1 行 = 1 寄存器**，四个区视图同构（位区 1 行 = 16 个位地址） |
| `displayFormat` | 标签级默认显示格式（可被逐行覆盖） |
| `formatOverrides` | 逐行类型映射：`Record<address, DataDisplayFormat>`，仅记录分组起始地址（key = 寄存器序号） |

- **没有写入模式字段。** 从站是"被写"的一方，界面上的写入走 `injectRegister` / `injectRange` **直接改内存**，不经过 `handleRequest()` 的 FC 解析路径，所以"单点写 / 区间写（FC05/06 vs FC15/16）"这类选择在从站侧没有意义，已移除。提交时按值的数量自动决定调用哪个接口。
- ⭐ **可编辑性不看区域**（R1）：四个区都能被操作者注入值，只要求从站运行中。
  **协议可写性**（`isWritableArea()`：只有线圈 / 保持寄存器）是**另一个概念**，仅用于界面提示"主站只读 · 仍可手动注入"，
  以及约束主站 FC 路径 —— 放开它就不是 ModBus 了。
- ⭐ **值来源（Q7）**：内存逐寄存器记 `source`（`master` / `manual` / `generator`），
  表格有来源角标 + 可按来源筛选；日志措辞区分（`Master write:` vs `Manual inject:`）。
- ⭐ **行备注（R4）不是标签字段**：归属**从站实例**，`key = slaveId:area`、值 = `寄存器序号 -> 文本`，
  存在 state 顶层 `rowNotes`；表格「地址」列后新增一列，点击行内编辑，空值显示 `—`。
  ⚠️ 用**独立**编辑态（`editingNoteCell` / `noteValue`），**不复用**值编辑的 `editingCell`；
  备注与"能否注入值"无关（只读区也能写）。删除从站时按 `slaveId:` 前缀级联清理。
- 行内编辑只写"草稿"，点击「写入」才整段提交；未编辑行回填当前原值，避免部分覆盖。
  ⚠️ **草稿按「窗口身份」= `标签 id + 区域 + 起始地址 + 数量` 分桶**（`registerWindowKey()`，唯一生成处）：
  换窗口 ⇒ 落进不同的桶（不串值、不会写错区）；切回原窗口 ⇒ 同一个桶，**草稿不丢**。
  **缓存的规则相反** —— 窗口一变就丢弃，并在新数据到达前禁用提交（防"未编辑行回填"写错窗口）。
  草稿自身**不带区域**：曾因此把离散输入区的草稿显示、甚至提交进别的区
  （见 ROADMAP §3.2「R1 后续修复：跨区串值」）。⚠️ master 侧同类缺陷尚未修（属 R3）。
  ⚠️ `registerWindowKey()` 在渲染期调用**必须包 `useMemo`**，否则 React Compiler 会跳过整个组件的编译。
- 写入后不主动轮询：视图由服务端 `register_update` 精确增量刷新。
- 新增字段必须提供迁移缺省（见 `migrateViewTab()`），否则老用户的 localStorage 标签会缺字段。
  ⚠️ 改名/改单位的字段要做**单位换算或收敛**，别直接搬旧值（如 `quantity` → `registerCount` 需夹到单帧上限）。

## Development Workflow / 开发工作流

1. **Understand the feature** — Read related files in `modbus-master` first if applicable
2. **Plan the implementation** — Identify which files need changes
3. **Implement** — Write code, following existing patterns
4. **Verify** — `pnpm run validate`（ts-check + eslint + stylelint + test）
5. **Document** — Update relevant docs if needed
6. **Test what is testable** — 协议层与 reducer 的纯函数改动必须补 `src/**/__tests__` 用例

## Docker / Container Deployment

```bash
docker network create modbus-net 2>/dev/null || true   # 与 modbus-master 仓库共用，只需建一次
docker compose up -d --build                           # 起本仓库（从站）→ http://localhost:5001
docker compose down
```

> 本仓库的 `docker-compose.yml` 与 [`modbus-master`](https://github.com/thouen/modbus-master) 仓库的那份**刻意分开**
> （两个仓库 = 两个独立 compose 项目），靠一张**外部共享网络 `modbus-net`** 互通（两边都写 `external: true`）。
> ⚠️ **先起本仓库（从站），再起主站**；**不要跨仓库写 `depends_on`**（compose 校验阶段直接报错）。
> 主站界面里的 host 填 **`modbus-slave`**，就是这个服务名。
> 完整说明与实测记录见本仓库 `docker-compose.yml` 顶部注释。

## Quality Checklist / 质量检查清单

- [ ] TypeScript compiles with no errors
- [ ] No `any` types (or justified with comment)
- [ ] Consistent naming with rest of project
- [ ] Component props properly typed
- [ ] All user-visible strings have i18n entries
- [ ] Dark theme tested
- [ ] Mobile responsive where applicable
