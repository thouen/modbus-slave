#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

if ! pnpm exec tsx --version > /dev/null 2>&1; then
  echo "Installing dependencies..."
  pnpm install
fi

export DEPLOY_RUN_PORT=${DEPLOY_RUN_PORT:-5001}
export HOSTNAME=${HOSTNAME:-0.0.0.0}

exec pnpm exec tsx watch src/server.ts
