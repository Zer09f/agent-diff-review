import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

const SESSION_PATH = '.agent-diff-review/session.json';
const DECISIONS_PATH = '.agent-diff-review/decisions.json';
const BASELINE_PATH = '.agent-diff-review/baseline.json';
const DEFAULT_AUTO_REVIEW_DELAY_MS = 350;
const DEFAULT_LOCAL_REVIEW_DELAY_MS = 60;
const MAX_LOCAL_DIFF_CELLS = 1_000_000;
const OUTPUT_CHANNEL_NAME = 'agent-diff-review';

type RowKind = 'context' | 'added' | 'deleted';
type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';
type ReviewSource = 'git' | 'snapshot';
type Language = 'typescript' | 'javascript' | 'java' | 'other';

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
  dependencyEdges: unknown[];
  riskMarkers: unknown[];
  testImpacts: unknown[];
}

interface ChangedFile {
  fileId: string;
  path: string;
  oldPath: string | null;
  changeType: ChangeType;
  binary: boolean;
  fileDecisionOnly: boolean;
  language: Language | null;
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
  oldStartLine: number | null;
  oldEndLine: number | null;
  oldInsertLine: number;
}

interface BaselineSnapshot {
  schemaVersion: string;
  baselineId: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  baselineHash: string;
  files: BaselineFile[];
}

interface BaselineFile {
  path: string;
  contentHash: string;
  content: string;
  updatedAt: string;
}

const acceptedBlocks = new Set<string>();
const documentReviewTimers = new Map<string, ReturnType<typeof setTimeout>>();
const documentReviewVersions = new Map<string, number>();
let fileBlockCache = new WeakMap<ChangedFile, ReviewBlock[]>();
let currentSession: ReviewSession | undefined;
let autoReviewTimer: ReturnType<typeof setTimeout> | undefined;
let autoReviewInFlight: Promise<ReviewSession | undefined> | undefined;
let autoReviewQueued = false;
let lastSilentError: string | undefined;
let metadataWriteQueue = Promise.resolve();
let outputChannel: vscode.OutputChannel | undefined;
let baselineCache:
  | {
      root: string;
      mtimeMs: number;
      snapshot: BaselineSnapshot;
    }
  | undefined;

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
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  codeLensProvider = new ReviewCodeLensProvider();
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(
    outputChannel,
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
        scheduleDocumentReview(context, document);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isWorkspaceDocument(document)) {
        scheduleDocumentReview(context, document, 0);
        scheduleAutoReview(context, 250);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isWorkspaceDocument(event.document)) {
        scheduleDocumentReview(context, event.document);
        scheduleAutoReview(context);
      } else {
        applyDecorations(event.document);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      currentSession = undefined;
      acceptedBlocks.clear();
      fileBlockCache = new WeakMap<ChangedFile, ReviewBlock[]>();
      clearDocumentReviewTimers();
      documentReviewVersions.clear();
      baselineCache = undefined;
      scheduleAutoReview(context, 250);
      applyDecorationsToVisibleEditors();
      codeLensProvider.refresh();
    }),
    fileWatcher.onDidChange((uri) => scheduleAutoReviewForUri(context, uri)),
    fileWatcher.onDidCreate((uri) => scheduleAutoReviewForUri(context, uri)),
    fileWatcher.onDidDelete((uri) => scheduleAutoReviewForUri(context, uri)),
    vscode.commands.registerCommand('agentDiffReview.open', () => openNativeReview(context)),
    vscode.commands.registerCommand('agentDiffReview.applyDecisions', () => applyDecisions(context)),
    vscode.commands.registerCommand('agentDiffReview.refreshSnapshotBaseline', () => refreshSnapshotBaseline(context)),
    vscode.commands.registerCommand('agentDiffReview.showOutput', () => showOutput()),
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
  if (autoReviewTimer) {
    clearTimeout(autoReviewTimer);
    autoReviewTimer = undefined;
  }

  if (!autoReviewEnabled() || !hasVisibleWorkspaceDocument() || hasDirtyWorkspaceDocument()) {
    return;
  }

  autoReviewTimer = setTimeout(() => {
    autoReviewTimer = undefined;
    if (!hasDirtyWorkspaceDocument()) {
      void refreshReviewSession(context, { silent: true });
    }
  }, Math.max(250, delayMs));
}

