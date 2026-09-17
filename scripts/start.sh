#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

export HOSTNAME=${HOSTNAME:-0.0.0.0}
export PORT=${PORT:-3000}

echo "Starting production server on $HOSTNAME:$PORT..."
exec pnpm exec next start -H "$HOSTNAME" -p "$PORT"
