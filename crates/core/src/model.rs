use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    pub schema_version: String,
    pub workspace_root: String,
    pub base_ref: String,
    pub head_ref: String,
    pub created_at: String,
    pub worktree_hash: String,
    #[serde(default)]
    pub source: Option<ReviewSource>,
    #[serde(default)]
    pub baseline_id: Option<String>,
    #[serde(default)]
    pub baseline_hash: Option<String>,
    #[serde(default)]
    pub tracked_paths: Vec<String>,
    pub files: Vec<ChangedFile>,
    pub dependency_edges: Vec<DependencyEdge>,
    pub risk_markers: Vec<RiskMarker>,
    pub test_impacts: Vec<TestImpact>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewSource {
    Git,
    Snapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub file_id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub change_type: ChangeType,
    pub binary: bool,
    pub file_decision_only: bool,
    pub language: Option<Language>,
    pub additions: usize,
    pub deletions: usize,
    pub before_content: Option<String>,
    pub after_content: Option<String>,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub hunk_id: String,
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub header: String,
    pub rows: Vec<DiffRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub row_id: String,
    pub kind: RowKind,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
    pub content: String,
    pub decision: LineDecision,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeType {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Untracked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RowKind {
    Context,
    Added,
    Deleted,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LineDecision {
    Accept,
    Reject,
    Pending,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Language {
    TypeScript,
    JavaScript,
    Java,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEdge {
    pub from: String,
    pub to: String,
    pub kind: DependencyKind,
    pub confidence: DependencyConfidence,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum DependencyKind {
    Import,
    Package,
    HeuristicTest,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DependencyConfidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RiskMarker {
    pub risk_id: String,
    pub file_id: String,
    pub hunk_id: Option<String>,
    pub row_id: Option<String>,
    pub level: RiskLevel,
    pub category: RiskCategory,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RiskCategory {
    Config,
    Lockfile,
    Auth,
    PublicApi,
    LargeDeletion,
    TestDeletion,
    FanIn,
    FileDecisionOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TestImpact {
    pub source_file_id: Option<String>,
    pub test_file_id: String,
    pub kind: TestImpactKind,
    pub confidence: DependencyConfidence,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TestImpactKind {
    TestAdded,
    TestModified,
    TestDeleted,
    RelatedTestChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DecisionSet {
    pub schema_version: String,
    pub session_worktree_hash: String,
    pub decisions: Vec<LineDecisionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineDecisionEntry {
    pub file_id: String,
    pub hunk_id: String,
    pub row_id: String,
    pub decision: LineDecision,
}
