#!/bin/bash
# macOS/Linux shell 入口脚本共享的辅助函数。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PYTHON_BIN="${KOTORI_PET_PYTHON:-/usr/bin/python3}"
export PLATFORM_DIR
export PYTHON_BIN
