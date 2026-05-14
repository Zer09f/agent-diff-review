# 分发

本项目采用“一个核心二进制 + 多个宿主插件包”的分发模型。

## 核心规则

只有 `adr` 负责 Git diff 扫描、风险分析、报告生成和 apply 行为。VS Code、Codex、OpenCode 和 Claude Code 包装层只负责定位二进制并调用它。

## 平台 Key

```text
win32-x64
win32-arm64
linux-x64
linux-arm64
darwin-x64
darwin-arm64
```

插件内置二进制路径：

```text
bin/<platform>/adr
bin/<platform>/adr.exe
```

## 本地 Release 构建

生成面向当前平台的完整下载包：

```bash
npm run package:downloads
```

产物目录：

```text
dist/release
```

包含：

```text
adr-v<version>-<platform>.zip
agent-diff-review-vscode-<platform>-<version>.vsix
agent-diff-review-opencode-plugin-<version>.tgz
agent-diff-review-codex-v<version>-<platform>.zip
agent-diff-review-claude-v<version>-<platform>.zip
SHA256SUMS
```

只生成 CLI、Codex 和 Claude Code 包：

```bash
npm run build:release
```

该命令会：

1. 执行 `cargo build --release -p adr` 构建 `adr`。
2. 在 `dist/release` 生成 CLI 压缩包。
3. 把当前平台二进制复制到 VS Code、OpenCode、Codex 和 Claude Code 插件目录。
4. 打包包含内置二进制的 Codex 和 Claude Code 插件 zip。
5. 写入 `dist/release/SHA256SUMS`。

如果已经有某个平台的二进制，可以单独同步：

```bash
npm run sync:binaries -- --platform win32-x64 --source target/release/adr.exe
```

## GitHub Release 流程

release workflow 会构建：

- 支持平台的 CLI 压缩包。
- 平台专属 VSIX。
- 支持平台的 Codex 插件 zip。
- 支持平台的 Claude Code 插件 zip。
- release 文件校验和。

workflow 通过 `v*.*.*` tag 或手动 `workflow_dispatch` 触发。

## 发布检查清单

1. 更新 `package.json`、Rust crate manifest、VS Code package、OpenCode package、Codex manifest 和 Claude manifest 中的版本号。
2. 运行 `cargo test`。
3. 运行 `npm run typecheck`。
4. 运行 `npm run build`。
5. 运行 `npm run build:release`。
6. 从 release 压缩包验证 `adr --version`。
7. 在没有全局 `adr` 的机器上安装 VSIX 并验证。
8. 验证 OpenCode 插件使用内置 `adr`。
9. 验证 Codex skill 使用内置 `adr`。
10. 验证 Claude Code command 使用内置 `adr`。
11. 打 tag 发布：

```bash
git tag v0.1.0
git push origin v0.1.0
```
