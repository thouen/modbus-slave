#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# 非容器安装脚本（在目标 Linux 上执行）
#
# ⚠️ 与 modbus-master 仓库那份**内容完全一样**，应用名取自目录名。
#
# 用法 A：先解包到 /opt，再装
#   sudo mkdir -p /opt/modbus-simulator
#   sudo tar -xzf modbus-master.tar.gz -C /opt/modbus-simulator
#   sudo /opt/modbus-simulator/modbus-master/scripts/install.sh
#
# 用法 B：让脚本自己解包（源码包路径作第一个参数）
#   sudo ./scripts/install.sh /tmp/modbus-master.tar.gz
#
# 环境变量：
#   INSTALL_ROOT=/opt/modbus-simulator   解包根目录（用法 B）
#   SVC_USER=modbus                      运行用户
#   SKIP_BUILD=1                         只装依赖、不构建
#
# 做的事：
#   ① 检查 Node / pnpm
#   ② 建专用运行用户 + 修正属主（非 root 时跳过）
#   ③ pnpm install --frozen-lockfile（⚠️ 不加 --prod：构建需要 tsup / typescript）
#   ④ next build + tsup → dist/server.js
#   ⑤ 若环境里有 supervisor 且仓库带 <app>.conf.example，放进 /etc/supervisor/conf.d/（不覆盖已有）
#
# ⚠️ 本脚本**不负责启动**。启动方式见 DEPLOY.md §4（systemd / supervisor）。
# ═══════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-/opt/modbus-simulator}"
SVC_USER="${SVC_USER:-modbus}"

# ── 定位应用目录 ───────────────────────────────────────────────
if [[ -n "${1:-}" ]]; then
    TARBALL="$1"
    [[ -f "$TARBALL" ]] || { echo "❌ 找不到源码包：$TARBALL"; exit 1; }
    TOPDIR="$(tar -tzf "$TARBALL" | head -1 | cut -d/ -f1)"
    echo "▶ 解包 $TARBALL → $INSTALL_ROOT/$TOPDIR"
    mkdir -p "$INSTALL_ROOT"
    tar -xzf "$TARBALL" -C "$INSTALL_ROOT"
    REPO_ROOT="$INSTALL_ROOT/$TOPDIR"
else
    REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

APP_NAME="$(basename "$REPO_ROOT")"
cd "$REPO_ROOT"
echo "▶ 安装目录：$REPO_ROOT（应用：$APP_NAME）"

# ── ① 环境检查 ─────────────────────────────────────────────────
# sudo 会把 HOME 指到 /root，而版本管理器装在**真实用户**家里 ⇒ 还原他的 home 再判断
REAL_USER="${SUDO_USER:-$(id -un)}"
USER_HOME="$(getent passwd "$REAL_USER" 2>/dev/null | cut -d: -f6 || true)"
[[ -n "$USER_HOME" ]] || USER_HOME="${HOME:-/root}"

