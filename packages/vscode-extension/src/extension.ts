import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

const SESSION_PATH = '.agent-diff-review/session.json';
const REPORT_PATH = '.agent-diff-review/report.html';
const DECISIONS_PATH = '.agent-diff-review/decisions.json';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentDiffReview.open', openReview),
    vscode.commands.registerCommand('agentDiffReview.applyDecisions', applyDecisions)
  );
}

export function deactivate() {}

async function openReview() {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open a workspace folder before running agent-diff-review.');
    return;
  }

  await runAdr(root, ['scan', '--format', 'json', '--out', SESSION_PATH]);
  await runAdr(root, ['report', '--session', SESSION_PATH, '--out', REPORT_PATH]);

  const reportHtml = await fs.readFile(path.join(root, REPORT_PATH), 'utf8');
  const panel = vscode.window.createWebviewPanel(
    'agentDiffReview',
    'agent-diff-review',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = patchReportForWebview(reportHtml, panel.webview, root);
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type === 'saveDecisionSet') {
      await fs.mkdir(path.join(root, '.agent-diff-review'), { recursive: true });
      await fs.writeFile(path.join(root, DECISIONS_PATH), JSON.stringify(message.payload, null, 2));
      vscode.window.showInformationMessage(`Saved ${DECISIONS_PATH}`);
    }
  });
}

async function applyDecisions() {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open a workspace folder before running agent-diff-review.');
    return;
  }
  await runAdr(root, ['apply', '--session', SESSION_PATH, '--decisions', DECISIONS_PATH, '--dry-run']);
  await runAdr(root, ['apply', '--session', SESSION_PATH, '--decisions', DECISIONS_PATH]);
  vscode.window.showInformationMessage('agent-diff-review decisions applied.');
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function adrPath() {
  return vscode.workspace.getConfiguration('agentDiffReview').get<string>('adrPath') || 'adr';
}

function runAdr(cwd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(adrPath(), args, { cwd, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        if (stdout.trim()) {
          console.log(stdout.trim());
        }
        resolve();
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `adr exited with ${code}`));
      }
    });
  });
}

function patchReportForWebview(html: string, webview: vscode.Webview, root: string) {
  const csp = `
    <meta http-equiv="Content-Security-Policy" content="
      default-src 'none';
      img-src ${webview.cspSource} data:;
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src ${webview.cspSource} 'unsafe-inline';
    ">
  `;
  return html.replace('</head>', `${csp}</head>`).replaceAll(root, '');
}
