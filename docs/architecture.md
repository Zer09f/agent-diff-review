# 架构

`agent-diff-review` 分为一个 Rust 核心引擎和若干轻量 TypeScript 集成层。

## 数据流

1. `adr scan` 读取 `git diff HEAD -- .` 以及未跟踪文件。
2. 扫描器为每一行 diff 映射稳定的 `rowId`。
3. 核心分析器补充依赖边、风险标记和测试影响信号。
4. `adr report` 根据 session JSON 生成独立 review 报告。
5. 用户从报告或插件 UI 中导出 `DecisionSet` JSON。
6. `adr apply` 校验工作区未变化，根据被拒绝的行生成 patch，先执行 `git apply --check`，再应用 patch。

## 信任边界

Git 是事实来源。后续可以加入 Agent 会话日志来解释修改意图，但 MVP 不会让某个工具的专用日志覆盖当前工作区 diff。

## 行级决策

所有行初始状态为 `pending`。应用时，`pending` 等价于 `accept`，因此除非用户明确拒绝某一行，否则当前 AI 修改后的工作区内容会被保留。

被拒绝的新增行会被移除。被拒绝的删除行会被恢复。如果一次替换被表示为一行删除和一行新增，用户可以分别接受或拒绝两侧。

## 插件策略

Codex、OpenCode、VS Code 和 Trae 都调用同一个 `adr` 二进制，并消费同一套 JSON schema。插件层不应重新实现 diff 逻辑。
