import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

const SESSION_PATH = '.agent-diff-review/session.json';
const DECISIONS_PATH = '.agent-diff-review/decisions.json';
const BASELINE_PATH = '.agent-diff-review/baseline.json';
const DEFAULT_AUTO_REVIEW_DELAY_MS = 1000;

type RowKind = 'context' | 'added' | 'deleted';
type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';
type ReviewSource = 'git' | 'snapshot';

interface ReviewSession {
  schemaVersion: string;
  workspaceRoot: string;
  baseRef: string;
  headRef: string;
  createdAt: string;
  worktreeHash: string;
  source?: ReviewSource | null;
  baselineId?: string | null;
  baselineHash?: string | null;
  trackedPaths?: string[];
  files: ChangedFile[];
}

interface ChangedFile {
  fileId: string;
  path: string;
  oldPath: string | null;
  changeType: ChangeType;
  binary: boolean;
  fileDecisionOnly: boolean;
  additions: number;
  deletions: number;
  beforeContent: string | null;
  afterContent: string | null;
  hunks: DiffHunk[];
}

interface DiffHunk {
  hunkId: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  rows: DiffRow[];
}

interface DiffRow {
  rowId: string;
  kind: RowKind;
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

interface BlockCommandArgs {
  fileId: string;
  hunkId: string;
  blockId: string;
}

interface FileCommandArgs {
  fileId: string;
}

interface ReviewBlock {
  blockId: string;
  hunkId: string;
  rows: DiffRow[];
  anchorLine: number;
}

const acceptedBlocks = new Map<string, string>();
let currentSession: ReviewSession | undefined;
let autoReviewTimer: ReturnType<typeof setTimeout> | undefined;
let autoReviewInFlight: Promise<ReviewSession | undefined> | undefined;
let autoReviewQueued = false;
let lastSilentError: string | undefined;

const addedDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: 'rgba(46, 160, 67, 0.24)',
  overviewRulerColor: 'rgba(46, 160, 67, 0.9)',
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  border: '1px solid rgba(46, 160, 67, 0.35)'
});

const changedDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: 'rgba(187, 128, 9, 0.18)',
  overviewRulerColor: 'rgba(187, 128, 9, 0.85)',
  overviewRulerLane: vscode.OverviewRulerLane.Right
});

const deletedDecoration = vscode.window.createTextEditorDecorationType({
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  before: {
    color: 'rgba(255, 180, 180, 0.96)',
    backgroundColor: 'rgba(248, 81, 73, 0.22)',
    border: '1px solid rgba(248, 81, 73, 0.45)',
    margin: '0 0 0 0',
    fontStyle: 'normal'
  },
  overviewRulerColor: 'rgba(248, 81, 73, 0.9)',
  overviewRulerLane: vscode.OverviewRulerLane.Right
});

class ReviewCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  refresh() {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  dispose() {
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const file = fileForDocument(document);
    if (!file || file.binary || file.fileDecisionOnly) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    const firstLine = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(firstLine, {
        title: 'Accept file',
        command: 'agentDiffReview.acceptFile',
        arguments: [{ fileId: file.fileId } satisfies FileCommandArgs]
      }),
      new vscode.CodeLens(firstLine, {
        title: 'Reject file',
        command: 'agentDiffReview.rejectFile',
        arguments: [{ fileId: file.fileId } satisfies FileCommandArgs]
      })
    );

    for (const block of fileBlocks(file)) {
      if (isBlockAccepted(file, block)) {
        continue;
      }
      const line = clampLine(document, block.anchorLine - 1);
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: `Accept block (+${addedCount(block.rows)} -${deletedCount(block.rows)})`,
          command: 'agentDiffReview.acceptBlock',
          arguments: [{ fileId: file.fileId, hunkId: block.hunkId, blockId: block.blockId } satisfies BlockCommandArgs]
        }),
        new vscode.CodeLens(range, {
          title: 'Reject block',
          command: 'agentDiffReview.rejectBlock',
          arguments: [{ fileId: file.fileId, hunkId: block.hunkId, blockId: block.blockId } satisfies BlockCommandArgs]
        })
      );
    }

    return lenses;
  }
}

let codeLensProvider: ReviewCodeLensProvider;

