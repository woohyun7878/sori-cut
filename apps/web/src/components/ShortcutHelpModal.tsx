interface ShortcutHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const shortcuts = [
  { key: 'Space', desc: '재생 / 일시정지 (Play / Pause)' },
  { key: 'Escape', desc: '정지 (Stop)' },
  { key: 'R', desc: '녹음 토글 (Record)' },
  { key: 'Ctrl+S', desc: '프로젝트 저장 (Save)' },
  { key: 'Ctrl+Z', desc: '되돌리기 (Undo)' },
  { key: 'Ctrl+Shift+Z', desc: '다시 실행 (Redo)' },
  { key: '[', desc: '5초 뒤로 (Back 5s)' },
  { key: ']', desc: '5초 앞으로 (Forward 5s)' },
  { key: 'M', desc: '트랙 음소거 토글 (Mute)' },
  { key: 'L', desc: '반복 재생 토글 (Loop)' },
  { key: '?', desc: '단축키 도움말 (This help)' },
];

export function ShortcutHelpModal({ isOpen, onClose }: ShortcutHelpModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="단축키 도움말"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-gray-700 bg-gray-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">⌨️ 단축키 / Shortcuts</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-800 hover:text-white"
            aria-label="닫기"
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
