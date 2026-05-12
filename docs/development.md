# 开发说明

## 前置条件

- Rust stable，并包含 `cargo`
- Node.js 20 或更高版本
- Git

## 构建

```bash
cargo test
npm install
npm run typecheck
npm run build
```

## 手动冒烟测试

在任意存在本地修改的 Git 仓库中执行：

```bash
cargo run -p adr -- scan --format json --out .agent-diff-review/session.json
cargo run -p adr -- report --session .agent-diff-review/session.json --out .agent-diff-review/report.html
```

打开 `.agent-diff-review/report.html`，拒绝几行修改，导出 `decisions.json`，然后执行：

```bash
cargo run -p adr -- apply --session .agent-diff-review/session.json --decisions .agent-diff-review/decisions.json --dry-run
```

如果 dry-run 摘要符合预期，去掉 `--dry-run` 即可真正应用。
