import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Download, FileCode2, ShieldAlert, TestTube2 } from 'lucide-react';
import type { ChangedFile, DecisionSet, LineDecision, LineDecisionEntry, ReviewSession } from './types';
import stylesText from './styles.css?raw';
import './styles.css';

export type { ReviewSession, DecisionSet } from './types';

export interface ReviewAppProps {
  session: ReviewSession;
  onDecisionSetChange?: (decisions: DecisionSet) => void;
  onExport?: (decisions: DecisionSet) => void;
}

export function ReviewApp({ session, onDecisionSetChange, onExport }: ReviewAppProps) {
  const [selectedFileId, setSelectedFileId] = useState(session.files[0]?.fileId ?? '');
  const [decisions, setDecisions] = useState<Map<string, LineDecisionEntry>>(new Map());
  const selectedFile = session.files.find((file) => file.fileId === selectedFileId) ?? session.files[0];

  const decisionSet = useMemo<DecisionSet>(() => ({
    schemaVersion: '0.1.0',
    sessionWorktreeHash: session.worktreeHash,
    decisions: Array.from(decisions.values())
  }), [decisions, session.worktreeHash]);

  function updateDecisions(next: Map<string, LineDecisionEntry>) {
    setDecisions(next);
    onDecisionSetChange?.({
      schemaVersion: '0.1.0',
      sessionWorktreeHash: session.worktreeHash,
      decisions: Array.from(next.values())
    });
  }

  function setLineDecision(fileId: string, hunkId: string, rowId: string, decision: LineDecision) {
    const next = new Map(decisions);
    next.set(decisionKey(fileId, hunkId, rowId), { fileId, hunkId, rowId, decision });
    updateDecisions(next);
  }

  function setFileDecision(file: ChangedFile, decision: LineDecision) {
    const next = new Map(decisions);
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        if (row.kind !== 'context') {
          next.set(decisionKey(file.fileId, hunk.hunkId, row.rowId), {
            fileId: file.fileId,
            hunkId: hunk.hunkId,
            rowId: row.rowId,
            decision
          });
        }
      }
    }
    updateDecisions(next);
  }

  if (!selectedFile) {
    return <div className="adr-empty">No worktree changes found.</div>;
  }

  const risks = session.riskMarkers.filter((risk) => risk.fileId === selectedFile.fileId);
  const edges = session.dependencyEdges.filter((edge) => edge.from === selectedFile.path || edge.to === selectedFile.path);
  const impacts = session.testImpacts.filter((impact) => impact.sourceFileId === selectedFile.fileId || impact.testFileId === selectedFile.fileId);

  return (
    <div className="adr-shell">
      <aside className="adr-sidebar">
        <h1>agent-diff-review</h1>
        <p>{session.headRef} - {new Date(session.createdAt).toLocaleString()}</p>
        <div className="adr-metrics">
          <Metric value={session.files.length} label="files" />
          <Metric value={session.riskMarkers.length} label="risks" />
          <Metric value={session.testImpacts.length} label="tests" />
        </div>
        <div className="adr-file-list">
          {session.files.map((file) => (
            <button
              key={file.fileId}
              className={file.fileId === selectedFile.fileId ? 'active' : ''}
              onClick={() => setSelectedFileId(file.fileId)}
            >
              <FileCode2 size={16} />
              <span>{file.path}</span>
              <small>+{file.additions} -{file.deletions}</small>
            </button>
          ))}
        </div>
      </aside>
      <main className="adr-main">
        <div className="adr-toolbar">
          <div>
            <h2>{selectedFile.path}</h2>
            <p>{selectedFile.changeType} - {selectedFile.language ?? 'unknown'}</p>
          </div>
          <div className="adr-actions">
            <button onClick={() => setFileDecision(selectedFile, 'accept')}>Accept file</button>
            <button onClick={() => setFileDecision(selectedFile, 'reject')}>Reject file</button>
            <button className="primary" onClick={() => onExport?.(decisionSet)}>
              <Download size={16} />
              Export decisions
            </button>
          </div>
        </div>
        <div className="adr-panels">
          <section>
            <h3><ShieldAlert size={16} /> Risks</h3>
            {risks.length ? risks.map((risk) => (
              <div className={`adr-risk ${risk.level}`} key={risk.riskId}>
                <strong>{risk.level}</strong> {risk.message}
              </div>
            )) : <p>No risk markers for this file.</p>}
          </section>
          <section>
            <h3><TestTube2 size={16} /> Dependency and Test Impact</h3>
            {edges.map((edge) => <div className="adr-note" key={`${edge.from}:${edge.to}`}>{`${edge.from} -> ${edge.to}`}</div>)}
            {impacts.map((impact, index) => <div className="adr-note" key={index}>{impact.message}</div>)}
            {!edges.length && !impacts.length ? <p>No dependency or test signal.</p> : null}
          </section>
        </div>
        <div className="adr-diff">
          {selectedFile.hunks.map((hunk) => (
            <section key={hunk.hunkId}>
              <div className="adr-hunk-header">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.header}</div>
              {hunk.rows.map((row) => {
                const current = decisions.get(decisionKey(selectedFile.fileId, hunk.hunkId, row.rowId))?.decision ?? row.decision;
                return (
                  <div className={`adr-row ${row.kind}`} key={row.rowId}>
                    <span>{row.oldLine ?? ''}</span>
                    <span>{row.newLine ?? ''}</span>
                    <code>{row.kind === 'added' ? '+' : row.kind === 'deleted' ? '-' : ' '}{row.content}</code>
                    {row.kind !== 'context' ? (
                      <select value={current} onChange={(event) => setLineDecision(selectedFile.fileId, hunk.hunkId, row.rowId, event.target.value as LineDecision)}>
                        <option value="pending">pending</option>
                        <option value="accept">accept</option>
                        <option value="reject">reject</option>
                      </select>
                    ) : <span />}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

export function mountReviewApp(element: HTMLElement, session: ReviewSession, onExport?: (decisions: DecisionSet) => void) {
  createRoot(element).render(<ReviewApp session={session} onExport={onExport} />);
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function decisionKey(fileId: string, hunkId: string, rowId: string) {
  return `${fileId}:${hunkId}:${rowId}`;
}

const REVIEW_STYLE_ID = 'agent-diff-review-ui-styles';
let stylesInjected = false;

function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') {
    return;
  }

  if (document.getElementById(REVIEW_STYLE_ID)) {
    stylesInjected = true;
    return;
  }

  const style = document.createElement('style');
  style.id = REVIEW_STYLE_ID;
  style.textContent = stylesText;
  (document.head ?? document.documentElement).appendChild(style);
  stylesInjected = true;
}

if (typeof document !== 'undefined') {
  ensureStyles();
}
