---
description: Apply exported agent-diff-review accept/reject decisions to the current Git worktree.
allowed-tools: Bash(node *)
---

Run a dry-run first, then apply decisions only if the dry-run succeeds:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/adr-wrapper.mjs" apply --session .agent-diff-review/session.json --decisions .agent-diff-review/decisions.json --dry-run
node "$CLAUDE_PLUGIN_ROOT/scripts/adr-wrapper.mjs" apply --session .agent-diff-review/session.json --decisions .agent-diff-review/decisions.json
```

Report the number of files checked, files changed, and rejected rows printed by the command.
