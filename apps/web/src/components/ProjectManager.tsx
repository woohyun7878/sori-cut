import { useCallback, useEffect, useState } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import {
  listProjects,
  deleteProject,
  loadProject,
  type ProjectSummary,
} from '../lib/projectStorage';
import { cancelProject } from '../lib/autosaveCoordinator';
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

  const refreshList = useCallback(async () => {
    const list = await listProjects();
    setProjects(list);
  }, []);

  useEffect(() => {
    if (isOpen) refreshList();
  }, [isOpen, refreshList]);

  const handleNewProject = () => {
    // Atomic switch: loadFromSaved handles revoking old URLs.
    loadFromSaved({
      projectId: crypto.randomUUID(),
      projectName: 'New Project',
      originalAudio: null,
      stems: [],
      recordings: [],
      video: null,
      tracks: [],
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

    // Atomic load — loadFromSaved handles revoking old URLs internally.
    // No intermediate reset() call so autosave never sees a transient empty state.
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
    // Tombstone in coordinator BEFORE delete — prevents queued/in-flight saves
    // from resurrecting the project.
    cancelProject(id);
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
        <button onClick={() => setIsOpen(!isOpen)} className="studio-secondary-button">
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
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
        <div className="absolute left-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-editor border border-editor-border bg-surface-raised shadow-xl">
          <div className="flex h-12 items-center justify-between border-b border-editor-border px-3">
            <h3 className="text-sm font-semibold text-white">Projects</h3>
            <button
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
                    title="Delete"
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
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
