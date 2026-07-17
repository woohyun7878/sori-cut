interface ShortcutHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const shortcuts = [
  { key: 'Space', desc: 'Play / Pause' },
  { key: 'Escape', desc: 'Stop' },
  { key: 'R', desc: 'Toggle recording' },
  { key: 'Ctrl+S', desc: 'Save project' },
  { key: 'Ctrl+Z', desc: 'Undo' },
  { key: 'Ctrl+Shift+Z', desc: 'Redo' },
  { key: '[', desc: 'Back 5s' },
  { key: ']', desc: 'Forward 5s' },
  { key: 'M', desc: 'Toggle mute' },
  { key: 'L', desc: 'Toggle loop' },
  { key: '?', desc: 'This help' },
];

export function ShortcutHelpModal({ isOpen, onClose }: ShortcutHelpModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-gray-700 bg-gray-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">⌨️ Shortcuts</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-800 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          {shortcuts.map((s) => (
            <div key={s.key} className="contents">
              <kbd className="rounded bg-gray-800 px-2 py-1 text-xs font-mono text-brand-300">{s.key}</kbd>
              <span className="text-sm text-gray-300">{s.desc}</span>
            </div>
          ))}
        </div>

        <p className="mt-4 text-xs text-gray-500">macOS: Ctrl → Cmd</p>
      </div>
    </div>
  );
}
