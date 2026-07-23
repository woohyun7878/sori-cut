import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AudioFile,
  Stem,
  Recording,
  VideoFile,
  TimelineTrack,
} from '../store/useProjectStore';

// --- Types ---

export interface BlobEntry {
  id: string;
  projectId: string;
  blob: Blob;
}

export interface SavedProjectMetadata {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Schema version the project was last saved with. */
  schemaVersion: number;
}

export interface SavedProject extends SavedProjectMetadata {
  originalAudio: (Omit<AudioFile, 'url' | 'blob'> & { blobId: string }) | null;
  stems: (Omit<Stem, 'url' | 'blob'> & { blobId: string })[];
  recordings: (Omit<Recording, 'url' | 'blob'> & { blobId: string })[];
  video: (Omit<VideoFile, 'url' | 'blob'> & { blobId: string }) | null;
  tracks: TimelineTrack[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

// --- DB Schema ---

interface SoriCutDB extends DBSchema {
  projects: {
    key: string;
    value: SavedProject;
    indexes: { 'by-updated': number };
  };
  blobs: {
    key: string;
    value: BlobEntry;
    indexes: { 'by-project': string };
  };
}

const DB_NAME = 'sori-cut-projects';
const DB_VERSION = 2;
const CURRENT_SCHEMA_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<SoriCutDB>> | null = null;

function getDB(): Promise<IDBPDatabase<SoriCutDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SoriCutDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
          projectStore.createIndex('by-updated', 'updatedAt');

          const blobStore = db.createObjectStore('blobs', { keyPath: 'id' });
          blobStore.createIndex('by-project', 'projectId');
        }
        // Version 2: no structural changes — only in-record schemaVersion field
        // added (written on next save). Existing records stay valid.
      },
    });
  }
  return dbPromise;
}

/** Exported for testing — resets the singleton so a fresh DB can be opened. */
export function _resetDB(): void {
  dbPromise = null;
}

function makeBlobId(projectId: string, category: string, itemId: string): string {
  return `${projectId}:${category}:${itemId}`;
}

// --- Errors ---

export class ProjectStorageError extends Error {
  constructor(
    message: string,
    public readonly code: 'SAVE_FAILED' | 'LOAD_FAILED' | 'DELETE_FAILED' | 'EXPORT_FAILED' | 'NOT_FOUND',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProjectStorageError';
  }
}

// --- Public API ---

export async function saveProject(
  projectId: string,
  projectName: string,
  state: {
    originalAudio: AudioFile | null;
    stems: Stem[];
    recordings: Recording[];
    video: VideoFile | null;
    tracks: TimelineTrack[];
  },
): Promise<void> {
  let db: IDBPDatabase<SoriCutDB>;
  try {
    db = await getDB();
  } catch (e) {
    throw new ProjectStorageError('Failed to open database', 'SAVE_FAILED', e);
  }

  const tx = db.transaction(['projects', 'blobs'], 'readwrite');

  try {
    const projectStore = tx.objectStore('projects');
    const blobStore = tx.objectStore('blobs');

    // Delete old blobs for this project
    const oldBlobIndex = blobStore.index('by-project');
    let cursor = await oldBlobIndex.openCursor(projectId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }

    const now = Date.now();
    const existing = await projectStore.get(projectId);

    // Store blobs and build saved state
    let savedAudio: SavedProject['originalAudio'] = null;
    if (state.originalAudio) {
      const blobId = makeBlobId(projectId, 'audio', state.originalAudio.id);
      await blobStore.put({ id: blobId, projectId, blob: state.originalAudio.blob });
      savedAudio = {
        id: state.originalAudio.id,
        name: state.originalAudio.name,
        duration: state.originalAudio.duration,
        blobId,
      };
    }

    const savedStems: SavedProject['stems'] = [];
    for (const stem of state.stems) {
      const blobId = makeBlobId(projectId, 'stem', stem.id);
      await blobStore.put({ id: blobId, projectId, blob: stem.blob });
      savedStems.push({
        id: stem.id,
        name: stem.name,
        label: stem.label,
        muted: stem.muted,
        volume: stem.volume,
        solo: stem.solo,
        blobId,
      });
    }

    const savedRecordings: SavedProject['recordings'] = [];
    for (const rec of state.recordings) {
      const blobId = makeBlobId(projectId, 'recording', rec.id);
      await blobStore.put({ id: blobId, projectId, blob: rec.blob });
      savedRecordings.push({
        id: rec.id,
        name: rec.name,
        duration: rec.duration,
        createdAt: rec.createdAt,
        blobId,
      });
    }

    let savedVideo: SavedProject['video'] = null;
    if (state.video) {
      const blobId = makeBlobId(projectId, 'video', state.video.id);
      await blobStore.put({ id: blobId, projectId, blob: state.video.blob });
      savedVideo = {
        id: state.video.id,
        name: state.video.name,
        duration: state.video.duration,
        width: state.video.width,
        height: state.video.height,
        blobId,
      };
    }

    const project: SavedProject = {
      id: projectId,
      name: projectName,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      originalAudio: savedAudio,
      stems: savedStems,
      recordings: savedRecordings,
      video: savedVideo,
      tracks: state.tracks,
    };

    await projectStore.put(project);
    await tx.done;
  } catch (e) {
    // Transaction auto-aborts on throw; no partial writes persist.
    tx.abort();
    throw new ProjectStorageError(
      `Failed to save project "${projectName}" (${projectId})`,
      'SAVE_FAILED',
      e,
    );
  }
}

