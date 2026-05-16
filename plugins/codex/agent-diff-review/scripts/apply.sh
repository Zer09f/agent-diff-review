#!/usr/bin/env sh
set -eu

SESSION_PATH="${1:-.agent-diff-review/session.json}"
DECISION_PATH="${2:-.agent-diff-review/decisions.json}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if [ "${3:-}" = "--dry-run" ]; then
  node "$SCRIPT_DIR/adr-wrapper.mjs" apply --source snapshot --session "$SESSION_PATH" --decisions "$DECISION_PATH" --dry-run
else
  node "$SCRIPT_DIR/adr-wrapper.mjs" apply --source snapshot --session "$SESSION_PATH" --decisions "$DECISION_PATH"
fi
