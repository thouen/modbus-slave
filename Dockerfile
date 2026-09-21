# ═══════════════════════════════════════════════════════════════════
# modbus-slave —— 从站（Next.js 自定义服务器 + WebSocket + ModBus TCP/串口）
#
# ⚠️ 本文件的构建/启动方式与 modbus-master **刻意不同**，是跟随各自现状：
#        build = 只 next build（不打包）
#        run   = tsx src/server.ts   ← 用 TS 执行器现场跑源码
#    ⚠️ 直接后果：运行期镜像里**必须**保留 src/ 和 tsconfig.json，且必须装 tsx。
#    原因（修 P0-5 时选的最小改动）见 DEPLOY.md §2.3。
#
# ⚠️ 两条维护红线（都是实测踩出来的，别改回去）：
#    1. Dockerfile **不支持行内注释**。`COPY a b   # 说明` 里的 `# 说明`
#       会被当成参数（源路径），报错形如
#       `failed to calculate checksum ...: "/#": not found`。注释一律独占一行。
#    2. runner 阶段 `pnpm install` **必须在 `ENV NODE_ENV=production` 之前**，
#       否则 pnpm 自动跳过 devDependencies，Next 会在启动时联网自己装 typescript。
#       详见该处注释。
# ═══════════════════════════════════════════════════════════════════

# 与 .coze 的 requires = ["nodejs-24"] 对齐。换版本改这一行即可。
ARG NODE_VERSION=24

# ── Stage 1：构建 ──────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS builder

ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com

# 本应用 package.json 里**没有** packageManager 字段，所以在这里显式 pin 9.x：
# 既与 master 保持一致，也避开 pnpm 10+ 默认拒绝依赖构建脚本的变化。
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# ⚠️ 注意这里：
#   ① 没有拷 pnpm-workspace.yaml，`.dockerignore` 也把它排除了。
#      那个文件里只有 allowBuilds、**没有 packages 字段**，而 pnpm 9 一见到
#      workspace 文件就要求 packages，会报 "packages field missing or empty"。
#      而 allowBuilds 对 pnpm 9 是多余的 —— pnpm 9 默认就执行依赖构建脚本
#      （"默认拒绝"是 pnpm 10 才引入的，所以本文件才要钉住 9.x）。
#   ② **必须**把 scripts/ 一起拷进来。package.json 里有
#      "prepare": "bash ./scripts/prepare.sh"，install 结束时 pnpm 会自动执行它；
#      少了 scripts/ 会直接报 "No such file or directory" 中断安装。
#      （master 没有 prepare 脚本，所以那边不需要这一步。）
COPY package.json pnpm-lock.yaml .npmrc ./
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_OPTIONS=--max-old-space-size=2048
RUN pnpm exec next build

# ── Stage 2：运行 ──────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runner

ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# ⚠️⚠️ 安装依赖，**必须放在 NODE_ENV=production 之前**，顺序不能调。
#    Next 16 运行期加载 next.config.ts 时需要有 typescript 包，而它在 devDependencies 里。
#    想让 Next 拿到它，得同时满足两件事：
#      · 不加 --prod              （加了会跳过 devDependencies）
#      · 装的时候 NODE_ENV 还不是 production（否则 pnpm 会自动跳过 devDependencies）
#    任一条不满足，Next 就会在**启动时自己联网去装** typescript，日志里出现：
#      ⚠ Installing TypeScript as it was not found while loading "next.config.ts".
#    后果：容器启动依赖网络、镜像不再自包含、离线环境直接起不来。
#    （两条都是实测踩过的。这个文件最初就是踩了第二条才又失败一遍。）
#    scripts/ 必须先在位，因为 package.json 的 prepare 脚本会在 install 结束时执行。
COPY package.json pnpm-lock.yaml .npmrc ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

# ── 依赖装完之后，再切生产环境变量 ──

# ⚠️ 唯一的"生产模式"开关。不设 = Next 跑 dev 模式：不报错，但极慢
ENV COZE_PROJECT_ENV=PROD
ENV NODE_ENV=production
ENV DEPLOY_RUN_PORT=5001
# ⚠️ 必须显式写死：Docker 默认会把容器 ID 塞进 HOSTNAME，
#    而 scripts/start.sh 用的是 ${HOSTNAME:-0.0.0.0} —— 冒号兜底**不会生效**
#    （该变量在容器里已经非空），结果 Next 会拿到一串容器 ID。
ENV HOSTNAME=0.0.0.0

# ── 运行期需要的文件（注释必须独占一行，见文件头红线 1）──

# Next 生产产物
COPY --from=builder /app/.next ./.next

# Next 运行期仍会读配置
COPY --from=builder /app/next.config.ts ./next.config.ts

# ⚠️ 下面两个是"跑源码"路线特有的必需品，删掉会在启动瞬间就崩：

# 生产执行的正是 src/server.ts，所以源码必须在
COPY --from=builder /app/src ./src

# tsx 靠它的 paths 解析 @/* 别名，少了它连 import 都过不去
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# ⚠️ 本应用**没有 public/ 目录**（不是漏拷），所以这里没有 COPY public。
# ⚠️ scripts/ 已经在安装依赖前拷好了（prepare 脚本要用），这里不再重复拷。

# 5001 = 管理界面 + /ws/slave；502 = ModBus TCP 从站默认端口
EXPOSE 5001
EXPOSE 502

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DEPLOY_RUN_PORT||5001)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ⚠️ 不要改成 next start —— 它会跳过 server.on('upgrade')，/ws/slave 直接消失，
#    表现是"页面能开、按钮能点，但所有实时功能静默失效"。
# 用 pnpm exec 是为了与 scripts/start.sh 行为完全一致（会把 node_modules/.bin 加进 PATH）。
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
