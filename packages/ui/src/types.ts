export type LineDecision = 'accept' | 'reject' | 'pending';
export type RowKind = 'context' | 'added' | 'deleted';
export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';
export type RiskLevel = 'low' | 'medium' | 'high';
export type ReviewSource = 'git' | 'snapshot';

export interface ReviewSession {
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
  dependencyEdges: DependencyEdge[];
  riskMarkers: RiskMarker[];
  testImpacts: TestImpact[];
}

export interface ChangedFile {
  fileId: string;
  path: string;
  oldPath: string | null;
  changeType: ChangeType;
  binary: boolean;
  fileDecisionOnly: boolean;
  language: string | null;
  additions: number;
  deletions: number;
  beforeContent: string | null;
  afterContent: string | null;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  hunkId: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  rows: DiffRow[];
}

export interface DiffRow {
  rowId: string;
  kind: RowKind;
  oldLine: number | null;
  newLine: number | null;
  content: string;
  decision: LineDecision;
}

export interface DependencyEdge {
  from: string;
  to: string;
  kind: string;
  confidence: string;
}

export interface RiskMarker {
  riskId: string;
  fileId: string;
  hunkId: string | null;
  rowId: string | null;
  level: RiskLevel;
  category: string;
  message: string;
}

export interface TestImpact {
  sourceFileId: string | null;
  testFileId: string;
  kind: string;
  confidence: string;
  message: string;
}

export interface LineDecisionEntry {
  fileId: string;
  hunkId: string;
  rowId: string;
  decision: LineDecision;
}

export interface DecisionSet {
  schemaVersion: string;
  sessionWorktreeHash: string;
  decisions: LineDecisionEntry[];
}
