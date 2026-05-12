# JSON-RPC 接口

插件集成层应在宿主消息通道中暴露以下接口形态。MVP 阶段可以通过调用 `adr` 命令来实现这些方法。

## 方法

### scanWorkspace

输入：

```json
{
  "workspace": ".",
  "baseRef": "HEAD"
}
```

输出：`ReviewSession`

### getReviewSession

输入：

```json
{
  "sessionPath": ".agent-diff-review/session.json"
}
```

输出：`ReviewSession`

### setLineDecision

输入：

```json
{
  "fileId": "...",
  "hunkId": "...",
  "rowId": "...",
  "decision": "reject"
}
```

输出：`DecisionSet`

### applyDecisions

输入：

```json
{
  "sessionPath": ".agent-diff-review/session.json",
  "decisionPath": ".agent-diff-review/decisions.json",
  "dryRun": true
}
```

输出：

```json
{
  "dryRun": true,
  "filesChecked": 4,
  "filesChanged": 1,
  "rejectedRows": 3
}
```

### exportReport

输入：

```json
{
  "sessionPath": ".agent-diff-review/session.json",
  "out": ".agent-diff-review/report.html"
}
```

输出：

```json
{
  "path": ".agent-diff-review/report.html"
}
```