export interface LoadedProject {
  metadata: SavedProjectMetadata;
  originalAudio: AudioFile | null;
  stems: Stem[];
  recordings: Recording[];
  video: VideoFile | null;
  tracks: TimelineTrack[];
}

/**
 * Loads a project from IndexedDB. Created blob URLs are tracked internally;
 * if an error occurs mid-load, all URLs created so far are revoked to prevent leaks.
 */
export async function loadProject(id: string): Promise<LoadedProject | null> {
  const createdUrls: string[] = [];

  function createTrackedUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    createdUrls.push(url);
    return url;
  }

  function revokeAllCreatedUrls(): void {
    for (const url of createdUrls) {
      URL.revokeObjectURL(url);
    }
    createdUrls.length = 0;
  }

  let db: IDBPDatabase<SoriCutDB>;
  try {
    db = await getDB();
  } catch (e) {
    throw new ProjectStorageError('Failed to open database', 'LOAD_FAILED', e);
  }

  try {
    const tx = db.transaction(['projects', 'blobs'], 'readonly');
    const projectStore = tx.objectStore('projects');
    const blobStore = tx.objectStore('blobs');

    const project = await projectStore.get(id);
    if (!project) return null;

    // Reconstruct audio
    let originalAudio: AudioFile | null = null;
    if (project.originalAudio) {
      const entry = await blobStore.get(project.originalAudio.blobId);
      if (entry) {
        originalAudio = {
          id: project.originalAudio.id,
          name: project.originalAudio.name,
          duration: project.originalAudio.duration,
          blob: entry.blob,
          url: createTrackedUrl(entry.blob),
        };
      }
    }

    // Reconstruct stems
    const stems: Stem[] = [];
    for (const s of project.stems) {
      const entry = await blobStore.get(s.blobId);
      if (entry) {
        stems.push({
          id: s.id,
          name: s.name,
          label: s.label,
          muted: s.muted,
          volume: s.volume,
          solo: s.solo,
          blob: entry.blob,
          url: createTrackedUrl(entry.blob),
        });
      }
    }

    // Reconstruct recordings
    const recordings: Recording[] = [];
    for (const r of project.recordings) {
      const entry = await blobStore.get(r.blobId);
      if (entry) {
        recordings.push({
          id: r.id,
          name: r.name,
          duration: r.duration,
          createdAt: r.createdAt,
          blob: entry.blob,
          url: createTrackedUrl(entry.blob),
        });
      }
    }

    // Reconstruct video
    let video: VideoFile | null = null;
    if (project.video) {
      const entry = await blobStore.get(project.video.blobId);
      if (entry) {
        video = {
          id: project.video.id,
          name: project.video.name,
          duration: project.video.duration,
          width: project.video.width,
          height: project.video.height,
          blob: entry.blob,
          url: createTrackedUrl(entry.blob),
        };
      }
    }

    // Rebuild track sourceUrls from loaded blobs
    const tracks: TimelineTrack[] = (project.tracks ?? []).map((t) => {
      let sourceUrl = t.sourceUrl;
      if (t.id === 'audio-original' && originalAudio) {
        sourceUrl = originalAudio.url;
      } else if (t.id.startsWith('stem-')) {
        const stemId = t.id.replace('stem-', '');
        const stem = stems.find((s) => s.id === stemId);
        if (stem) sourceUrl = stem.url;
      } else if (t.id.startsWith('recording-')) {
        const recId = t.id.replace('recording-', '');
        const rec = recordings.find((r) => r.id === recId);
        if (rec) sourceUrl = rec.url;
      } else if (t.id === 'video-track' && video) {
        sourceUrl = video.url;
      }
      return {
        ...t,
        sourceUrl,
        // Migrate projects saved before source trim and signed sync metadata existed.
        sourceStartOffset: t.sourceStartOffset ?? 0,
        syncOffset: t.syncOffset ?? t.startOffset - (t.sourceStartOffset ?? 0),
        syncBaseSourceStartOffset: t.syncBaseSourceStartOffset ?? t.sourceStartOffset ?? 0,
        syncBaseDuration: t.syncBaseDuration ?? t.duration,
      };
    });

    return {
      metadata: {
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        schemaVersion: project.schemaVersion ?? 1,
      },
      originalAudio,
      stems,
      recordings,
      video,
      tracks,
    };
  } catch (e) {
    // Clean up any blob URLs we've already created before re-throwing.
    revokeAllCreatedUrls();
    throw new ProjectStorageError(
      `Failed to load project (${id})`,
      'LOAD_FAILED',
      e,
    );
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex('projects', 'by-updated');
  return all
    .map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }))
    .reverse(); // Most recent first
}