node_missing_help() {
    echo "❌ 当前环境里找不到 node。"
    echo
    if [[ -d "$USER_HOME/.local/share/fnm" || -d "$USER_HOME/.fnm" ]]; then
        cat <<'EOT'
看起来你用 fnm 装了 node —— 但**脚本和 sudo 里都没有它**。
fnm 是靠 shell 初始化（eval "$(fnm env)"）把 node 塞进 PATH 的，
非交互脚本不读 .bashrc，sudo 还会用 secure_path 把 PATH 整个换掉。

⚠️ 这不是只影响本脚本：systemd / supervisor 启动时也不会执行你的 shell 初始化，
   所以服务本身同样找不到 node。建议**一次修好**——把 node 链进 /usr/local/bin
   （该目录在 sudo 的 secure_path 和 systemd 的默认 PATH 里都有）。

在**交互式 shell** 里执行：

  FNM_BIN="$(dirname "$(fnm exec --using=default -- which node)")"
  echo "$FNM_BIN"                    # 期望：/home/<你的用户名>/.local/share/fnm/aliases/default/bin
  sudo ln -sf "$FNM_BIN/node" /usr/local/bin/node
  sudo ln -sf "$FNM_BIN/npm"  /usr/local/bin/npm
  sudo ln -sf "$FNM_BIN/npx"  /usr/local/bin/npx
  sudo ln -sf "$FNM_BIN/corepack" /usr/local/bin/corepack
  sudo corepack enable && sudo corepack prepare pnpm@9.0.0 --activate

用 aliases/default 而不是 node-versions/<版本号>：前者是指向当前默认版本的链接，
以后 fnm 升级 node 会自动跟着变，不用重链。
EOT
    elif [[ -s "$USER_HOME/.nvm/nvm.sh" ]]; then
        cat <<'EOT'
看起来你用 nvm 装了 node —— 它同样靠 shell 初始化注入 PATH，脚本/sudo 里没有。

在**交互式 shell** 里先拿到路径，再链到 /usr/local/bin：

  nvm which default                  # 例：/home/<你的用户名>/.nvm/versions/node/v22.x.x/bin/node
  NODE_BIN="$(dirname "$(nvm which default)")"
  sudo ln -sf "$NODE_BIN/node" /usr/local/bin/node
  sudo ln -sf "$NODE_BIN/npm"  /usr/local/bin/npm
  sudo ln -sf "$NODE_BIN/npx"  /usr/local/bin/npx
  sudo corepack enable && sudo corepack prepare pnpm@9.0.0 --activate
EOT
    else
        echo "请先安装 Node 20.9+（建议 22 LTS），并让它位于 /usr/local/bin 或 /usr/bin："
        echo "  系统级安装推荐 NodeSource 或发行版自带的包管理器（详见 DEPLOY.md §1）。"
        echo
        echo "⚠️ 即便你在交互式终端里能跑 node，只要它是靠 fnm / nvm / n 这类版本管理器"
        echo "   注入 PATH 的，本脚本与 systemd / supervisor 都看不到它。"
    fi
    exit 1
}

command -v node >/dev/null 2>&1 || node_missing_help
command -v pnpm >/dev/null 2>&1 || { echo "❌ 找不到 pnpm。先跑：corepack enable && corepack prepare pnpm@9.0.0 --activate"; exit 1; }

