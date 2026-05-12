---
name: agent-diff-review
description: Generate and apply visual line-level review decisions for AI-generated Git worktree changes with the adr binary.
---

# agent-diff-review

Use this skill when the user asks to review, visualize, accept, reject, or apply AI-generated code changes.

## Commands

From the target Git repository:

```powershell
adr scan --format json --out .agent-diff-review/session.json
adr report --session .agent-diff-review/session.json --out .agent-diff-review/report.html
adr apply --session .agent-diff-review/session.json --decisions .agent-diff-review/decisions.json --dry-run
adr apply --session .agent-diff-review/session.json --decisions .agent-diff-review/decisions.json
```

## Workflow

1. Run `scan` after the AI has modified the worktree.
2. Run `report` and show the user the report path.
3. Ask the user to export `decisions.json` from the report.
4. Run `apply --dry-run`.
5. If dry-run succeeds and the user wants to apply, run `apply`.

Pending rows default to accept. Only explicit rejects change the current worktree.

