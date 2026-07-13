import { ExportPanel } from '../components/ExportPanel';
import { NavBar } from '../components/NavBar';

export function Export() {
  return (
    <div className="min-h-screen flex flex-col bg-gray-950 text-white">
      <NavBar />

      <main className="flex-1 px-3 py-6 sm:px-4 md:px-6 md:py-10 safe-x safe-bottom">
        <div className="mx-auto max-w-4xl space-y-6">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-bold text-white md:text-3xl">내보내기 / Export</h1>
            <p className="mt-2 text-sm text-gray-400 md:text-base">
              Reels, Shorts, TikTok에 맞춘 세로형 포맷으로 프로젝트를 렌더링하세요.
              <span className="block text-gray-500">Render a 9:16 short-form master with H.264 video and mixed audio.</span>
            </p>
          </div>

          <ExportPanel />
        </div>
      </main>
    </div>
  );
}
