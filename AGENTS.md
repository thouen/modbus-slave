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
- `modbus-slave-server.ts` — **核心**：ModBus 从站协议处理 + TCP 服务器
- `i18n.ts` — Translations (EN/ZH)
- `utils.ts` — `cn` class merging utility

### Hooks (src/hooks/)
- `use-app-state.tsx` — Global app state (React Context + useReducer)
- `use-i18n.tsx` — i18n provider + hook
- `use-modbus-ws.ts` — WebSocket connection + action dispatchers

### Components (src/components/)
- `slave-panel.tsx` — Left panel: slave list + config + start/stop controls
- `register-viewer.tsx` — Multi-tab register data viewer/editor
- `log-viewer.tsx` — Real-time request log viewer
- `ui/` — shadcn/ui base components

### Server (src/)
- `server.ts` — Custom Next.js server with WebSocket upgrade
- `ws-handlers/slave.ts` — WebSocket message routing for slave operations

### Pages (src/app/)
- `layout.tsx` — Root layout (fonts, metadata, theme)
- `page.tsx` — Main application page

## Development Workflow / 开发工作流

1. **Understand the feature** — Read related files in `modbus-master` first if applicable
2. **Plan the implementation** — Identify which files need changes
3. **Implement** — Write code, following existing patterns
4. **Verify** — `npm run build` to catch TypeScript errors
5. **Document** — Update relevant docs if needed

## Quality Checklist / 质量检查清单

- [ ] TypeScript compiles with no errors
- [ ] No `any` types (or justified with comment)
- [ ] Consistent naming with rest of project
- [ ] Component props properly typed
- [ ] All user-visible strings have i18n entries
- [ ] Dark theme tested
- [ ] Mobile responsive where applicable
