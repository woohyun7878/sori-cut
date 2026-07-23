import { useCallback, useEffect, useState } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import {
  listProjects,
  deleteProject,
  loadProject,
  type ProjectSummary,
} from '../lib/projectStorage';
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
      projectName: 'New Project',
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
    const confirmed = window.confirm('Are you sure you want to delete this project?');
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
        return 'Saving...';
      case 'saved':
        return 'Saved';
      case 'error':
        return 'Save failed';
      default:
        return '';
    }
  })();

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="relative">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="studio-secondary-button"
          aria-expanded={isOpen}
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
          </svg>
          Projects
        </button>

        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          className="h-8 w-48 min-w-0 rounded-control border border-editor-border bg-canvas px-2.5 text-[13px] text-primary focus:border-brand-500"
          placeholder="Project name"
          aria-label="Project name"
        />

        <span
          role="status"
          aria-live="polite"
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
      </div>

      {/* Dropdown project list */}
      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-editor border border-editor-border bg-surface-raised shadow-xl">
          <div className="flex h-12 items-center justify-between border-b border-editor-border px-3">
            <h3 className="text-sm font-semibold text-white">Projects</h3>
            <button
              type="button"
              onClick={handleNewProject}
              className="h-8 rounded-control bg-brand-600 px-3 text-xs font-medium text-white transition-colors hover:bg-brand-700"
            >
              + New Project
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {projects.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-gray-500">No saved projects.</p>
            ) : (
              projects.map((p) => (
                <div
                  key={p.id}
                  className={`flex min-h-12 items-center justify-between border-b border-editor-border px-3 transition-colors last:border-b-0 hover:bg-hover ${
                    p.id === projectId ? 'bg-gray-800/50' : ''
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleLoad(p.id)}
                    aria-current={p.id === projectId ? 'true' : undefined}
                    className="min-w-0 flex-1 py-2 text-left"
                  >
                    <span className="block truncate text-sm font-medium text-white">{p.name}</span>
                    <span className="block text-xs text-gray-500">{formatDate(p.updatedAt)}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(p.id)}
                    className="ml-2 rounded p-1 text-gray-500 hover:bg-red-900/30 hover:text-red-400 transition-colors"
                    aria-label={`Delete project ${p.name}`}
                    title="Delete project"
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
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
