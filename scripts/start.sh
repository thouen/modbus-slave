#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

# 生产必须运行自定义服务器（src/server.ts）：
# next start 只启动 Next 内置服务器，会完全跳过 server.on('upgrade')，
# 导致 /ws/slave 端点不存在 —— 界面能打开但全部实时功能静默失效。
# 端口来源与 dev 保持一致（DEPLOY_RUN_PORT），并兼容历史变量 PORT。
export DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-${PORT:-5001}}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"

echo "Starting production server on $HOSTNAME:$DEPLOY_RUN_PORT..."
exec pnpm exec tsx src/server.ts