export async function deleteProject(id: string): Promise<void> {
  let db: IDBPDatabase<SoriCutDB>;
  try {
    db = await getDB();
  } catch (e) {
    throw new ProjectStorageError('Failed to open database', 'DELETE_FAILED', e);
  }

  const tx = db.transaction(['projects', 'blobs'], 'readwrite');
  try {
    const blobStore = tx.objectStore('blobs');
    const blobIndex = blobStore.index('by-project');

    let cursor = await blobIndex.openCursor(id);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }

    await tx.objectStore('projects').delete(id);
    await tx.done;
  } catch (e) {
    tx.abort();
    throw new ProjectStorageError(`Failed to delete project (${id})`, 'DELETE_FAILED', e);
  }
}

export async function exportProject(id: string): Promise<Blob> {
  let db: IDBPDatabase<SoriCutDB>;
  try {
    db = await getDB();
  } catch (e) {
    throw new ProjectStorageError('Failed to open database', 'EXPORT_FAILED', e);
  }

  const tx = db.transaction(['projects', 'blobs'], 'readonly');
  const project = await tx.objectStore('projects').get(id);
  if (!project) {
    throw new ProjectStorageError(`Project ${id} not found`, 'NOT_FOUND');
  }

  try {
    const blobIndex = tx.objectStore('blobs').index('by-project');
    const blobs: Record<string, string> = {};

    let cursor = await blobIndex.openCursor(id);
    while (cursor) {
      const entry = cursor.value;
      // Use Response as a universal way to read blob data (works in all environments)
      const arrayBuffer = typeof entry.blob.arrayBuffer === 'function'
        ? await entry.blob.arrayBuffer()
        : await new Response(entry.blob).arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
      );
      blobs[entry.id] = `data:${entry.blob.type};base64,${base64}`;
      cursor = await cursor.continue();
    }

    const archive = JSON.stringify({ version: CURRENT_SCHEMA_VERSION, project, blobs });
    return new Blob([archive], { type: 'application/json' });
  } catch (e) {
    throw new ProjectStorageError(`Failed to export project (${id})`, 'EXPORT_FAILED', e);
  }
}
