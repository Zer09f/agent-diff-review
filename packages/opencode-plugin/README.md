# OpenCode 插件

该包提供一个 OpenCode 插件，用来调用共享的 `adr` 二进制。

本地开发时，可以将构建后的插件或这个 TypeScript 文件复制到 `.opencode/plugins/`：

```bash
mkdir -p .opencode/plugins
cp packages/opencode-plugin/src/index.ts .opencode/plugins/agent-diff-review.ts
```

插件会监听 `session.idle` 和 `session.diff` 事件，然后写入：

- `.agent-diff-review/session.json`
- `.agent-diff-review/report.html`

它还会暴露一个名为 `adr_review` 的自定义工具。
