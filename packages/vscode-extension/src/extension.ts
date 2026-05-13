import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

const SESSION_PATH = '.agent-diff-review/session.json';
const REPORT_PATH = '.agent-diff-review/report.html';
const DECISIONS_PATH = '.agent-diff-review/decisions.json';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentDiffReview.open', () => openReview(context)),
    vscode.commands.registerCommand('agentDiffReview.applyDecisions', () => applyDecisions(context))
  );
}

export function deactivate() {}

async function openReview(context: vscode.ExtensionContext) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open a workspace folder before running agent-diff-review.');
    return;
  }

  await runAdr(context, root, ['scan', '--format', 'json', '--out', SESSION_PATH]);
  await runAdr(context, root, ['report', '--session', SESSION_PATH, '--out', REPORT_PATH]);

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

async function applyDecisions(context: vscode.ExtensionContext) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open a workspace folder before running agent-diff-review.');
    return;
  }
  await runAdr(context, root, ['apply', '--session', SESSION_PATH, '--decisions', DECISIONS_PATH, '--dry-run']);
  await runAdr(context, root, ['apply', '--session', SESSION_PATH, '--decisions', DECISIONS_PATH]);
  vscode.window.showInformationMessage('agent-diff-review decisions applied.');
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function adrPath(context: vscode.ExtensionContext) {
  const configured = vscode.workspace.getConfiguration('agentDiffReview').get<string>('adrPath')?.trim();
  if (configured) {
    return configured;
  }

  const bundled = bundledAdrPath(context.extensionPath);
  return bundled ?? 'adr';
}

function bundledAdrPath(extensionPath: string) {
  const platform = platformKey();
  if (!platform) {
    return undefined;
  }

  const executable = process.platform === 'win32' ? 'adr.exe' : 'adr';
  const candidate = path.join(extensionPath, 'bin', platform, executable);
  return existsSync(candidate) ? candidate : undefined;
}

function platformKey() {
  const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined;
  if (!arch) {
    return undefined;
  }

  switch (process.platform) {
    case 'win32':
      return `win32-${arch}`;
    case 'linux':
      return `linux-${arch}`;
    case 'darwin':
      return `darwin-${arch}`;
    default:
      return undefined;
  }
}

function runAdr(context: vscode.ExtensionContext, cwd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const command = adrPath(context);
    const child = spawn(command, args, { cwd, shell: process.platform === 'win32' && !path.isAbsolute(command) });
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
