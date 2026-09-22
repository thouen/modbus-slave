#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# 卸载脚本 —— 从 /opt 移除本应用，并清掉 supervisor 相关配置
#            （用于"不再用 supervisor 托管、改走 Docker"的场景）
#
# ⚠️ 两个仓库里本文件**内容完全一样**，应用名取自目录名（master / slave 通用）。
#
# 用法（**必须 root**）：
#   sudo bash /opt/modbus-simulator/modbus-slave/scripts/uninstaller.sh
#
# 参数：
#   --dry-run      只打印将要做的事，不做任何改动（**建议第一次先跑这个**）
#   --keep-files   停服务 + 清配置，但**保留应用目录**
#   -y / --yes     跳过交互确认（脚本化时用）
#
# 环境变量：
#   REPO_ROOT=...   应用目录（默认 = 本脚本所在目录的上一级）
#
# ── ⚠️ 推荐流程（先验证，再删源码）────────────────────────────────
#   Docker 构建**需要源码**（compose 里 build.context 指的就是这个目录），
#   而本脚本默认会把目录整个删掉 ⇒ 删早了就构建不了。所以建议分两步：
#
#     ① sudo bash .../uninstaller.sh --keep-files      ← 停服务、清配置，源码留着
#     ② cd /opt/modbus-simulator && docker compose up -d --build
#     ③ 确认容器跑起来、界面能开之后，再跑一次（不加 --keep-files）删掉源码
#
# ── 做的事 ──────────────────────────────────────────────────────
#   ① supervisor 里停掉本程序（stop → remove）
#   ② 删 /etc/supervisor/conf.d/<app>.conf（连同可能存在的 .bak）
#   ③ supervisorctl reread && update（让 supervisor 忘掉它）
#   ④ 删 /var/log/supervisor/<app>.*.log*（含轮转出来的旧文件）
#   ⑤ 删整个应用目录（node_modules / .next / dist 一起）—— 除非给了 --keep-files
#
# ── 有意**不做**的事（结尾会提示你自查，避免误伤）────────────────
#   · 不删运行用户（如 modbus）—— 可能有别的服务在用它
#   · 不撤销 node 的 setcap 标签 —— 别的程序可能也靠这个绑低端口（见 DEPLOY §3.3）
#   · 不动 iptables REDIRECT 规则 —— 要清请自己确认后删
#   · 不碰浏览器里的连接 / 从站配置 —— 那本来就不在服务端（见 DEPLOY §8），
#     所以**卸载不会丢你的配置**，丢的只是"正在运行的从站实例"
#
# ⚠️ 本脚本**不负责**起 Docker。卸载完怎么起容器，见 DEPLOY.md §9.8。
# ═══════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

DRY_RUN=0
ASSUME_YES=0
KEEP_FILES=0
for arg in "$@"; do
    case "$arg" in
        --dry-run)    DRY_RUN=1 ;;
        --keep-files) KEEP_FILES=1 ;;
        -y|--yes)     ASSUME_YES=1 ;;
        -h|--help)    sed -n '2,48p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) echo "❌ 未知参数：$arg（支持 --dry-run / --keep-files / -y / --help）"; exit 1 ;;
    esac
done

# ── 动作包装：dry-run 时只打印 ──────────────────────────────────
do_rm() {
    if [[ "$DRY_RUN" == "1" ]]; then echo "   [dry-run] rm -rf $1"; else rm -rf "$1"; fi
}
do_rm_f() {
    if [[ "$DRY_RUN" == "1" ]]; then echo "   [dry-run] rm -f $1"; else rm -f "$1"; fi
}

# ── ① 权限检查 ─────────────────────────────────────────────────
# 要动 /etc/supervisor 和 /opt 下的目录，非 root 干不了
if [[ "$(id -u)" != "0" ]]; then
    echo "❌ 请以 root 运行（本脚本要删 /etc/supervisor 下的配置和 /opt 下的目录）："
    echo "     sudo bash $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    exit 1
fi

# ── ② 定位应用目录（多重防误删）────────────────────────────────
if [[ -z "${REPO_ROOT:-}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
[[ -d "$REPO_ROOT" ]] || { echo "❌ 应用目录不存在：$REPO_ROOT"; exit 1; }
APP_NAME="$(basename "$REPO_ROOT")"

# 防误删一：目录名必须是这两个之一（防止脚本被拷到别处执行时删错东西）
case "$APP_NAME" in
    modbus-master|modbus-slave) ;;
    *) echo "❌ 目录名是「$APP_NAME」，不是 modbus-master / modbus-slave，拒绝执行"; exit 1 ;;
esac
# 防误删二：目录里必须有 package.json（确认它真的是应用目录）
[[ -f "$REPO_ROOT/package.json" ]] || { echo "❌ $REPO_ROOT 里没有 package.json，不像应用目录，拒绝执行"; exit 1; }

PORT=5001
[[ "$APP_NAME" == "modbus-master" ]] && PORT=5000

SUPERVISOR_CONF="/etc/supervisor/conf.d/${APP_NAME}.conf"
LOG_DIR="/var/log/supervisor"

