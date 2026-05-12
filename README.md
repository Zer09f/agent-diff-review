# agent-diff-review

面向 AI 代码变更的可视化 review 工具，支持逐行接受或拒绝修改。

AI 编程 Agent 经常会在一次任务中修改多个文件。`agent-diff-review` 用来帮助开发者在接受这些修改前快速理解影响范围：它会展示变更文件、标记高风险区域、显示依赖影响、给出测试相关信号，并让人类逐行决定接受或拒绝。

命令行二进制名称是 `adr`。

## 功能

- 展示当前 Git 工作区中被修改的所有文件。
- 为 TS/JS 和 Java 变更文件生成依赖关系图。
- 标记认证、配置、锁文件、公共 API、大规模删除、测试删除等高风险修改。
- MVP 阶段不主动运行测试，只展示测试影响信号。
- 支持逐行接受或拒绝变更，并将选择结果应用回工作区。
- 提供 Codex、OpenCode、VS Code，以及 Trae 兼容 VSIX 的集成入口。

## 快速开始

```bash
adr scan --format json --out .agent-diff-review/session.json
adr report --session .agent-diff-review/session.json --out .agent-diff-review/report.html
adr apply --session .agent-diff-review/session.json --decisions .agent-diff-review/decisions.json --dry-run
adr apply --session .agent-diff-review/session.json --decisions .agent-diff-review/decisions.json
```

打开 `.agent-diff-review/report.html`，对变更行选择 accept/reject，导出 decision 文件，然后使用 `adr apply` 应用。

`pending` 行默认按 `accept` 处理，因此工具只会改写被明确拒绝的行。

## 工作区结构

```text
crates/core               共享 review 数据模型、风险规则、依赖分析、测试影响
crates/git_patch          Git diff 扫描、行映射、patch 生成、apply 校验
crates/cli                adr 命令行入口和 HTML 报告生成
packages/ui               共享 React/Vite review UI
packages/opencode-plugin  OpenCode 插件入口
packages/vscode-extension VS Code 扩展，可通过 VSIX 兼容 Trae
plugins/codex             Codex 插件包
schemas                   公共 JSON schema
docs                      架构说明
```

## 路线图

- v0.1：CLI、独立 HTML 报告、Codex 插件、OpenCode 插件。
- v0.2：VS Code 扩展和 Trae VSIX 分发。
- v0.3：解析真实覆盖率报告，支持 lcov、cobertura、jacoco。
- v0.4：加入 Agent 会话日志解释层。

## 当前状态

该仓库包含第一版 MVP 实现骨架。Rust 核心负责事实来源和 patch 应用，TypeScript 包负责围绕核心能力提供 UI 和插件集成层。
