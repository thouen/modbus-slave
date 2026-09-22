#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# 源码打包脚本（非容器 / 原始部署用）
#
# ⚠️ 本文件在 modbus-master 与 modbus-slave 两个仓库里**内容完全一样**，
#    应用名取自仓库目录名（不读 package.json —— master 的 name 还是模板默认的 "projects"）。
#
# 用法（在各自仓库根目录执行）：
#   ./scripts/package.sh                              # 输出到 ./dist-pkg/<仓库名>-<时间戳>.tar.gz
#   ./scripts/package.sh /tmp/modbus-master.tar.gz    # 指定输出路径
#   INCLUDE_DIRTY=1 ./scripts/package.sh              # 连未提交改动一起打（改用 tar，不走 git archive）
#
# ⚠️ 为什么只打源码、不带 node_modules / .next / dist：
#    serialport（两端都有）是原生模块，*.node 二进制与操作系统/架构绑定。
#    在 Windows / macOS 上装好的 node_modules 拷到 Linux 会直接
#    "Error: %1 is not a valid Win32 application"。
#    ⇒ 装依赖与构建都必须在目标 Linux 上做，交给 scripts/install.sh。
# ═══════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="$(basename "$REPO_ROOT")"          # 目录名即应用名，例如 modbus-master / modbus-slave
STAMP="$(date +%Y%m%d%H%M)"
OUT="${1:-${REPO_ROOT}/dist-pkg/${APP_NAME}-${STAMP}.tar.gz}"

cd "$REPO_ROOT"
mkdir -p "$(dirname "$OUT")"

HAS_GIT=0
git rev-parse --git-dir >/dev/null 2>&1 && HAS_GIT=1

if [[ "$HAS_GIT" == "1" && "${INCLUDE_DIRTY:-0}" != "1" ]]; then
    # 干净提交态：git archive 自动排除 .git / node_modules / .next / dist
    # ⚠️ 打的是 HEAD —— 工作区里未提交的改动不会进包
    # ⚠️ 用重定向而不是 `git archive -o "$OUT"`：git 在 Windows/Git Bash 下
    #    识别不了 /d/... 这类 MSYS 路径（报 "could not open ... for writing"），
    #    交给 shell 重定向即可，两种平台都能用。
    git archive --prefix="${APP_NAME}/" --format=tar.gz HEAD > "$OUT"
    MODE="git archive HEAD（只含已提交内容）"
else
    # 工作区态（含未提交改动），或仓库没有 git：手动排除不该上线的目录
    tar --exclude=node_modules --exclude=.next --exclude=dist --exclude=dist-pkg \
        --exclude=.git --exclude='*.tsbuildinfo' --exclude=.workbuddy \
        -czf "$OUT" -C "$(dirname "$REPO_ROOT")" "$APP_NAME"
    MODE="tar（含未提交改动）"
fi

echo "✅ 打包完成 —— $MODE"
echo "   输出：$OUT"
echo "   体积：$(du -h "$OUT" | cut -f1)"
echo
echo "下一步（在目标 Linux 上）："
echo "  sudo mkdir -p /opt/modbus-simulator"
echo "  sudo tar -xzf dist-pkg/$(basename "$OUT") -C /opt/modbus-simulator"
echo "  sudo /opt/modbus-simulator/${APP_NAME}/scripts/install.sh"
