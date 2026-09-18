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
 * Every changed parameter with the value it started from, an audit trail of
 * the tool edits behind it, undo/redo driven by the server's history, a
 * confirmed "revert all", and a download of the current `.hlx` — modified or
 * not, with the modified state always visible.
 */
export function ChangesPanel() {
  const view = usePresetStore((state) => state.view);
  const revertAll = usePresetStore((state) => state.revertAll);
  const download = usePresetStore((state) => state.download);
  const isMutating = usePresetStore((state) => state.isMutating);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const groups = view ? groupDiffByBlock(view.diff) : [];
  const changeCount = view?.diff.length ?? 0;

  return (
    <section className="px-5 py-[18px]" aria-labelledby="review-label">
      <div className="flex items-center justify-between gap-4">
        <p className="eyebrow-lit" id="review-label">
          Review &amp; download
        </p>
        {view?.modified ? (
          <span className="pill pill-changed">{changeCount} changed</span>
        ) : (
          <span className="pill pill-idle">Unchanged</span>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="mt-3.5 rounded-control border border-dashed border-editor-border-strong p-4 text-center text-xs leading-[1.55] text-muted">
          {view
            ? 'No changes yet. Edited parameters appear here the moment Bender proposes them, with the value it started from.'
            : 'Changes appear here once a preset is loaded and Bender has proposed an edit.'}
        </p>
      ) : (
        <ul className="mt-3.5 grid gap-2">
          {groups.map((group) =>
            group.changes.map((change) => (
              <li
                key={`${group.id}:${change.parameter}`}
                className="flex items-baseline justify-between gap-3 text-xs"
              >
                <span className="min-w-0 truncate text-secondary">
                  {group.label} · {change.parameter}
                </span>
                <span className="flex-none font-mono text-muted">
                  {formatDiffValue(change.before)}
                  <span aria-hidden="true"> → </span>
                  <span className="sr-only">changed to</span>
                  <span className="text-brand-300">{formatDiffValue(change.after)}</span>
                </span>
              </li>
            )),
          )}
        </ul>
      )}

      <div className="mt-3.5 flex items-center gap-2">
        <UndoRedoButtons />
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={!view?.modified || isMutating}
          className="btn-pill"
        >
          Revert all
        </button>
        <button
          type="button"
          onClick={() => void download()}
          disabled={!view}
          className="btn-primary ml-auto px-4 text-[13px]"
          title={view ? `Download ${view.filename}` : undefined}
        >
          Download .hlx
        </button>
      </div>

      {view ? (
        <p className="mt-3.5 text-[11px] text-muted">
          {view.modified
            ? 'Downloads the edited preset. Your original file is never touched.'
            : 'Downloads the preset exactly as it was loaded.'}
        </p>
      ) : null}

      {view && view.edits.length > 0 ? <AuditTrail edits={view.edits} /> : null}

      <Dialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Revert all changes?"
        icon="↩"
      >
        <p className="text-sm text-secondary">
          This discards every edit Bender made and clears the conversation, returning to the preset
          exactly as you loaded it. This cannot be undone.
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
    </section>
  );
}

function AuditTrail({ edits }: { edits: EditEntry[] }) {
  return (
    <details className="mt-3.5 border-t border-editor-border pt-3">
      <summary className="cursor-pointer text-xs font-medium text-secondary">
        Edit history ({edits.length})
      </summary>
      <ol className="mt-2 space-y-1">
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
