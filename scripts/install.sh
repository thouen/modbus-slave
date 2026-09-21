#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# 非容器安装脚本（在目标 Linux 上执行）
#
# ⚠️ 两个仓库里本文件**内容完全一样**，应用名取自目录名（master / slave 通用）。
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
#   COREPACK_HOME=/var/lib/corepack      corepack / pnpm 缓存目录（root 与服务用户共享）
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

# ── corepack / pnpm 缓存目录（要在**第一次调用 pnpm 之前**定好）─────────
# ⭐ corepack 把 pnpm 本体缓存在 $HOME/.cache/node/corepack —— **每个用户各一份**。
#    你交互式 shell 里的 pnpm 属于**你自己的用户**，脚本却要以 **$SVC_USER** 身份跑 pnpm，
#    那个用户没有缓存 ⇒ corepack 会"为一个新用户重新下载一遍 pnpm"（看起来就像在联网装 pnpm）。
#    指定一个**共享**目录后：root 先跑一次把包取下来，服务用户直接复用 ⇒ 全程只下载一次。
#    （非 root 运行时没有共享的必要，退回默认的每用户缓存。）
COREPACK_HOME="${COREPACK_HOME:-}"
if [[ "$(id -u)" == "0" ]]; then
    [[ -n "$COREPACK_HOME" ]] || COREPACK_HOME="/var/lib/corepack"
    mkdir -p "$COREPACK_HOME"
    export COREPACK_HOME
fi

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
if [[ -n "${COREPACK_HOME:-}" ]]; then echo "  corepack 缓存：$COREPACK_HOME"; fi

# ── ② 运行用户与权限 ───────────────────────────────────────────
RUNNER=""
if [[ "$(id -u)" == "0" ]]; then
    if ! id "$SVC_USER" >/dev/null 2>&1; then
        echo "▶ 创建运行用户 $SVC_USER"
        # ⚠️ home **不能**设成 $INSTALL_ROOT：那是 root 建的根目录，服务用户写不进去，
        #    而 corepack / pnpm 一定要在 $HOME/.cache 下放缓存 ⇒ 会 EACCES。
        #    这里给一个独立的、归它自己的 home。
        useradd -r -s /usr/sbin/nologin -d "/var/lib/$SVC_USER" "$SVC_USER" || true
    fi

    # 已存在的用户可能没有 home 或指向 /nonexistent，补一个可用的
    SVC_HOME="$(getent passwd "$SVC_USER" | cut -d: -f6 || true)"
    if [[ -z "$SVC_HOME" || "$SVC_HOME" == "/nonexistent" ]]; then
        SVC_HOME="/var/lib/$SVC_USER"
        usermod -d "$SVC_HOME" "$SVC_USER" 2>/dev/null || true
    fi

    # ⚠️ 关键一步：pnpm 也会往 $HOME/.cache 写东西（即便 corepack 用了共享目录）。
    #    只 chown 应用目录是不够的 —— 这正是
    #    "EACCES: mkdir '<home>/.cache/node/corepack/v1'" 的来源。
    mkdir -p "$SVC_HOME/.cache"
    chown -R "$SVC_USER":"$SVC_USER" "$SVC_HOME/.cache"
    chown -R "$SVC_USER":"$SVC_USER" "$REPO_ROOT"

    # 上面 root 已经跑过 pnpm ⇒ 共享缓存里已经有包；交给服务用户，避免它再下一遍
    if [[ -n "${COREPACK_HOME:-}" ]]; then chown -R "$SVC_USER":"$SVC_USER" "$COREPACK_HOME"; fi

    # 显式传 HOME 与 COREPACK_HOME：runuser / sudo 会重置环境，
    # 不传的话缓存会被写进 root 家目录，或服务用户又去下载一份
    if command -v runuser >/dev/null 2>&1; then
        RUNNER="runuser -u $SVC_USER -- env HOME=$SVC_HOME COREPACK_HOME=$COREPACK_HOME"
    else
        RUNNER="sudo -u $SVC_USER env HOME=$SVC_HOME COREPACK_HOME=$COREPACK_HOME"
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
# 以**服务用户**身份第一次跑 pnpm 时，corepack 可能要现取 pnpm 本体。
# 先单独跑一次，让"没网 / 缓存目录不可写"这类问题在这一步就明确暴露，
# 而不是混在 install 的一大堆输出里。
if [[ -n "$RUNNER" ]]; then
    echo "▶ 预热 pnpm：以 $SVC_USER 身份跑一次（共享缓存已备好时这步是秒过）"
else
    echo "▶ 检查 pnpm"
fi
$RUNNER pnpm --version

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
