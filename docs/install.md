# 安装

`agent-diff-review` 由一个核心 CLI `adr` 和多个宿主插件组成。

所有集成都按以下顺序解析 `adr`：

1. `ADR_PATH` 或宿主自己的配置项。
2. 插件内置的 `bin/<platform>/adr` 二进制。
3. `PATH` 中的 `adr`。

## CLI

从 GitHub Release 下载对应平台的压缩包：

```text
adr-v1.1.1-win32-x64.zip
adr-v1.1.1-linux-x64.tar.gz
adr-v1.1.1-darwin-arm64.tar.gz
```

解压后，把包含 `adr` 或 `adr.exe` 的目录加入 `PATH`。

验证：

```bash
adr --version
```

## VS Code

安装对应平台的 VSIX。VSIX 已内置对应平台的 `adr`，普通用户不需要提前安装 `adr`，VS Code 扩展的原生 review 流程也不要求系统安装 Git。

```bash
code --install-extension agent-diff-review-vscode-win32-x64-1.2.2.vsix
```

Windows 用户请按 VS Code 架构选择：

```text
agent-diff-review-vscode-win32-x64-1.2.2.vsix
agent-diff-review-vscode-win32-arm64-1.2.2.vsix
```

然后在命令面板运行：

```text
Agent Diff Review: Open Native Review
Agent Diff Review: Apply Decisions
```

如果想使用自定义 CLI，配置：

```json
{
  "agentDiffReview.adrPath": "/absolute/path/to/adr"
}
```

## OpenCode

安装 npm 插件：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@agent-diff-review/opencode-plugin"]
}
```

插件会暴露 `adr_review` 工具，并在支持的会话事件后写入：

```text
.agent-diff-review/session.json
.agent-diff-review/report.html
```

设置 `ADR_PATH` 可以覆盖内置 CLI。

## Codex

从 release 下载对应平台的 Codex 插件包：

```text
agent-diff-review-codex-v1.1.1-win32-x64.zip
```

插件包包含：

```text
.codex-plugin/plugin.json
skills/review/SKILL.md
scripts/adr-wrapper.mjs
scripts/review.ps1
scripts/review.sh
scripts/apply.ps1
scripts/apply.sh
bin/<platform>/adr
```

安装后，让 Codex 使用 `agent-diff-review` skill 生成或应用 review。设置 `ADR_PATH` 可以覆盖内置 CLI。

## Claude Code

从 release 下载对应平台的 Claude Code 插件包，或者在仓库发布后通过 marketplace 安装：

```text
/plugin marketplace add agent-diff-review/agent-diff-review
/plugin install agent-diff-review@agent-diff-review
/reload-plugins
```

插件提供：

```text
/agent-diff-review:review
/agent-diff-review:apply
```

设置 `ADR_PATH` 可以覆盖内置 CLI。
