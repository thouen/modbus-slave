#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  pnpm install
fi

echo "Running validation..."
pnpm exec concurrently --group --names lint-tsc,lint-build,lint-style \
  "pnpm run ts-check" \
  "pnpm run lint:build" \
  "pnpm run lint:style"