export function activate(context: vscode.ExtensionContext) {
  codeLensProvider = new ReviewCodeLensProvider();
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(
    addedDecoration,
    changedDecoration,
    deletedDecoration,
    codeLensProvider,
    fileWatcher,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      scheduleAutoReview(context);
      applyDecorationsToVisibleEditors();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleAutoReview(context)),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isWorkspaceDocument(document)) {
        scheduleAutoReview(context);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isWorkspaceDocument(document)) {
        scheduleAutoReview(context, 250);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      applyDecorations(event.document);
      if (isWorkspaceDocument(event.document) && !event.document.isDirty) {
        scheduleAutoReview(context);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      currentSession = undefined;
      acceptedBlocks.clear();
      scheduleAutoReview(context, 250);
      applyDecorationsToVisibleEditors();
      codeLensProvider.refresh();
    }),
    fileWatcher.onDidChange((uri) => scheduleAutoReviewForUri(context, uri)),
    fileWatcher.onDidCreate((uri) => scheduleAutoReviewForUri(context, uri)),
    fileWatcher.onDidDelete((uri) => scheduleAutoReviewForUri(context, uri)),
    vscode.commands.registerCommand('agentDiffReview.open', () => openNativeReview(context)),
    vscode.commands.registerCommand('agentDiffReview.applyDecisions', () => applyDecisions(context)),
    vscode.commands.registerCommand('agentDiffReview.acceptBlock', (args: BlockCommandArgs) => acceptBlock(args)),
    vscode.commands.registerCommand('agentDiffReview.rejectBlock', (args: BlockCommandArgs) => rejectBlock(args)),
    vscode.commands.registerCommand('agentDiffReview.acceptFile', (args: FileCommandArgs) => acceptFile(context, args)),
    vscode.commands.registerCommand('agentDiffReview.rejectFile', (args: FileCommandArgs) => rejectFile(context, args))
  );

  scheduleAutoReview(context, 250);
}

export function deactivate() {}

async function openNativeReview(context: vscode.ExtensionContext) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open a workspace folder before running agent-diff-review.');
    return;
  }

  const session = await refreshReviewSession(context, { silent: false });
  if (!session) {
    return;
  }
  acceptedBlocks.clear();

  const reviewable = session.files.filter((file) => isReviewableFile(file));
  if (reviewable.length === 0) {
    vscode.window.showInformationMessage('agent-diff-review found no reviewable text changes.');
    applyDecorationsToVisibleEditors();
    codeLensProvider.refresh();
    return;
  }

  const selected = await pickFile(reviewable);
  if (!selected) {
    return;
  }

  await openFile(selected);
  applyDecorationsToVisibleEditors();
  codeLensProvider.refresh();
  vscode.window.showInformationMessage('agent-diff-review native review is ready. Use Accept/Reject CodeLens actions above each hunk.');
}

async function applyDecisions(context: vscode.ExtensionContext) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open a workspace folder before running agent-diff-review.');
    return;
  }
  await runAdr(context, root, [
    'apply',
    '--source',
    'snapshot',
    '--session',
    SESSION_PATH,
    '--decisions',
    DECISIONS_PATH,
    '--baseline',
    BASELINE_PATH,
    '--dry-run'
  ]);
  await runAdr(context, root, [
    'apply',
    '--source',
    'snapshot',
    '--session',
    SESSION_PATH,
    '--decisions',
    DECISIONS_PATH,
    '--baseline',
    BASELINE_PATH
  ]);
  vscode.window.showInformationMessage('agent-diff-review decisions applied.');
}

function scheduleAutoReview(context: vscode.ExtensionContext, delayMs = autoReviewDelayMs()) {
  if (!autoReviewEnabled() || !hasVisibleWorkspaceDocument()) {
    return;
  }

  if (autoReviewTimer) {
    clearTimeout(autoReviewTimer);
  }

  autoReviewTimer = setTimeout(() => {
    autoReviewTimer = undefined;
    void refreshReviewSession(context, { silent: true });
  }, Math.max(250, delayMs));
}

function scheduleAutoReviewForUri(context: vscode.ExtensionContext, uri: vscode.Uri) {
  if (isWorkspaceFileUri(uri)) {
    scheduleAutoReview(context);
  }
}

