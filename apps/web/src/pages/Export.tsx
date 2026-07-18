import { Link } from 'react-router-dom';
import { ExportPanel } from '../components/ExportPanel';

export function Export() {
  return (
    <div className="min-h-screen flex flex-col bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <Link to="/studio" className="text-xl font-bold">
          <span className="text-brand-400">소리</span>컷
        </Link>
        <Link
          to="/studio"
          className="px-4 py-2 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-sm font-medium transition-colors"
        >
          ← Back to Studio
        </Link>
      </nav>

      <main className="flex-1 px-6 py-10">
        <div className="mx-auto max-w-4xl space-y-6">
          <div className="max-w-2xl">
            <h1 className="text-3xl font-bold text-white">Export</h1>
            <p className="mt-2 text-gray-400">
              Render your project as a vertical 9:16 short-form video with H.264 video and mixed audio.
            </p>
          </div>

          <ExportPanel />
        </div>
      </main>
    </div>
  );
}