# ── ③ 打印计划 + 确认 ──────────────────────────────────────────
if [[ "$KEEP_FILES" == "1" ]]; then
    DIR_ACTION="保留（--keep-files），之后再删"
else
    DIR_ACTION="整个删除"
fi

cat <<EOF
════════════════════════════════════════════════════════
 即将卸载：$APP_NAME
   应用目录：$REPO_ROOT
     → $DIR_ACTION
   supervisor 配置：$SUPERVISOR_CONF
   日志：$LOG_DIR/${APP_NAME}.*
   管理端口：$PORT

 不会动：运行用户、node 的 setcap 标签、iptables 规则、浏览器里的配置
════════════════════════════════════════════════════════
EOF

if [[ "$DRY_RUN" == "1" ]]; then
    echo "（--dry-run：下面只打印，不执行）"
elif [[ "$ASSUME_YES" != "1" ]]; then
    printf '确认卸载？输入 yes 继续： '
    # ⚠️ 必须先初始化再 read：非交互场景（输入被重定向 / 管道）下 read 会直接失败，
    #    未赋值的变量在 `set -u` 下会让脚本报错退出，而不是正常"取消"。
    ANSWER=""
    read -r ANSWER || true
    [[ "$ANSWER" == "yes" ]] || { echo "已取消"; exit 0; }
fi

# ── ④ 停 supervisor 里的程序 ───────────────────────────────────
if command -v supervisorctl >/dev/null 2>&1; then
    echo "▶ 停止 $APP_NAME"
    if [[ "$DRY_RUN" == "1" ]]; then
        echo "   [dry-run] supervisorctl stop $APP_NAME"
        echo "   [dry-run] supervisorctl remove $APP_NAME"
    else
        # 没在跑 / 没加载过都会报错，忽略即可（幂等）
        supervisorctl stop "$APP_NAME" 2>/dev/null || echo "   （未在运行，跳过）"
        supervisorctl remove "$APP_NAME" 2>/dev/null || true
    fi
else
    echo "ℹ️ 系统里没有 supervisorctl，跳过停止步骤"
fi

# ── ⑤ 删配置（含 .bak 备份）────────────────────────────────────
echo "▶ 移除 supervisor 配置"
for f in "$SUPERVISOR_CONF" "${SUPERVISOR_CONF}.bak"; do
    if [[ -e "$f" ]]; then do_rm_f "$f"; else echo "   （不存在：$f）"; fi
done

# ── ⑥ 让 supervisor 重新加载配置 ───────────────────────────────
if command -v supervisorctl >/dev/null 2>&1; then
    echo "▶ supervisorctl reread && update"
    if [[ "$DRY_RUN" == "1" ]]; then
        echo "   [dry-run] supervisorctl reread && supervisorctl update"
    else
        supervisorctl reread >/dev/null 2>&1 || true
        supervisorctl update >/dev/null 2>&1 || true
    fi
fi

# ── ⑦ 删日志 ───────────────────────────────────────────────────
echo "▶ 清理日志"
shopt -s nullglob
LOGS=("$LOG_DIR/${APP_NAME}".*.log*)
shopt -u nullglob
if [[ ${#LOGS[@]} -eq 0 ]]; then
    echo "   （无日志）"
else
    for f in "${LOGS[@]}"; do do_rm_f "$f"; done
fi

# ── ⑧ 删应用目录（--keep-files 时跳过）─────────────────────────
if [[ "$KEEP_FILES" == "1" ]]; then
    echo "▶ 保留应用目录（--keep-files）：$REPO_ROOT"
    echo "   ⇒ Docker 构建需要它。等容器验证通过后再跑一次本脚本（不加该参数）即可删除。"
else
    # ⚠️ 这会把脚本自己一起删掉。bash 是按块读脚本的（本文件一次就读完了），
    #    所以删完剩下的几行仍能正常跑完；这也是为什么它是**最后一步**。
    echo "▶ 删除应用目录：$REPO_ROOT"
    do_rm "$REPO_ROOT"
fi

# ── ⑨ 收尾：自查清单 + 下一步 ──────────────────────────────────
cat <<EOF

✅ $APP_NAME 已卸载。

自查（本脚本有意没替你做，按需处理）：
  1. 端口是否真的空出来了：
       ss -lntp | grep ':$PORT'
  2. node 上若打过 setcap 标签（见 DEPLOY §3.3），现在可以撤：
       getcap "\$(readlink -f "\$(which node)")"
       sudo setcap -r "\$(readlink -f "\$(which node)")"
     ⚠️ 撤销前确认没有别的服务也靠它绑低端口。
  3. 若加过 502 转发规则，确认后删：
       sudo iptables -t nat -S PREROUTING | grep 502
  4. 运行用户（如 modbus）仍在，属正常，不影响 Docker 部署。

ℹ️ 你的连接 / 从站配置**没丢** —— 它们存在浏览器里，不在服务端（见 DEPLOY §8）。
   丢的只是"正在运行的从站实例"，容器起来后在界面上重新启动即可。
EOF