function scheduleAutoReviewForUri(context: vscode.ExtensionContext, uri: vscode.Uri) {
  if (isWorkspaceFileUri(uri)) {
    const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
    if (document) {
      scheduleDocumentReview(context, document);
    }
    scheduleAutoReview(context);
  }
}

function scheduleDocumentReview(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  delayMs = DEFAULT_LOCAL_REVIEW_DELAY_MS
) {
  if (!autoReviewEnabled() || !isWorkspaceDocument(document)) {
    applyDecorations(document);
    return;
  }

  const key = document.uri.toString();
  const existing = documentReviewTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const version = nextDocumentReviewVersion(document);
  documentReviewTimers.set(
    key,
    setTimeout(() => {
      documentReviewTimers.delete(key);
      void refreshDocumentReview(context, document, version);
    }, Math.max(0, delayMs))
  );
}

function clearDocumentReviewTimers() {
  for (const timer of documentReviewTimers.values()) {
    clearTimeout(timer);
  }
  documentReviewTimers.clear();
}

async function refreshReviewSession(context: vscode.ExtensionContext, options: { silent: boolean }) {
  const root = workspaceRoot();
  if (!root) {
    return undefined;
  }

  if (hasDirtyWorkspaceDocument()) {
    if (!options.silent) {
      vscode.window.showInformationMessage('Save the current file to refresh agent-diff-review.');
    }
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
      const session = await scanReviewSession(context, root);
      currentSession = session;
      fileBlockCache = new WeakMap<ChangedFile, ReviewBlock[]>();
      baselineCache = undefined;
      acceptedBlocks.clear();
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
      showFailureMessage(`agent-diff-review failed: ${message}`);
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
  await initializeSnapshotBaseline(context, root, false);
  baselineCache = undefined;
}

async function refreshSnapshotBaseline(context: vscode.ExtensionContext) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open a workspace folder before rebuilding the agent-diff-review baseline.');
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    'Rebuild the agent-diff-review snapshot baseline from the current workspace state? Current edits will become the new review baseline.',
    { modal: true },
    'Rebuild Baseline'
  );
  if (confirmed !== 'Rebuild Baseline') {
    return;
  }
  await initializeSnapshotBaseline(context, root, true);
  baselineCache = undefined;
  await refreshReviewSession(context, { silent: true });
  vscode.window.showInformationMessage('agent-diff-review snapshot baseline rebuilt.');
}

async function initializeSnapshotBaseline(context: vscode.ExtensionContext, root: string, force: boolean) {
  const temporaryBaselinePath = temporaryMetadataPath(BASELINE_PATH);
  try {
    const args = ['snapshot', 'init', '--baseline', temporaryBaselinePath];
    if (force) {
      args.push('--force');
    }
    await runAdr(context, root, args);
    const snapshot = await readJsonFile<BaselineSnapshot>(path.join(root, temporaryBaselinePath));
    await writeBaselineSnapshot(root, snapshot);
  } finally {
    await fs.rm(path.join(root, temporaryBaselinePath), { force: true }).catch(() => undefined);
  }
}

async function scanReviewSession(context: vscode.ExtensionContext, root: string) {
  const temporarySessionPath = temporaryMetadataPath(SESSION_PATH);
  try {
    await runAdr(context, root, [
      'scan',
      '--source',
      'snapshot',
      '--format',
      'json',
      '--out',
      temporarySessionPath,
      '--baseline',
      BASELINE_PATH
    ]);
    const session = await readJsonFile<ReviewSession>(path.join(root, temporarySessionPath));
    await writeSessionFile(root, session);
    return session;
  } finally {
    await fs.rm(path.join(root, temporarySessionPath), { force: true }).catch(() => undefined);
  }
}

async function refreshDocumentReview(context: vscode.ExtensionContext, document: vscode.TextDocument, version: number) {
  if (!isWorkspaceDocument(document)) {
    applyDecorations(document);
    return;
  }

  const updated = await updateDocumentReviewFromBaseline(document, version);
  if (!updated && isCurrentDocumentReview(document, version)) {
    scheduleAutoReview(context, 250);
  }
}

