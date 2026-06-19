#!/bin/bash
# QRed Demo Script
# Run: ./demo.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "🐱 QRed Demo Setup"
echo "=================="
echo ""

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "✓ Python 3 found"
fi

# Create virtual environment if needed
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
    source venv/bin/activate
    echo "Installing dependencies..."
    pip install -q -r requirements.txt
    echo ""
else
    source venv/bin/activate
fi

# Run the demo
echo "Running QRed demo..."
echo ""
python3 demo.py