async function refreshReviewSession(context: vscode.ExtensionContext, options: { silent: boolean }) {
  const root = workspaceRoot();
  if (!root) {
    return undefined;
  }

  if (autoReviewInFlight) {
    autoReviewQueued = true;
    if (options.silent) {
      return undefined;
    }
    await autoReviewInFlight;
  }

  autoReviewInFlight = (async () => {
    try {
      await ensureSnapshotBaseline(context, root);
      await runAdr(context, root, [
        'scan',
        '--source',
        'snapshot',
        '--format',
        'json',
        '--out',
        SESSION_PATH,
        '--baseline',
        BASELINE_PATH
      ]);
      const session = await readSession(root);
      currentSession = session;
      lastSilentError = undefined;
      applyDecorationsToVisibleEditors();
      codeLensProvider.refresh();
      return session;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.silent) {
        if (message !== lastSilentError) {
          console.warn(`agent-diff-review auto review failed: ${message}`);
          lastSilentError = message;
        }
        return undefined;
      }
      vscode.window.showErrorMessage(`agent-diff-review failed: ${message}`);
      return undefined;
    } finally {
      autoReviewInFlight = undefined;
      if (autoReviewQueued) {
        autoReviewQueued = false;
        scheduleAutoReview(context, 250);
      }
    }
  })();

  return autoReviewInFlight;
}

async function ensureSnapshotBaseline(context: vscode.ExtensionContext, root: string) {
  if (existsSync(path.join(root, BASELINE_PATH))) {
    return;
  }
  await runAdr(context, root, ['snapshot', 'init', '--baseline', BASELINE_PATH]);
}

async function refreshSnapshotBaseline(context: vscode.ExtensionContext) {
  const root = workspaceRoot();
  if (!root) {
    return;
  }
  await runAdr(context, root, ['snapshot', 'init', '--baseline', BASELINE_PATH, '--force']);
  await refreshReviewSession(context, { silent: true });
}

async function acceptBlock(args: BlockCommandArgs) {
  const file = fileById(args.fileId);
  const block = file ? blockById(file, args.blockId) : undefined;
  if (!file || !block) {
    return;
  }
  await saveFileIfOpen(file);
  markBlockAccepted(file, block);
  applyDecorationsToVisibleEditors();
  codeLensProvider.refresh();
}

async function rejectBlock(args: BlockCommandArgs) {
  const file = fileById(args.fileId);
  const block = file ? blockById(file, args.blockId) : undefined;
  if (!file || !block) {
    return;
  }

  const editor = await openFile(file);
  const success = await replaceBlockWithOldSide(editor, block);
  if (success) {
    await editor.document.save();
    markBlockAccepted(file, block);
    applyDecorationsToVisibleEditors();
    codeLensProvider.refresh();
  }
}

async function acceptFile(context: vscode.ExtensionContext, args: FileCommandArgs) {
  const file = fileById(args.fileId);
  if (!file) {
    return;
  }
  await saveFileIfOpen(file);
  for (const block of fileBlocks(file)) {
    markBlockAccepted(file, block);
  }
  await refreshSnapshotBaseline(context);
  applyDecorationsToVisibleEditors();
  codeLensProvider.refresh();
}

async function rejectFile(context: vscode.ExtensionContext, args: FileCommandArgs) {
  const file = fileById(args.fileId);
  if (!file) {
    return;
  }

  const editor = await openFile(file);
  const blocks = fileBlocks(file).sort((a, b) => b.anchorLine - a.anchorLine);
  for (const block of blocks) {
    await replaceBlockWithOldSide(editor, block);
    markBlockAccepted(file, block);
  }
  await editor.document.save();
  await refreshSnapshotBaseline(context);
  applyDecorationsToVisibleEditors();
  codeLensProvider.refresh();
}

async function replaceBlockWithOldSide(editor: vscode.TextEditor, block: ReviewBlock) {
  const document = editor.document;
  const replacement = oldSideText(document, block);
  const range = blockRange(document, block);
  return editor.edit((edit) => {
    edit.replace(range, replacement);
  });
}

function oldSideText(document: vscode.TextDocument, block: ReviewBlock) {
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const lines = block.rows
    .filter((row) => row.kind === 'deleted')
    .map((row) => row.content);
  if (lines.length === 0) {
    return '';
  }
  return `${lines.join(eol)}${eol}`;
}

