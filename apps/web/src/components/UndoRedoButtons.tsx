import { usePresetStore } from '../store/usePresetStore';

// Keyboard shortcuts for undo/redo live in useKeyboardShortcuts — this
// component only renders the buttons.
export function UndoRedoButtons() {
  const canUndo = usePresetStore((state) => state.canUndo);
  const canRedo = usePresetStore((state) => state.canRedo);
  const undo = usePresetStore((state) => state.undo);
  const redo = usePresetStore((state) => state.redo);
  const isMutating = usePresetStore((state) => state.isMutating);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void undo()}
        disabled={!canUndo || isMutating}
        className="btn-secondary h-8 w-8 px-0"
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 015 5v2M3 10l5-5M3 10l5 5" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => void redo()}
        disabled={!canRedo || isMutating}
        className="btn-secondary h-8 w-8 px-0"
        title="Redo (Ctrl+Shift+Z)"
        aria-label="Redo"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 10H11a5 5 0 00-5 5v2M21 10l-5-5M21 10l-5 5" />
        </svg>
      </button>
    </div>
  );
}
