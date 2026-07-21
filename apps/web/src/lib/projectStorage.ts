import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AudioFile, Stem, Recording, VideoFile, TimelineTrack } from '../store/useProjectStore';

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
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<SoriCutDB>> | null = null;

function getDB(): Promise<IDBPDatabase<SoriCutDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SoriCutDB>(DB_NAME, DB_VERSION, {
      upgrade(db: IDBPDatabase<SoriCutDB>) {
        const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
        projectStore.createIndex('by-updated', 'updatedAt');

        const blobStore = db.createObjectStore('blobs', { keyPath: 'id' });
        blobStore.createIndex('by-project', 'projectId');
      },
    });
  }
  return dbPromise!;
}

function makeBlobId(projectId: string, category: string, itemId: string): string {
  return `${projectId}:${category}:${itemId}`;
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
  const db = await getDB();
  const tx = db.transaction(['projects', 'blobs'], 'readwrite');
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
    originalAudio: savedAudio,
    stems: savedStems,
    recordings: savedRecordings,
    video: savedVideo,
    tracks: state.tracks,
  };

  await projectStore.put(project);
  await tx.done;
}

export interface LoadedProject {
  metadata: SavedProjectMetadata;
  originalAudio: AudioFile | null;
  stems: Stem[];
  recordings: Recording[];
  video: VideoFile | null;
  tracks: TimelineTrack[];
}

export async function loadProject(id: string): Promise<LoadedProject | null> {
  const db = await getDB();
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
        url: URL.createObjectURL(entry.blob),
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
        url: URL.createObjectURL(entry.blob),
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
        url: URL.createObjectURL(entry.blob),
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
        url: URL.createObjectURL(entry.blob),
      };
    }
  }

  // Rebuild track sourceUrls from loaded blobs
  const urlMap = new Map<string, string>();
  if (originalAudio) urlMap.set(originalAudio.id, originalAudio.url);
  stems.forEach((s) => urlMap.set(s.id, s.url));
  recordings.forEach((r) => urlMap.set(r.id, r.url));
  if (video) urlMap.set(video.id, video.url);

  const tracks: TimelineTrack[] = project.tracks.map((t) => {
    // Try to match track to a loaded asset's URL
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
      // Migrate projects saved before sourceStartOffset and syncOffset existed.
      sourceStartOffset: t.sourceStartOffset ?? 0,
      syncOffset: t.syncOffset ?? t.startOffset,
    };
  });

  return {
    metadata: {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    originalAudio,
    stems,
    recordings,
    video,
    tracks,
  };
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
  const db = await getDB();
  const tx = db.transaction(['projects', 'blobs'], 'readwrite');
  const blobStore = tx.objectStore('blobs');
  const blobIndex = blobStore.index('by-project');

  let cursor = await blobIndex.openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }

  await tx.objectStore('projects').delete(id);
  await tx.done;
}

export async function exportProject(id: string): Promise<Blob> {
  const db = await getDB();
  const tx = db.transaction(['projects', 'blobs'], 'readonly');
  const project = await tx.objectStore('projects').get(id);
  if (!project) throw new Error(`Project ${id} not found`);

  const blobIndex = tx.objectStore('blobs').index('by-project');
  const blobs: Record<string, string> = {};

  let cursor = await blobIndex.openCursor(id);
  while (cursor) {
    const entry = cursor.value;
    const arrayBuffer = await entry.blob.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
    );
    blobs[entry.id] = `data:${entry.blob.type};base64,${base64}`;
    cursor = await cursor.continue();
  }

  const archive = JSON.stringify({ version: 1, project, blobs });
  return new Blob([archive], { type: 'application/json' });
}