function blockRange(document: vscode.TextDocument, block: ReviewBlock) {
  const addedRows = block.rows.filter((row) => row.kind === 'added' && row.newLine);
  if (addedRows.length === 0) {
    const position = new vscode.Position(clampLine(document, block.anchorLine - 1), 0);
    return new vscode.Range(position, position);
  }

  const startLine = clampLine(document, (addedRows[0].newLine ?? block.anchorLine) - 1);
  const lastAdded = addedRows[addedRows.length - 1];
  const endLine = clampLine(document, (lastAdded.newLine ?? block.anchorLine) - 1);
  return new vscode.Range(new vscode.Position(startLine, 0), document.lineAt(endLine).rangeIncludingLineBreak.end);
}

function applyDecorationsToVisibleEditors() {
  for (const editor of vscode.window.visibleTextEditors) {
    applyDecorations(editor.document);
  }
}

function applyDecorations(document: vscode.TextDocument) {
  const editor = vscode.window.visibleTextEditors.find((item) => item.document.uri.toString() === document.uri.toString());
  if (!editor) {
    return;
  }

  const file = fileForDocument(document);
  if (!file || file.binary || file.fileDecisionOnly) {
    editor.setDecorations(addedDecoration, []);
    editor.setDecorations(changedDecoration, []);
    editor.setDecorations(deletedDecoration, []);
    return;
  }

  const added: vscode.DecorationOptions[] = [];
  const changed: vscode.DecorationOptions[] = [];
  const deleted: vscode.DecorationOptions[] = [];

  for (const block of fileBlocks(file)) {
    if (isBlockAccepted(file, block)) {
      continue;
    }

    const hasDeleted = block.rows.some((row) => row.kind === 'deleted');
    for (const row of block.rows) {
      if (row.kind === 'added' && row.newLine) {
        const line = clampLine(document, row.newLine - 1);
        const range = document.lineAt(line).range;
        (hasDeleted ? changed : added).push({
          range,
          hoverMessage: new vscode.MarkdownString('agent-diff-review: added/current line')
        });
      }
    }

    const deletedLines = block.rows.filter((row) => row.kind === 'deleted');
    if (deletedLines.length > 0) {
      const anchor = clampLine(document, block.anchorLine - 1);
      for (const group of chunkDeletedLines(deletedLines)) {
        deleted.push({
          range: new vscode.Range(anchor, 0, anchor, 0),
          hoverMessage: new vscode.MarkdownString('agent-diff-review: deleted/old line'),
          renderOptions: {
            before: {
              contentText: group,
              color: 'rgba(255, 180, 180, 0.96)',
              backgroundColor: 'rgba(248, 81, 73, 0.22)'
            }
          }
        });
      }
    }
  }

  editor.setDecorations(addedDecoration, added);
  editor.setDecorations(changedDecoration, changed);
  editor.setDecorations(deletedDecoration, deleted);
}

function chunkDeletedLines(rows: DiffRow[]) {
  return rows.map((row) => `- ${row.content}`);
}

async function readSession(root: string) {
  const content = await fs.readFile(path.join(root, SESSION_PATH), 'utf8');
  return JSON.parse(content) as ReviewSession;
}

async function pickFile(files: ChangedFile[]) {
  if (files.length === 1) {
    return files[0];
  }
  const selected = await vscode.window.showQuickPick(
    files.map((file) => ({
      label: file.path,
      description: `+${file.additions} -${file.deletions} ${file.changeType}`,
      file
    })),
    { placeHolder: 'Select a file to review' }
  );
  return selected?.file;
}

async function openFile(file: ChangedFile) {
  const root = workspaceRoot();
  if (!root) {
    throw new Error('No workspace folder is open.');
  }
  const uri = vscode.Uri.file(path.join(root, file.path));
  const document = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(document, { preview: false });
}

async function saveFileIfOpen(file: ChangedFile) {
  const root = workspaceRoot();
  if (!root) {
    return;
  }
  const uri = vscode.Uri.file(path.join(root, file.path));
  const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
  if (document?.isDirty) {
    await document.save();
  }
}

function fileForDocument(document: vscode.TextDocument) {
  const root = workspaceRoot();
  if (!root || !currentSession || document.uri.scheme !== 'file') {
    return undefined;
  }
  const relative = workspaceRelativePath(root, document.uri.fsPath);
  if (!relative) {
    return undefined;
  }
  return currentSession.files.find((file) => file.path === relative);
}

function fileById(fileId: string) {
  return currentSession?.files.find((file) => file.fileId === fileId);
}

