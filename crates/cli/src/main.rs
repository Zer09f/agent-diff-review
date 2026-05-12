use agent_diff_core::{DecisionSet, ReviewSession};
use agent_diff_git_patch::{apply_decisions, scan_worktree, ApplyOptions, ScanOptions};
use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "adr")]
#[command(about = "Visual review and line-level accept/reject for AI-generated code changes")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Scan {
        #[arg(long, value_enum, default_value_t = OutputFormat::Json)]
        format: OutputFormat,
        #[arg(long, default_value = ".agent-diff-review/session.json")]
        out: PathBuf,
        #[arg(long, default_value = "HEAD")]
        base: String,
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
    },
    Report {
        #[arg(long, default_value = ".agent-diff-review/session.json")]
        session: PathBuf,
        #[arg(long, default_value = ".agent-diff-review/report.html")]
        out: PathBuf,
    },
    Apply {
        #[arg(long, default_value = ".agent-diff-review/session.json")]
        session: PathBuf,
        #[arg(long, default_value = ".agent-diff-review/decisions.json")]
        decisions: PathBuf,
        #[arg(long)]
        dry_run: bool,
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
    },
}

#[derive(Clone, Debug, ValueEnum)]
enum OutputFormat {
    Json,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Scan {
            format: OutputFormat::Json,
            out,
            base,
            workspace,
        } => {
            let session = scan_worktree(&ScanOptions {
                workspace,
                base_ref: base,
            })?;
            write_json(&out, &session)?;
            println!("Wrote review session to {}", out.display());
            println!(
                "Changed files: {}, risk markers: {}, test impacts: {}",
                session.files.len(),
                session.risk_markers.len(),
                session.test_impacts.len()
            );
        }
        Commands::Report { session, out } => {
            let session: ReviewSession = read_json(&session)?;
            write_text(&out, &render_report(&session))?;
            println!("Wrote review report to {}", out.display());
        }
        Commands::Apply {
            session,
            decisions,
            dry_run,
            workspace,
        } => {
            let session: ReviewSession = read_json(&session)?;
            let decisions: DecisionSet = read_json(&decisions)?;
            let summary = apply_decisions(
                &session,
                &decisions,
                &ApplyOptions {
                    workspace,
                    dry_run,
                },
            )?;
            println!(
                "{} files checked, {} files changed, {} rejected rows{}",
                summary.files_checked,
                summary.files_changed,
                summary.rejected_rows,
                if summary.dry_run { " (dry-run)" } else { "" }
            );
        }
    }
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Result<T> {
    let content = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&content).with_context(|| format!("parse {}", path.display()))
}

fn write_json<T: serde::Serialize>(path: &PathBuf, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(value)?;
    fs::write(path, json).with_context(|| format!("write {}", path.display()))
}

fn write_text(path: &PathBuf, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(path, content).with_context(|| format!("write {}", path.display()))
}

fn render_report(session: &ReviewSession) -> String {
    let session_json = serde_json::to_string(session).expect("session serializes");
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agent-diff-review</title>
  <style>{}</style>
</head>
<body>
  <main id="app"></main>
  <script id="session-data" type="application/json">{}</script>
  <script>{}</script>
</body>
</html>
"#,
        report_css(),
        escape_html(&session_json),
        report_js()
    )
}

fn report_css() -> &'static str {
    r#"
