import { Link } from 'react-router-dom';

export function Export() {
  return (
    <div className="min-h-screen flex flex-col">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <Link to="/" className="text-xl font-bold">
          <span className="text-brand-400">소리</span>컷
        </Link>
        <Link
          to="/studio"
          className="px-4 py-2 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-sm font-medium transition-colors"
        >
          ← 스튜디오로 돌아가기
        </Link>
      </nav>

      <main className="flex-1 flex items-center justify-center px-6">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-6">📤</div>
          <h2 className="text-2xl font-bold mb-2">내보내기</h2>
          <p className="text-gray-400 mb-8">
            숏폼 플랫폼에 최적화된 포맷으로 내보내세요.
            <br />
            <span className="text-gray-500">Export optimized for short-form platforms.</span>
          </p>

          <div className="space-y-3">
            <ExportOption platform="Instagram Reels" format="9:16 · 1080×1920" />
            <ExportOption platform="YouTube Shorts" format="9:16 · 1080×1920" />
            <ExportOption platform="TikTok" format="9:16 · 1080×1920" />
          </div>

          <p className="mt-8 text-sm text-gray-500">
            Coming soon — 곧 출시됩니다
          </p>
        </div>
      </main>
    </div>
  );
}

function ExportOption({ platform, format }: { platform: string; format: string }) {
  return (
    <div className="flex items-center justify-between p-4 rounded-xl bg-gray-900 border border-gray-800">
      <span className="font-medium text-white">{platform}</span>
      <span className="text-sm text-gray-500">{format}</span>
    </div>
  );
}
