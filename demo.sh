#!/bin/bash
# QRed Demo — fully client-side, no backend needed
# Run: ./demo.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/frontend"

echo "🐱 QRed Demo — client-side only, no backend"
echo "==========================================="
echo ""

if ! command -v node &>/dev/null; then
  echo "Node.js is required but not found. Install from https://nodejs.org" >&2
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing frontend dependencies..."
  npm ci
  echo ""
fi

echo "Starting dev server at http://localhost:3000"
npm start
