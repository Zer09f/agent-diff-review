---
description: Generate an agent-diff-review visual report for the current Git worktree.
allowed-tools: Bash(node *)
---

Run the bundled agent-diff-review CLI from this plugin:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/adr-wrapper.mjs" scan --format json --out .agent-diff-review/session.json
node "$CLAUDE_PLUGIN_ROOT/scripts/adr-wrapper.mjs" report --session .agent-diff-review/session.json --out .agent-diff-review/report.html
```

Then tell the user that the report is available at `.agent-diff-review/report.html`.
