#!/bin/bash
# Shared helpers for macOS/Linux shell entrypoints.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PYTHON_BIN="${KOTORI_PET_PYTHON:-/usr/bin/python3}"
export PLATFORM_DIR
export PYTHON_BIN
