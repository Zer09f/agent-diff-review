# agent-diff-review

面向 AI 代码变更的可视化 review 工具，支持逐行接受或拒绝修改。

AI 编程 Agent 经常会在一次任务中修改多个文件。`agent-diff-review` 会扫描当前 Git 工作区，生成独立 HTML review 报告，标记高风险区域，并允许人工在应用结果前逐行拒绝不需要的变更。

命令行二进制名称是 `adr`。

## 功能

- 展示当前 Git 工作区中的变更文件。
- 为 diff 中的变更行生成稳定 `rowId`。
- 标记认证、配置、锁文件、公共 API、大规模删除、测试删除等高风险变更。
- 为 TS/JS 和 Java 变更展示依赖关系与测试影响信号。
- 生成可独立打开的 HTML review 报告。
- 根据逐行 accept/reject 决策把结果应用回工作区。
- 提供 CLI、VS Code、Codex、OpenCode、Claude Code 集成入口。

## 快速开始

```bash
adr scan --format json --out .agent-diff-review/session.json
adr report --session .agent-diff-review/session.json --out .agent-diff-review/report.html
adr apply --session .agent-diff-review/session.json --decisions .agent-diff-review/decisions.json --dry-run
adr apply --session .agent-diff-review/session.json --decisions .agent-diff-review/decisions.json
```

打开 `.agent-diff-review/report.html`，对变更行选择 accept/reject，导出 `decisions.json`，然后执行 `adr apply`。

`pending` 行默认等同于 accept。也就是说，只有明确 reject 的行会改变当前工作区内容。

## 安装

完整安装方式见 [docs/install.md](docs/install.md)，覆盖 CLI、VS Code、Codex、OpenCode 和 Claude Code。

## 仓库结构

```text
crates/core               共享 review 数据模型、风险规则、依赖分析和测试影响信号
crates/git_patch          Git diff 扫描、行映射、patch 生成和 apply 校验
crates/cli                adr 命令行入口和 HTML 报告生成
packages/ui               共享 React/Vite review UI
packages/opencode-plugin  OpenCode 插件入口
packages/vscode-extension VS Code 扩展，可通过 VSIX 兼容编辑器分发
plugins/codex             Codex 插件包
plugins/claude            Claude Code 插件包
schemas                   公共 JSON schema
docs                      架构、开发和分发文档
```

## 分发模型

所有集成都调用同一个 `adr` 二进制。插件层只负责定位二进制并调用它，不重新实现 diff 或 patch 逻辑。

各集成按以下顺序解析 `adr`：

1. 用户显式配置的路径，例如 `ADR_PATH` 或扩展设置。
2. 插件内置的 `bin/<platform>/adr` 二进制。
3. `PATH` 中的 `adr`。

支持的平台 key：

```text
win32-x64
win32-arm64
linux-x64
linux-arm64
darwin-x64
darwin-arm64
```

## 开发

```bash
cargo test
npm run typecheck
npm run build
```

为当前平台构建本地 release 包：

```bash
npm run build:release
```
