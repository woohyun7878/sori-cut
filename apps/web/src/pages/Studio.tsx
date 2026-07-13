import { Link } from 'react-router-dom';

export function Studio() {
  return (
    <div className="min-h-screen flex flex-col">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <Link to="/" className="text-xl font-bold">
          <span className="text-brand-400">소리</span>컷
        </Link>
        <div className="flex gap-4">
          <Link
            to="/export"
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
          >
            내보내기 Export
          </Link>
        </div>
      </nav>

      <main className="flex-1 flex items-center justify-center px-6">
        <div className="text-center">
          <div className="text-6xl mb-6">🎙️</div>
          <h2 className="text-2xl font-bold mb-2">스튜디오</h2>
          <p className="text-gray-400 mb-8">
            녹음, 편집, 싱크를 모두 여기서 — Record, edit, and sync all in one place.
          </p>
          <div className="grid grid-cols-3 gap-4 max-w-md mx-auto text-sm">
            <div className="p-4 rounded-xl bg-gray-900 border border-gray-800">
              <div className="text-2xl mb-2">🎛️</div>
              <p className="text-gray-300">스템 분리</p>
            </div>
            <div className="p-4 rounded-xl bg-gray-900 border border-gray-800">
              <div className="text-2xl mb-2">🎸</div>
              <p className="text-gray-300">녹음</p>
            </div>
            <div className="p-4 rounded-xl bg-gray-900 border border-gray-800">
              <div className="text-2xl mb-2">✂️</div>
              <p className="text-gray-300">편집</p>
            </div>
          </div>
          <p className="mt-8 text-sm text-gray-500">
            Coming soon — 곧 출시됩니다
          </p>
        </div>
      </main>
    </div>
  );
}
