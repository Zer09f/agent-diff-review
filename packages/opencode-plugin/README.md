# agent-diff-review OpenCode 插件

用于从当前 Git 工作区生成 `agent-diff-review` 报告的 OpenCode 插件。

## 配置

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@agent-diff-review/opencode-plugin"]
}
```

插件会暴露 `adr_review` 工具，并写入：

```text
.agent-diff-review/session.json
.agent-diff-review/report.html
```

插件会优先使用内置 `adr` 二进制。需要自定义路径时，可以设置 `ADR_PATH`。