:root {
  color-scheme: light;
  --bg: #f7f7f4;
  --panel: #ffffff;
  --ink: #202124;
  --muted: #6b7280;
  --line: #d6d8dc;
  --add: #e9f8ee;
  --del: #fdecec;
  --accent: #176b87;
  --warn: #a24d05;
  --danger: #b42318;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); }
button, select { font: inherit; }
.shell { min-height: 100vh; display: grid; grid-template-columns: 320px 1fr; }
.sidebar { border-right: 1px solid var(--line); background: #fbfbf9; padding: 16px; overflow: auto; }
.brand { margin: 0 0 4px; font-size: 20px; }
.subtle { color: var(--muted); font-size: 13px; }
.summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 16px 0; }
.metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
.metric strong { display: block; font-size: 20px; }
.file-list { display: flex; flex-direction: column; gap: 6px; }
.file-button { width: 100%; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 10px; text-align: left; cursor: pointer; }
.file-button.active { border-color: var(--accent); outline: 2px solid rgba(23, 107, 135, .18); }
.file-path { font-size: 13px; overflow-wrap: anywhere; }
.file-meta { display: flex; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--muted); }
.content { min-width: 0; padding: 20px; overflow: auto; }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.primary { background: var(--accent); color: white; border: 1px solid var(--accent); border-radius: 6px; padding: 8px 12px; cursor: pointer; }
.secondary { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; cursor: pointer; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; min-width: 0; }
.panel h2 { margin: 0 0 10px; font-size: 15px; }
.risk { border-left: 3px solid var(--warn); padding-left: 8px; margin: 8px 0; font-size: 13px; }
.risk.high { border-left-color: var(--danger); }
.edge, .impact { font-size: 13px; margin: 6px 0; overflow-wrap: anywhere; }
.diff { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--panel); }
.hunk-header { background: #ecefeb; color: #41464d; padding: 8px 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.row { display: grid; grid-template-columns: 68px 68px 1fr 150px; min-height: 30px; border-top: 1px solid #eceff1; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
.row.added { background: var(--add); }
.row.deleted { background: var(--del); }
.line-no { color: var(--muted); padding: 6px 8px; text-align: right; user-select: none; }
.code { white-space: pre-wrap; overflow-wrap: anywhere; padding: 6px 8px; }
.decision { padding: 4px 8px; display: flex; justify-content: flex-end; }
.decision select { width: 130px; border: 1px solid var(--line); border-radius: 6px; background: white; padding: 2px 6px; }
.empty { padding: 32px; text-align: center; color: var(--muted); }
@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar { border-right: 0; border-bottom: 1px solid var(--line); }
  .grid { grid-template-columns: 1fr; }
  .row { grid-template-columns: 48px 48px 1fr; }
  .decision { grid-column: 1 / -1; justify-content: flex-start; }
}
"#
}

fn report_js() -> &'static str {
    r#"
const session = JSON.parse(document.getElementById('session-data').textContent);
const decisions = new Map();
let selectedFileId = session.files[0]?.fileId ?? null;
let vscodeApi = null;

function key(fileId, hunkId, rowId) {
  return `${fileId}:${hunkId}:${rowId}`;
}

function setDecision(fileId, hunkId, rowId, decision) {
  decisions.set(key(fileId, hunkId, rowId), { fileId, hunkId, rowId, decision });
  render();
}

function setFileDecision(file, decision) {
  for (const hunk of file.hunks) {
    for (const row of hunk.rows) {
      if (row.kind !== 'context') {
        decisions.set(key(file.fileId, hunk.hunkId, row.rowId), {
          fileId: file.fileId,
          hunkId: hunk.hunkId,
          rowId: row.rowId,
          decision
        });
      }
    }
  }
  render();
}

function exportDecisions() {
  const payload = {
    schemaVersion: '0.1.0',
    sessionWorktreeHash: session.worktreeHash,
    decisions: Array.from(decisions.values())
  };
  saveDecisionSetToHost(payload);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'decisions.json';
  a.click();
  URL.revokeObjectURL(url);
}

