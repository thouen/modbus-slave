#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

PORT=5001
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-$PORT}"

# ⚠️ 不要改回 `next start`（或 `tsx src/server.ts` 之外的内置服务器）：
#    next start 会跳过 server.on('upgrade')，/ws/slave 端点根本不存在 ——
#    界面能开、按钮都能点，但所有实时功能静默失效。这就是已修的 P0-5（2026-09-17）。
#    产物由 scripts/build.sh 的 tsup 打包成 dist/server.js。
start_service() {
    cd "${COZE_WORKSPACE_PATH}"
    echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for deploy..."
    PORT=${DEPLOY_RUN_PORT} node dist/server.js
}

echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for deploy..."
start_service
