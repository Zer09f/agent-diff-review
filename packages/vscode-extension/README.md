# agent-diff-review VS Code 扩展

面向 AI 代码变更的原生 review 扩展，直接在 VS Code 源文件编辑器中标记 Git 工作区修改。

## 命令

- `Agent Diff Review: Open Native Review`
- `Agent Diff Review: Apply Decisions`

运行 `Open Native Review` 后，扩展会扫描当前 Git 工作区并打开变更文件：

- 绿色表示新增内容。
- 黄色表示替换后的当前内容。
- 红色虚拟文本表示被删除的旧内容。
- 每个连续变更块上方提供 `Accept block` / `Reject block` CodeLens。
- 文件顶部提供 `Accept file` / `Reject file` CodeLens。

`Reject block` 和 `Reject file` 会直接修改源文件。扩展会优先使用内置 `adr` 二进制。需要自定义路径时，可以配置 `agentDiffReview.adrPath`。
