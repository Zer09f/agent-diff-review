#!/usr/bin/env sh
set -eu

SESSION_PATH="${1:-.agent-diff-review/session.json}"
REPORT_PATH="${2:-.agent-diff-review/report.html}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

node "$SCRIPT_DIR/adr-wrapper.mjs" scan --format json --out "$SESSION_PATH"
node "$SCRIPT_DIR/adr-wrapper.mjs" report --session "$SESSION_PATH" --out "$REPORT_PATH"
printf 'agent-diff-review report written to %s\n' "$REPORT_PATH"