# node 找到了，但如果是版本管理器提供的，服务仍然会起不来 —— 提前警告
NODE_AT="$(command -v node)"
case "$NODE_AT" in
    */.nvm/*|*/fnm/*|*/node-versions/*|*/aliases/*)
        echo "⚠️ node 来自版本管理器：$NODE_AT"
        echo "   你现在能跑，但 systemd / supervisor 启动时不会执行 shell 初始化 ⇒ 服务会找不到 node。"
        echo "   建议把它链到 /usr/local/bin（做法见上面）。"
        ;;
esac

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || echo "⚠️ Node 主版本 $NODE_MAJOR 偏低，Next 16 要求 >= 20.9"
echo "  node $(node -v)（$NODE_AT） / pnpm $(pnpm -v)"

# ── ② 运行用户与权限 ───────────────────────────────────────────
RUNNER=""
if [[ "$(id -u)" == "0" ]]; then
    if ! id "$SVC_USER" >/dev/null 2>&1; then
        echo "▶ 创建运行用户 $SVC_USER"
        useradd -r -s /usr/sbin/nologin -d "$INSTALL_ROOT" "$SVC_USER" || true
    fi
    chown -R "$SVC_USER":"$SVC_USER" "$REPO_ROOT"
    if command -v runuser >/dev/null 2>&1; then
        RUNNER="runuser -u $SVC_USER --"
    else
        RUNNER="sudo -u $SVC_USER"
    fi
else
    echo "ℹ️ 非 root 运行：跳过建用户/改属主，用当前用户 $(id -un) 安装"
fi

# ── ③ pnpm-workspace.yaml 兼容处理 ─────────────────────────────
# modbus-slave 的 pnpm-workspace.yaml 只有 allowBuilds、**没有 packages: 字段**；
# pnpm 9 一见到 workspace 文件就要求 packages，会直接报
# ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION ⇒ 安装期间临时移开，装完还原。
WS_FILE="$REPO_ROOT/pnpm-workspace.yaml"
WS_MOVED=0
restore_ws() {
    if [[ "$WS_MOVED" == "1" && -f "${WS_FILE}.bak" ]]; then
        mv "${WS_FILE}.bak" "$WS_FILE"
        echo "▶ 已还原 $(basename "$WS_FILE")"
    fi
}
trap restore_ws EXIT

if [[ -f "$WS_FILE" ]]; then
    PNPM_MAJOR="$(pnpm -v | cut -d. -f1)"
    if [[ "$PNPM_MAJOR" -lt 10 ]] && ! grep -qE '^[[:space:]]*packages:' "$WS_FILE"; then
        echo "⚠️ pnpm $PNPM_MAJOR 遇到没有 packages: 的 pnpm-workspace.yaml 会安装失败"
        echo "   ⇒ 安装期间临时移开，装完还原"
        mv "$WS_FILE" "${WS_FILE}.bak"
        WS_MOVED=1
    fi
fi

# ── ④ 装依赖 ───────────────────────────────────────────────────
echo "▶ pnpm install --frozen-lockfile（⚠️ 不加 --prod：构建需要 tsup / typescript）"
$RUNNER pnpm install --frozen-lockfile

# ── ⑤ 构建 ─────────────────────────────────────────────────────
if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
    echo "⏭ SKIP_BUILD=1，跳过构建"
else
    echo "▶ 构建（next build + tsup → dist/server.js）"
    echo "  ⚠️ 峰值内存约 1.5~2GB；小内存 VPS 先：export NODE_OPTIONS=--max-old-space-size=2048"
    $RUNNER pnpm exec next build
    $RUNNER pnpm exec tsup src/server.ts --format cjs --platform node --target node20 \
        --outDir dist --no-splitting --no-minify
fi

restore_ws   # 提前还原（trap 里也挂了，幂等）

# ── ⑥ 顺手放好 supervisor 配置 ─────────────────────────────────
CONF_SRC="$REPO_ROOT/${APP_NAME}.conf.example"
if [[ -f "$CONF_SRC" && -d /etc/supervisor/conf.d && "$(id -u)" == "0" ]]; then
    CONF_DST="/etc/supervisor/conf.d/${APP_NAME}.conf"
    if [[ -e "$CONF_DST" ]]; then
        echo "ℹ️ $CONF_DST 已存在，不覆盖（保留你的改动）"
    else
        cp "$CONF_SRC" "$CONF_DST"
        echo "▶ 已写入 supervisor 配置：$CONF_DST"
        echo "  记得改里面的 directory / user，然后：supervisorctl reread && supervisorctl update"
    fi
fi

# ── 收尾提示 ───────────────────────────────────────────────────
PORT=5001; WS=slave
if [[ "$APP_NAME" == "modbus-master" ]]; then PORT=5000; WS=modbus; fi

cat <<EOF

✅ 装好了。
   目录：$REPO_ROOT
   产物：$([[ -f "$REPO_ROOT/dist/server.js" ]] && echo "dist/server.js ✓" || echo "（未构建）")

启动（任选一种，**必须带 COZE_PROJECT_ENV=PROD**，否则会跑成 dev 模式）：
  supervisor:  sudo supervisorctl start $APP_NAME
  systemd:     sudo systemctl enable --now $APP_NAME      # unit 见 DEPLOY §4.1
  手动:        cd $REPO_ROOT && COZE_PROJECT_ENV=PROD HOSTNAME=0.0.0.0 node dist/server.js

默认端口 $PORT（WS 端点 /ws/$WS）。完整的坑与验法见 DEPLOY.md §3 / §6。
EOF