function blockById(file: ChangedFile, blockId: string) {
  return fileBlocks(file).find((block) => block.blockId === blockId);
}

function fileBlocks(file: ChangedFile) {
  const blocks: ReviewBlock[] = [];
  for (const hunk of file.hunks) {
    let rows: DiffRow[] = [];
    let blockIndex = 0;
    for (let index = 0; index < hunk.rows.length; index += 1) {
      const row = hunk.rows[index];
      if (row.kind === 'context') {
        if (rows.length > 0) {
          blockIndex += 1;
          blocks.push(makeBlock(hunk, rows, blockIndex, index));
          rows = [];
        }
      } else {
        rows.push(row);
      }
    }
    if (rows.length > 0) {
      blockIndex += 1;
      blocks.push(makeBlock(hunk, rows, blockIndex, hunk.rows.length));
    }
  }
  return blocks;
}

function makeBlock(hunk: DiffHunk, rows: DiffRow[], blockIndex: number, nextRowIndex: number): ReviewBlock {
  const firstCurrent = rows.find((row) => row.kind === 'added' && row.newLine)?.newLine;
  const nextCurrent = hunk.rows.slice(nextRowIndex).find((row) => row.kind !== 'deleted' && row.newLine)?.newLine;
  const anchorLine = firstCurrent ?? nextCurrent ?? hunk.newStart + hunk.newLines;
  return {
    blockId: `${hunk.hunkId}:${blockIndex}`,
    hunkId: hunk.hunkId,
    rows,
    anchorLine: Math.max(anchorLine, 1)
  };
}

function isReviewableFile(file: ChangedFile) {
  return !file.binary && !file.fileDecisionOnly && file.changeType !== 'deleted' && file.hunks.length > 0;
}

function addedCount(rows: DiffRow[]) {
  return rows.filter((row) => row.kind === 'added').length;
}

function deletedCount(rows: DiffRow[]) {
  return rows.filter((row) => row.kind === 'deleted').length;
}

function markBlockAccepted(file: ChangedFile, block: ReviewBlock) {
  acceptedBlocks.set(blockKey(file.fileId, block.blockId), blockSignature(block));
}

function isBlockAccepted(file: ChangedFile, block: ReviewBlock) {
  return acceptedBlocks.get(blockKey(file.fileId, block.blockId)) === blockSignature(block);
}

function blockKey(fileId: string, blockId: string) {
  return `${fileId}:${blockId}`;
}

function blockSignature(block: ReviewBlock) {
  return block.rows.map((row) => `${row.kind}:${row.oldLine ?? ''}:${row.newLine ?? ''}:${row.content}`).join('\n');
}

function clampLine(document: vscode.TextDocument, line: number) {
  if (document.lineCount === 0) {
    return 0;
  }
  return Math.min(Math.max(line, 0), document.lineCount - 1);
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function workspaceRelativePath(root: string, fsPath: string) {
  const relative = path.relative(root, fsPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replaceAll(path.sep, '/');
}

function isWorkspaceDocument(document: vscode.TextDocument) {
  return isWorkspaceFileUri(document.uri);
}

function isWorkspaceFileUri(uri: vscode.Uri) {
  const root = workspaceRoot();
  if (!root || uri.scheme !== 'file') {
    return false;
  }

  const relative = workspaceRelativePath(root, uri.fsPath);
  return Boolean(relative && !relative.startsWith('.git/') && !relative.startsWith('.agent-diff-review/'));
}

function hasVisibleWorkspaceDocument() {
  return vscode.window.visibleTextEditors.some((editor) => isWorkspaceDocument(editor.document));
}

function autoReviewEnabled() {
  return vscode.workspace.getConfiguration('agentDiffReview').get<boolean>('autoReview', true);
}

function autoReviewDelayMs() {
  return vscode.workspace.getConfiguration('agentDiffReview').get<number>('autoReviewDelayMs', DEFAULT_AUTO_REVIEW_DELAY_MS);
}

function adrPath(context: vscode.ExtensionContext) {
  const configured = vscode.workspace.getConfiguration('agentDiffReview').get<string>('adrPath')?.trim();
  if (configured && configured !== 'adr') {
    return configured;
  }

  const bundled = bundledAdrPath(context.extensionPath);
  return bundled ?? configured ?? 'adr';
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
