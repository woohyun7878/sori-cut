import { useCallback, useEffect, useState } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import { listProjects, deleteProject, loadProject, type ProjectSummary } from '../lib/projectStorage';
import type { SaveStatus } from '../hooks/useAutoSave';

interface ProjectManagerProps {
  saveStatus: SaveStatus;
}

export function ProjectManager({ saveStatus }: ProjectManagerProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const projectId = useProjectStore((s) => s.projectId);
  const projectName = useProjectStore((s) => s.projectName);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const loadFromSaved = useProjectStore((s) => s.loadFromSaved);
  const reset = useProjectStore((s) => s.reset);

  const refreshList = useCallback(async () => {
    const list = await listProjects();
    setProjects(list);
  }, []);

  useEffect(() => {
    if (isOpen) refreshList();
  }, [isOpen, refreshList]);

  const handleNewProject = () => {
    reset();
    // Store will generate a new projectId on reset via loadFromSaved
    loadFromSaved({
      projectId: crypto.randomUUID(),
      projectName: '새 프로젝트',
    });
    refreshList();
  };

  const handleLoad = async (id: string) => {
    if (id === projectId) {
      setIsOpen(false);
      return;
    }

    const loaded = await loadProject(id);
    if (!loaded) return;

    reset();
    loadFromSaved({
      projectId: loaded.metadata.id,
      projectName: loaded.metadata.name,
      originalAudio: loaded.originalAudio,
      stems: loaded.stems,
      recordings: loaded.recordings,
      video: loaded.video,
      tracks: loaded.tracks,
    });
    setIsOpen(false);
  };

  const handleDelete = async (id: string) => {
    const confirmed = window.confirm('정말 삭제하시겠습니까?');
    if (!confirmed) return;
    await deleteProject(id);
    if (id === projectId) {
      handleNewProject();
    }
    refreshList();
  };

  const statusLabel = (() => {
    switch (saveStatus) {
      case 'saving':
        return '저장 중... / Saving...';
      case 'saved':
        return '저장됨 / Saved';
      case 'error':
        return '저장 실패 / Save failed';
      default:
        return '';
    }
  })();

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleString('ko-KR', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="relative">
      {/* Compact top bar */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          프로젝트 / Projects
        </button>

        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-white focus:border-brand-500 focus:outline-none w-48"
          placeholder="프로젝트 이름"
        />

        {statusLabel && (
          <span
            className={`text-xs ${
              saveStatus === 'saving'
                ? 'text-yellow-400'
                : saveStatus === 'saved'
                  ? 'text-green-400'
                  : saveStatus === 'error'
                    ? 'text-red-400'
                    : 'text-gray-500'
            }`}
          >
            {statusLabel}
          </span>
        )}
      </div>

      {/* Dropdown project list */}
      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 rounded-xl border border-gray-700 bg-gray-900 shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-700 px-4 py-3">
            <h3 className="text-sm font-semibold text-white">프로젝트 목록 / Projects</h3>
            <button
              onClick={handleNewProject}
              className="rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 transition-colors"
            >
              + 새 프로젝트
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {projects.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-gray-500">
                저장된 프로젝트가 없습니다.
              </p>
            ) : (
              projects.map((p) => (
                <div
                  key={p.id}
                  className={`flex items-center justify-between px-4 py-3 hover:bg-gray-800 transition-colors cursor-pointer border-b border-gray-800 last:border-b-0 ${
                    p.id === projectId ? 'bg-gray-800/50' : ''
                  }`}
                  onClick={() => handleLoad(p.id)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{p.name}</p>
                    <p className="text-xs text-gray-500">{formatDate(p.updatedAt)}</p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(p.id);
                    }}
                    className="ml-2 rounded p-1 text-gray-500 hover:bg-red-900/30 hover:text-red-400 transition-colors"
                    title="삭제"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