async function refreshDocumentReviewNow(document: vscode.TextDocument) {
  return updateDocumentReviewFromBaseline(document, nextDocumentReviewVersion(document));
}

async function updateDocumentReviewFromBaseline(document: vscode.TextDocument, version: number) {
  const root = workspaceRoot();
  if (!root || document.uri.scheme !== 'file') {
    return false;
  }

  const relative = workspaceRelativePath(root, document.uri.fsPath);
  if (!relative) {
    return false;
  }

  try {
    const baseline = await readBaselineSnapshot(root);
    if (!isCurrentDocumentReview(document, version)) {
      return true;
    }

    const baselineFile = baseline.files.find((file) => file.path === relative);
    const before = baselineFile?.content ?? '';
    const after = document.getText();
    const changeType: ChangeType = baselineFile ? 'modified' : 'added';
    const changedFile = changedFileFromContents(relative, before, after, changeType);
    if (!isCurrentDocumentReview(document, version)) {
      return true;
    }

    upsertSessionFile(root, baseline, changedFile);
    fileBlockCache = new WeakMap<ChangedFile, ReviewBlock[]>();
    clearAcceptedBlocksForFile(changedFile.fileId);
    await writeSessionFile(root, currentSession!);
    if (!isCurrentDocumentReview(document, version)) {
      return true;
    }

    applyDecorations(document);
    codeLensProvider.refresh();
    return true;
  } catch (error) {
    console.warn(`agent-diff-review document review failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function updateSnapshotBaselineForAcceptedBlock(file: ChangedFile, block: ReviewBlock) {
  const root = workspaceRoot();
  if (!root) {
    return;
  }

  const snapshot = await readBaselineSnapshot(root);
  const baselineFile = snapshot.files.find((item) => item.path === file.path);
  const merged = mergeAcceptedBlockIntoBaseline(baselineFile?.content ?? file.beforeContent ?? '', block);
  await writeSnapshotBaselineFile(root, snapshot, file.path, merged);
}

async function updateSnapshotBaselineForCurrentFile(file: ChangedFile) {
  const root = workspaceRoot();
  if (!root) {
    return;
  }

  const document = documentForFile(file);
  const content = document?.getText() ?? file.afterContent ?? '';
  const snapshot = await readBaselineSnapshot(root);
  await writeSnapshotBaselineFile(root, snapshot, file.path, content);
}

async function readBaselineSnapshot(root: string) {
  const baselinePath = path.join(root, BASELINE_PATH);
  await settleMetadataWrites();
  const stat = await fs.stat(baselinePath);
  if (baselineCache && baselineCache.root === root && baselineCache.mtimeMs === stat.mtimeMs) {
    return baselineCache.snapshot;
  }

  const snapshot = await readJsonFile<BaselineSnapshot>(baselinePath);
  baselineCache = { root, mtimeMs: stat.mtimeMs, snapshot };
  return snapshot;
}

async function writeBaselineSnapshot(root: string, snapshot: BaselineSnapshot) {
  const baselinePath = path.join(root, BASELINE_PATH);
  await writeMetadataFile(baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  baselineCache = undefined;
}

async function writeSessionFile(root: string, session: ReviewSession) {
  const sessionPath = path.join(root, SESSION_PATH);
  await writeMetadataFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
}

async function persistCurrentSession() {
  const root = workspaceRoot();
  if (root && currentSession) {
    await writeSessionFile(root, currentSession);
  }
}

async function writeSnapshotBaselineFile(root: string, snapshot: BaselineSnapshot, relativePath: string, content: string) {
  const now = new Date().toISOString();
  const existing = snapshot.files.find((file) => file.path === relativePath);
  if (existing) {
    existing.content = content;
    existing.contentHash = contentHash(content);
    existing.updatedAt = now;
  } else {
    snapshot.files.push({
      path: relativePath,
      contentHash: contentHash(content),
      content,
      updatedAt: now
    });
    snapshot.files.sort((a, b) => a.path.localeCompare(b.path));
  }

  snapshot.updatedAt = now;
  snapshot.baselineHash = baselineHash(snapshot.files);
  await writeBaselineSnapshot(root, snapshot);
}

function mergeAcceptedBlockIntoBaseline(before: string, block: ReviewBlock) {
  const lines = splitLinesNone(before);
  const startLine = block.oldStartLine ?? block.oldInsertLine;
  const endLine = block.oldEndLine ?? block.oldInsertLine - 1;
  const startIndex = Math.max(0, Math.min(lines.length, startLine - 1));
  const deleteCount = Math.max(0, endLine - startLine + 1);
  const acceptedLines = block.rows.filter((row) => row.kind !== 'deleted').map((row) => row.content);
  const out = [...lines.slice(0, startIndex), ...acceptedLines, ...lines.slice(startIndex + deleteCount)];
  return joinLinesLike(before, out);
}

function upsertSessionFile(root: string, baseline: BaselineSnapshot, file: ChangedFile) {
  const session = currentSession ?? emptyReviewSession(root, baseline);
  const existingIndex = session.files.findIndex((item) => item.path === file.path);
  if (file.hunks.length === 0) {
    if (existingIndex >= 0) {
      session.files.splice(existingIndex, 1);
    }
  } else if (existingIndex >= 0) {
    session.files[existingIndex] = file;
  } else {
    session.files.push(file);
    session.files.sort((a, b) => a.path.localeCompare(b.path));
  }
  session.worktreeHash = worktreeHash(session.files);
  session.createdAt = new Date().toISOString();
  currentSession = session;
}

function emptyReviewSession(root: string, baseline: BaselineSnapshot): ReviewSession {
  return {
    schemaVersion: '0.1.0',
    workspaceRoot: root,
    baseRef: 'snapshot',
    headRef: 'workspace',
    createdAt: new Date().toISOString(),
    worktreeHash: worktreeHash([]),
    source: 'snapshot',
    baselineId: baseline.baselineId,
    baselineHash: baseline.baselineHash,
    trackedPaths: baseline.files.map((file) => file.path),
    files: [],
    dependencyEdges: [],
    riskMarkers: [],
    testImpacts: []
  };
}

function removeAcceptedFileFromSessionIfClean(file: ChangedFile) {
  const root = workspaceRoot();
  const document = documentForFile(file);
  if (!root || !document || !currentSession) {
    return;
  }

  const baseline = baselineCache?.root === root ? baselineCache.snapshot : undefined;
  const baselineFile = baseline?.files.find((item) => item.path === file.path);
  if (baselineFile && baselineFile.content === document.getText()) {
    currentSession.files = currentSession.files.filter((item) => item.fileId !== file.fileId);
    currentSession.worktreeHash = worktreeHash(currentSession.files);
    clearAcceptedBlocksForFile(file.fileId);
  }
}

async function acceptBlock(args: BlockCommandArgs) {
  const file = fileById(args.fileId);
  const block = file ? blockById(file, args.blockId) : undefined;
  if (!file || !block) {
    return;
  }
  await saveFileIfOpen(file);
  markBlockAccepted(file, block);
  await updateSnapshotBaselineForAcceptedBlock(file, block);
  const document = documentForFile(file);
  if (document) {
    await refreshDocumentReviewNow(document);
  }
  removeAcceptedFileFromSessionIfClean(file);
  await persistCurrentSession();
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
    await refreshDocumentReviewNow(editor.document);
    await persistCurrentSession();
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
  const document = documentForFile(file);
  for (const block of fileBlocks(file)) {
    markBlockAccepted(file, block);
  }
  await updateSnapshotBaselineForCurrentFile(file);
  if (document) {
    await refreshDocumentReviewNow(document);
  }
  removeAcceptedFileFromSessionIfClean(file);
  await persistCurrentSession();
  applyDecorationsToVisibleEditors();
  codeLensProvider.refresh();
}

async function rejectFile(context: vscode.ExtensionContext, args: FileCommandArgs) {
  const file = fileById(args.fileId);
  if (!file) {
    return;
  }

  const editor = await openFile(file);
  await replaceDocumentText(editor, file.beforeContent ?? '');
  for (const block of fileBlocks(file)) {
    markBlockAccepted(file, block);
  }
  await editor.document.save();
  await refreshDocumentReviewNow(editor.document);
  await persistCurrentSession();
  applyDecorationsToVisibleEditors();
  codeLensProvider.refresh();
}

async function replaceBlockWithOldSide(editor: vscode.TextEditor, block: ReviewBlock) {
  const file = fileForDocument(editor.document);
  const nextText = rejectBlockInContent(editor.document.getText(), block, file?.beforeContent ?? '');
  return replaceDocumentText(editor, nextText);
}

async function replaceDocumentText(editor: vscode.TextEditor, content: string) {
  const document = editor.document;
  const lastLine = Math.max(0, document.lineCount - 1);
  const range = new vscode.Range(new vscode.Position(0, 0), document.lineAt(lastLine).rangeIncludingLineBreak.end);
  return editor.edit((edit) => {
    edit.replace(range, content);
  });
}

function rejectBlockInContent(content: string, block: ReviewBlock, beforeContent: string) {
  const lines = splitLinesNone(content);
  const deletedLines = block.rows.filter((row) => row.kind === 'deleted').map((row) => row.content);
  const addedRows = block.rows.filter((row) => row.kind === 'added' && row.newLine);
  if (addedRows.length === 0) {
    const insertIndex = Math.max(0, Math.min(lines.length, block.anchorLine - 1));
    lines.splice(insertIndex, 0, ...deletedLines);
    return joinLinesLike(insertIndex >= lines.length - deletedLines.length ? beforeContent : content, lines);
  }

  const startIndex = Math.max(0, Math.min(lines.length, (addedRows[0].newLine ?? block.anchorLine) - 1));
  const deleteCount = addedRows.length;
  const touchesEnd = startIndex + deleteCount >= lines.length;
  lines.splice(startIndex, deleteCount, ...deletedLines);
  return joinLinesLike(touchesEnd ? beforeContent : content, lines);
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

function changedFileFromContents(relativePath: string, before: string, after: string, changeType: ChangeType): ChangedFile {
  const fileId = stableId([relativePath, 'file']);
  const { rows, additions, deletions } = diffRows(fileId, splitLinesNone(before), splitLinesNone(after));
  const hunkId = stableId([fileId, 'snapshot', '1']);
  const hunkRows = rows.map((row, index) => ({
    ...row,
    rowId: stableId([hunkId, String(index + 1), rowKindDebug(row.kind), row.content])
  }));
  const oldStart = hunkRows.find((row) => row.oldLine !== null)?.oldLine ?? (before ? 1 : 0);
  const newStart = hunkRows.find((row) => row.newLine !== null)?.newLine ?? (after ? 1 : 0);

  return {
    fileId,
    path: relativePath,
    oldPath: null,
    changeType,
    binary: false,
    fileDecisionOnly: false,
    language: classifyLanguage(relativePath),
    additions,
    deletions,
    beforeContent: before,
    afterContent: after,
    hunks:
      hunkRows.length === 0
        ? []
        : [
            {
              hunkId,
              oldStart,
              oldLines: hunkRows.filter((row) => row.oldLine !== null).length,
              newStart,
              newLines: hunkRows.filter((row) => row.newLine !== null).length,
              header: 'snapshot baseline',
              rows: hunkRows
            }
          ]
  };
}

function diffRows(fileId: string, oldLines: string[], newLines: string[]) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  if (prefix > oldEnd && prefix > newEnd) {
    return { rows: [] as DiffRow[], additions: 0, deletions: 0 };
  }

  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  const contextStart = Math.max(0, prefix - 3);
  for (let index = contextStart; index < prefix; index += 1) {
    rows.push(contextRow(oldLines[index], index + 1, index + 1));
  }

  const oldMiddle = oldLines.slice(prefix, oldEnd + 1);
  const newMiddle = newLines.slice(prefix, newEnd + 1);
  const middleCells = oldMiddle.length * newMiddle.length;
  if (middleCells > MAX_LOCAL_DIFF_CELLS) {
    for (let index = 0; index < oldMiddle.length; index += 1) {
      deletions += 1;
      rows.push(deletedRow(oldMiddle[index], prefix + index + 1));
    }
    for (let index = 0; index < newMiddle.length; index += 1) {
      additions += 1;
      rows.push(addedRow(newMiddle[index], prefix + index + 1));
    }
  } else {
    const table = lcsTable(oldMiddle, newMiddle);
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldMiddle.length || newIndex < newMiddle.length) {
      if (oldIndex < oldMiddle.length && newIndex < newMiddle.length && oldMiddle[oldIndex] === newMiddle[newIndex]) {
        rows.push(contextRow(oldMiddle[oldIndex], prefix + oldIndex + 1, prefix + newIndex + 1));
        oldIndex += 1;
        newIndex += 1;
      } else if (
        newIndex < newMiddle.length &&
        (oldIndex === oldMiddle.length || table[oldIndex][newIndex + 1] > table[oldIndex + 1][newIndex])
      ) {
        additions += 1;
        rows.push(addedRow(newMiddle[newIndex], prefix + newIndex + 1));
        newIndex += 1;
      } else if (oldIndex < oldMiddle.length) {
        deletions += 1;
        rows.push(deletedRow(oldMiddle[oldIndex], prefix + oldIndex + 1));
        oldIndex += 1;
      }
    }
  }

  return { rows: trimContextRows(rows, fileId), additions, deletions };
}

function lcsTable(oldLines: string[], newLines: string[]) {
  const table = Array.from({ length: oldLines.length + 1 }, () => Array(newLines.length + 1).fill(0) as number[]);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? table[oldIndex + 1][newIndex + 1] + 1
          : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  return table;
}

function trimContextRows(rows: DiffRow[], _fileId: string) {
  const first = rows.findIndex((row) => row.kind !== 'context');
  let last = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].kind !== 'context') {
      last = index;
      break;
    }
  }
  if (first < 0 || last < 0) {
    return [];
  }
  return rows.slice(Math.max(0, first - 3), Math.min(rows.length, last + 1));
}

function contextRow(content: string, oldLine: number, newLine: number): DiffRow {
  return { rowId: '', kind: 'context', oldLine, newLine, content };
}

function addedRow(content: string, newLine: number): DiffRow {
  return { rowId: '', kind: 'added', oldLine: null, newLine, content };
}

function deletedRow(content: string, oldLine: number): DiffRow {
  return { rowId: '', kind: 'deleted', oldLine, newLine: null, content };
}

function rowKindDebug(kind: RowKind) {
  switch (kind) {
    case 'added':
      return 'Added';
    case 'deleted':
      return 'Deleted';
    case 'context':
      return 'Context';
  }
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

function documentForFile(file: ChangedFile) {
  const root = workspaceRoot();
  if (!root) {
    return undefined;
  }
  const uri = vscode.Uri.file(path.join(root, file.path));
  return vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
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
  const cached = fileBlockCache.get(file);
  if (cached) {
    return cached;
  }

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
  fileBlockCache.set(file, blocks);
  return blocks;
}

function makeBlock(hunk: DiffHunk, rows: DiffRow[], blockIndex: number, nextRowIndex: number): ReviewBlock {
  const firstCurrent = rows.find((row) => row.kind === 'added' && row.newLine)?.newLine;
  const nextCurrent = hunk.rows.slice(nextRowIndex).find((row) => row.kind !== 'deleted' && row.newLine)?.newLine;
  const oldLines = rows.map((row) => row.oldLine).filter((line): line is number => line !== null);
  const oldStartLine = oldLines.length > 0 ? Math.min(...oldLines) : null;
  const oldEndLine = oldLines.length > 0 ? Math.max(...oldLines) : null;
  const previousOldLine = hunk.rows
    .slice(0, nextRowIndex)
    .reverse()
    .find((row) => row.oldLine !== null)?.oldLine;
  const anchorLine = firstCurrent ?? nextCurrent ?? hunk.newStart + hunk.newLines;
  return {
    blockId: `${hunk.hunkId}:${blockIndex}`,
    hunkId: hunk.hunkId,
    rows,
    anchorLine: Math.max(anchorLine, 1),
    oldStartLine,
    oldEndLine,
    oldInsertLine: oldStartLine ?? (previousOldLine ? previousOldLine + 1 : hunk.oldStart)
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
  acceptedBlocks.add(acceptedBlockKey(file.fileId, blockSignature(block)));
}

function isBlockAccepted(file: ChangedFile, block: ReviewBlock) {
  return acceptedBlocks.has(acceptedBlockKey(file.fileId, blockSignature(block)));
}

function clearAcceptedBlocksForFile(fileId: string) {
  for (const key of Array.from(acceptedBlocks)) {
    if (key.startsWith(`${fileId}:`)) {
      acceptedBlocks.delete(key);
    }
  }
}

function acceptedBlockKey(fileId: string, signature: string) {
  return `${fileId}:${signature}`;
}

function blockSignature(block: ReviewBlock) {
  return [
    block.oldStartLine ?? '',
    block.oldEndLine ?? '',
    block.oldInsertLine,
    block.rows.map((row) => `${row.kind}:${row.content}`).join('\n')
  ].join(':');
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

function hasDirtyWorkspaceDocument() {
  return vscode.workspace.textDocuments.some((document) => isWorkspaceDocument(document) && document.isDirty);
}

function autoReviewEnabled() {
  return vscode.workspace.getConfiguration('agentDiffReview').get<boolean>('autoReview', true);
}

function autoReviewDelayMs() {
  return vscode.workspace.getConfiguration('agentDiffReview').get<number>('autoReviewDelayMs', DEFAULT_AUTO_REVIEW_DELAY_MS);
}

function classifyLanguage(filePath: string): Language {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return 'typescript';
  }
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return 'javascript';
  }
  if (lower.endsWith('.java')) {
    return 'java';
  }
  return 'other';
}

function nextDocumentReviewVersion(document: vscode.TextDocument) {
  const key = document.uri.toString();
  const version = (documentReviewVersions.get(key) ?? 0) + 1;
  documentReviewVersions.set(key, version);
  return version;
}

function isCurrentDocumentReview(document: vscode.TextDocument, version: number) {
  return documentReviewVersions.get(document.uri.toString()) === version;
}

async function readJsonFile<T>(filePath: string) {
  await settleMetadataWrites();
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content) as T;
    } catch (error) {
      lastError = error;
      if (!isRecoverableJsonReadError(error) || attempt === 5) {
        throw error;
      }
      await sleep(75 * (attempt + 1));
    }
  }
  throw lastError;
}

function isRecoverableJsonReadError(error: unknown) {
  if (!(error instanceof SyntaxError)) {
    return false;
  }
  return /Unexpected end|Unterminated string|unterminated string/i.test(error.message);
}

function temporaryMetadataPath(targetPath: string) {
  const directory = path.posix.dirname(targetPath);
  const basename = path.posix.basename(targetPath);
  const temporaryName = `.${basename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  return directory === '.' ? temporaryName : `${directory}/${temporaryName}`;
}

function writeMetadataFile(filePath: string, content: string) {
  const write = metadataWriteQueue.catch(() => undefined).then(() => writeFileAtomically(filePath, content));
  metadataWriteQueue = write.catch(() => undefined);
  return write;
}

async function settleMetadataWrites() {
  await metadataWriteQueue;
}

async function writeFileAtomically(filePath: string, content: string) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );

  try {
    await fs.writeFile(temporaryPath, content, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitLinesNone(content: string) {
  return content.length === 0 ? [] : content.split(/\r?\n/).slice(0, content.endsWith('\n') || content.endsWith('\r\n') ? -1 : undefined);
}

function joinLinesLike(reference: string, lines: string[]) {
  if (lines.length === 0) {
    return '';
  }

  const eol = reference.includes('\r\n') ? '\r\n' : '\n';
  let out = lines.join(eol);
  if (reference.endsWith('\n')) {
    out += eol;
  }
  return out;
}

function stableId(parts: string[]) {
  const hasher = createHash('sha256');
  for (const part of parts) {
    hasher.update(part);
    hasher.update(Buffer.from([0]));
  }
  return hasher.digest('hex').slice(0, 16);
}

function contentHash(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function baselineHash(files: BaselineFile[]) {
  const hasher = createHash('sha256');
  for (const file of files) {
    hasher.update(file.path);
    hasher.update(Buffer.from([0]));
    hasher.update(file.contentHash);
    hasher.update(Buffer.from([0]));
  }
  return hasher.digest('hex');
}

function worktreeHash(files: ChangedFile[]) {
  const hasher = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hasher.update(file.path);
    hasher.update(Buffer.from([0]));
    hasher.update(changeTypeDebug(file.changeType));
    hasher.update(Buffer.from([0]));
    if (file.beforeContent !== null) {
      hasher.update(file.beforeContent);
    }
    hasher.update(Buffer.from([0]));
    if (file.afterContent !== null) {
      hasher.update(file.afterContent);
    }
    hasher.update(Buffer.from([0]));
  }
  return hasher.digest('hex');
}

function changeTypeDebug(changeType: ChangeType) {
  switch (changeType) {
    case 'added':
      return 'Added';
    case 'modified':
      return 'Modified';
    case 'deleted':
      return 'Deleted';
    case 'renamed':
      return 'Renamed';
    case 'copied':
      return 'Copied';
    case 'untracked':
      return 'Untracked';
  }
}

interface AdrCommand {
  command: string;
  platform: string;
  bundled: boolean;
  userConfigured: boolean;
}

function resolveAdrCommand(context: vscode.ExtensionContext): AdrCommand {
  const platform = platformKey() ?? `${process.platform}-${process.arch}`;
  const configured = vscode.workspace.getConfiguration('agentDiffReview').get<string>('adrPath')?.trim();
  if (configured && configured !== 'adr') {
    return { command: configured, platform, bundled: false, userConfigured: true };
  }

  const bundled = bundledAdrPath(context.extensionPath);
  return { command: bundled ?? 'adr', platform, bundled: Boolean(bundled), userConfigured: configured === 'adr' };
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
    const adr = resolveAdrCommand(context);
    const command = adr.command;
    logAdrInvocation(adr, cwd, args);
    const child = spawn(command, args, { cwd, shell: process.platform === 'win32' && !path.isAbsolute(command) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      logAdrFailure(error.message);
      reject(new Error(adrFailureMessage(adr, error.message)));
    });
    child.on('close', (code) => {
      if (code === 0) {
        if (stdout.trim()) {
          logAdrOutput('stdout', stdout);
        }
        resolve();
      } else {
        logAdrOutput('stdout', stdout);
        logAdrOutput('stderr', stderr);
        reject(new Error(adrFailureMessage(adr, stderr.trim() || stdout.trim() || `adr exited with ${code}`)));
      }
    });
  });
}

function logAdrInvocation(adr: AdrCommand, cwd: string, args: string[]) {
  const source = adr.bundled ? 'bundled' : adr.userConfigured ? 'configured' : 'PATH';
  output().appendLine(`[adr] ${source} ${adr.platform}: ${adr.command}`);
  output().appendLine(`[adr] cwd: ${cwd}`);
  output().appendLine(`[adr] args: ${args.map(formatCommandArg).join(' ')}`);
}

function logAdrOutput(stream: 'stdout' | 'stderr', content: string) {
  const trimmed = content.trim();
  if (trimmed) {
    output().appendLine(`[adr:${stream}] ${trimmed}`);
  }
}

function logAdrFailure(message: string) {
  output().appendLine(`[adr:error] ${message}`);
}

function formatCommandArg(value: string) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function output() {
  outputChannel ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  return outputChannel;
}

function showOutput() {
  output().show(true);
}

async function showFailureMessage(message: string) {
  const action = await vscode.window.showErrorMessage(message, 'Show Logs');
  if (action === 'Show Logs') {
    showOutput();
  }
}

function adrFailureMessage(adr: AdrCommand, message: string) {
  if (adr.bundled || adr.userConfigured) {
    return message;
  }

  return `${message}. No bundled adr binary was found for ${adr.platform} in this VSIX; install the matching platform VSIX or set agentDiffReview.adrPath to a valid adr executable.`;
}
