import { useState } from 'react';
import { usePresetStore } from '../store/usePresetStore';
import { UndoRedoButtons } from './UndoRedoButtons';
import { Dialog } from './Dialog';
import { groupDiffByBlock, formatDiffValue } from '../lib/diff';
import { describeTool } from '../lib/activity';
import type { EditEntry } from '../api/types';

/**
 * Review and download.
 *
 * Shows exactly what changed as a before/after diff grouped by block, an audit
 * trail of the tool edits behind it, undo/redo driven by the server's history,
 * a confirmed "revert all", and a download of the current `.hlx` — modified or
 * not, with the modified state always visible.
 */
export function ChangesPanel() {
  const view = usePresetStore((state) => state.view);
  const revertAll = usePresetStore((state) => state.revertAll);
  const download = usePresetStore((state) => state.download);
  const isMutating = usePresetStore((state) => state.isMutating);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!view) return null;

  const groups = groupDiffByBlock(view.diff);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {view.modified ? (
          <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-300">
            Modified
          </span>
        ) : (
          <span className="rounded-full bg-hover px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Unchanged
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <UndoRedoButtons />
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={!view.modified || isMutating}
            className="btn-secondary"
          >
            Revert all
          </button>
          <button
            type="button"
            onClick={() => void download()}
            className="btn-primary"
            title={`Download ${view.filename}`}
          >
            Download .hlx
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-control border border-dashed border-editor-border bg-canvas/40 px-4 py-6 text-center text-xs leading-5 text-muted">
          No changes yet. Ask Bender for a tone change, or download the preset exactly as uploaded.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.id} className="rounded-control border border-editor-border bg-surface-raised">
              <p className="border-b border-editor-border px-3 py-2 text-sm font-medium text-primary">
                {group.label}
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="px-3 py-1.5 font-medium">Parameter</th>
                    <th className="px-3 py-1.5 font-medium">Before</th>
                    <th className="px-3 py-1.5 font-medium">After</th>
                  </tr>
                </thead>
                <tbody>
                  {group.changes.map((change) => (
                    <tr key={change.parameter} className="border-t border-editor-border/60">
                      <td className="px-3 py-1.5 text-secondary">{change.parameter}</td>
                      <td className="px-3 py-1.5 font-mono text-muted">
                        {formatDiffValue(change.before)}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-brand-300">
                        {formatDiffValue(change.after)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {view.edits.length > 0 ? <AuditTrail edits={view.edits} /> : null}

      <Dialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Revert all changes?"
        icon="↩"
      >
        <p className="text-sm text-secondary">
          This discards every edit Bender made and clears the conversation, returning to the preset
          exactly as you uploaded it. This cannot be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => setConfirmOpen(false)} className="btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              void revertAll();
              setConfirmOpen(false);
            }}
            className="btn-primary"
          >
            Revert everything
          </button>
        </div>
      </Dialog>
    </div>
  );
}

function AuditTrail({ edits }: { edits: EditEntry[] }) {
  return (
    <details className="rounded-control border border-editor-border bg-surface-raised">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-secondary">
        Edit history ({edits.length})
      </summary>
      <ol className="space-y-1 px-3 pb-3 pt-1">
        {edits.map((edit) => (
          <li key={edit.sequence} className="flex gap-2 text-[11px] leading-5">
            <span className="text-muted">{edit.sequence}.</span>
            <span className="text-secondary">
              <span className="text-muted">{describeTool(edit.tool)}:</span> {edit.summary}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