function saveDecisionSetToHost(payload) {
  if (typeof acquireVsCodeApi !== 'function') {
    return;
  }
  try {
    vscodeApi = vscodeApi ?? acquireVsCodeApi();
    vscodeApi.postMessage({ type: 'saveDecisionSet', payload });
  } catch (_) {
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function selectedFile() {
  return session.files.find(file => file.fileId === selectedFileId) ?? session.files[0] ?? null;
}

function render() {
  const file = selectedFile();
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <h1 class="brand">agent-diff-review</h1>
        <div class="subtle">${escapeHtml(session.headRef)} - ${escapeHtml(session.createdAt)}</div>
        <div class="summary">
          <div class="metric"><strong>${session.files.length}</strong><span>files</span></div>
          <div class="metric"><strong>${session.riskMarkers.length}</strong><span>risks</span></div>
          <div class="metric"><strong>${session.testImpacts.length}</strong><span>tests</span></div>
        </div>
        <div class="file-list">
          ${session.files.map(item => `
            <button class="file-button ${item.fileId === file?.fileId ? 'active' : ''}" data-file-id="${item.fileId}">
              <div class="file-path">${escapeHtml(item.path)}</div>
              <div class="file-meta"><span>+${item.additions}</span><span>-${item.deletions}</span><span>${escapeHtml(item.changeType)}</span></div>
            </button>
          `).join('')}
        </div>
      </aside>
      <section class="content">
        ${file ? renderFile(file) : '<div class="empty">No worktree changes found.</div>'}
      </section>
    </div>
  `;
  for (const button of document.querySelectorAll('[data-file-id]')) {
    button.addEventListener('click', () => {
      selectedFileId = button.dataset.fileId;
      render();
    });
  }
  for (const select of document.querySelectorAll('[data-row-id]')) {
    select.addEventListener('change', () => {
      setDecision(select.dataset.fileId, select.dataset.hunkId, select.dataset.rowId, select.value);
    });
  }
  document.querySelector('[data-export]')?.addEventListener('click', exportDecisions);
  document.querySelector('[data-accept-file]')?.addEventListener('click', () => setFileDecision(file, 'accept'));
  document.querySelector('[data-reject-file]')?.addEventListener('click', () => setFileDecision(file, 'reject'));
}

function renderFile(file) {
  const risks = session.riskMarkers.filter(risk => risk.fileId === file.fileId);
  const edges = session.dependencyEdges.filter(edge => edge.from === file.path || edge.to === file.path);
  const impacts = session.testImpacts.filter(impact => impact.sourceFileId === file.fileId || impact.testFileId === file.fileId);
  return `
    <div class="toolbar">
      <div>
        <h1 class="brand">${escapeHtml(file.path)}</h1>
        <div class="subtle">${escapeHtml(file.changeType)} - +${file.additions} -${file.deletions}</div>
      </div>
      <div class="actions">
        <button class="secondary" data-accept-file>Accept file</button>
        <button class="secondary" data-reject-file>Reject file</button>
        <button class="primary" data-export>Export decisions</button>
      </div>
    </div>
    <div class="grid">
      <div class="panel">
        <h2>Risks</h2>
        ${risks.length ? risks.map(risk => `<div class="risk ${risk.level}"><strong>${escapeHtml(risk.level)}</strong> ${escapeHtml(risk.message)}</div>`).join('') : '<div class="subtle">No risk markers for this file.</div>'}
      </div>
      <div class="panel">
        <h2>Dependency and Test Impact</h2>
        ${edges.length ? edges.map(edge => `<div class="edge">${escapeHtml(edge.from)} -> ${escapeHtml(edge.to)}</div>`).join('') : '<div class="subtle">No changed-file dependency edges.</div>'}
        ${impacts.length ? impacts.map(impact => `<div class="impact">${escapeHtml(impact.message)}</div>`).join('') : '<div class="subtle">No test impact signal.</div>'}
      </div>
    </div>
    <div class="diff">
      ${file.hunks.length ? file.hunks.map(hunk => renderHunk(file, hunk)).join('') : '<div class="empty">This change is file-level only.</div>'}
    </div>
  `;
}

function renderHunk(file, hunk) {
  return `
    <div class="hunk">
      <div class="hunk-header">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${escapeHtml(hunk.header)}</div>
      ${hunk.rows.map(row => renderRow(file, hunk, row)).join('')}
    </div>
  `;
}

function renderRow(file, hunk, row) {
  const decision = decisions.get(key(file.fileId, hunk.hunkId, row.rowId))?.decision ?? row.decision ?? 'pending';
  const editable = row.kind !== 'context';
  const prefix = row.kind === 'added' ? '+' : row.kind === 'deleted' ? '-' : ' ';
  return `
    <div class="row ${row.kind}">
      <div class="line-no">${row.oldLine ?? ''}</div>
      <div class="line-no">${row.newLine ?? ''}</div>
      <div class="code">${prefix}${escapeHtml(row.content)}</div>
      <div class="decision">
        ${editable ? `
          <select data-file-id="${file.fileId}" data-hunk-id="${hunk.hunkId}" data-row-id="${row.rowId}">
            <option value="pending" ${decision === 'pending' ? 'selected' : ''}>pending</option>
            <option value="accept" ${decision === 'accept' ? 'selected' : ''}>accept</option>
            <option value="reject" ${decision === 'reject' ? 'selected' : ''}>reject</option>
          </select>
        ` : ''}
      </div>
    </div>
  `;
}

render();
"#
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
