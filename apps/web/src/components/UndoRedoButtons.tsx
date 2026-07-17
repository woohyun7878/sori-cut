import { useProjectStore } from '../store/useProjectStore';

// Keyboard shortcuts for undo/redo live in useKeyboardShortcuts — this
// component only renders the buttons.
export function UndoRedoButtons() {
  const canUndo = useProjectStore((state) => state.canUndo);
  const canRedo = useProjectStore((state) => state.canRedo);
  const undo = useProjectStore((state) => state.undo);
  const redo = useProjectStore((state) => state.redo);

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={undo}
        disabled={!canUndo}
        className="rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 hover:bg-gray-800 hover:text-white disabled:hover:bg-transparent disabled:hover:text-gray-300"
        title="되돌리기 Undo (Ctrl+Z)"
        aria-label="되돌리기 Undo"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 015 5v2M3 10l5-5M3 10l5 5" />
        </svg>
      </button>
      <button
        type="button"
        onClick={redo}
        disabled={!canRedo}
        className="rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 hover:bg-gray-800 hover:text-white disabled:hover:bg-transparent disabled:hover:text-gray-300"
        title="다시 실행 Redo (Ctrl+Shift+Z)"
        aria-label="다시 실행 Redo"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 10H11a5 5 0 00-5 5v2M21 10l-5-5M21 10l-5 5" />
        </svg>
      </button>
    </div>
  );
}
