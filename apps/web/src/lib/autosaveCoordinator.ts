import { saveProject } from './projectStorage';
import type { ProjectState } from '../store/useProjectStore';

// --- Types ---

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** Immutable snapshot of the data needed to persist a single project. */
export interface SaveSnapshot {
  projectId: string;
  projectName: string;
  originalAudio: ProjectState['originalAudio'];
  stems: ProjectState['stems'];
  recordings: ProjectState['recordings'];
  video: ProjectState['video'];
  tracks: ProjectState['tracks'];
}

interface VersionedSnapshot {
  snapshot: SaveSnapshot;
  generation: number;
}

export type StatusListener = (status: SaveStatus) => void;

// --- Coordinator (module-level singleton) ---

const DEBOUNCE_MS = 2000;
const MAX_RETRIES = 2;

/** Monotonically increasing generation per project. */
let generationCounter = 0;

/** Pending snapshots keyed by projectId, with their generation. */
const queue = new Map<string, VersionedSnapshot>();

/** Tombstoned project IDs — snapshots for these are discarded, never persisted. */
const tombstones = new Set<string>();

/** Tracks the highest generation that has been successfully written per project. */
const committedGenerations = new Map<string, number>();

let isFlushing = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const statusListeners = new Set<StatusListener>();
let currentStatus: SaveStatus = 'idle';

function setStatus(status: SaveStatus): void {
  currentStatus = status;
  for (const listener of statusListeners) {
    try { listener(status); } catch { /* listener errors must not break coordinator */ }
  }
}

async function persistSnapshot(entry: VersionedSnapshot): Promise<void> {
  const { snapshot, generation } = entry;

  // Skip if tombstoned
  if (tombstones.has(snapshot.projectId)) return;

  // Skip if a newer generation has already been committed
  const committed = committedGenerations.get(snapshot.projectId) ?? -1;
  if (generation <= committed) return;

  await saveProject(snapshot.projectId, snapshot.projectName, {
    originalAudio: snapshot.originalAudio,
    stems: snapshot.stems,
    recordings: snapshot.recordings,
    video: snapshot.video,
    tracks: snapshot.tracks,
  });

  // Mark committed (only if we're still the latest — a newer gen may have been committed concurrently)
  const currentCommitted = committedGenerations.get(snapshot.projectId) ?? -1;
  if (generation > currentCommitted) {
    committedGenerations.set(snapshot.projectId, generation);
  }
}

/**
 * Drain the queue: process each entry, retaining failed/unattempted entries on error.
 * On failure for a project, that project's entry stays in the queue for retry
 * but we continue processing other projects. This ensures one failing project
 * doesn't block saves for unrelated projects.
 */
async function drain(): Promise<void> {
  if (isFlushing) return;
  if (queue.size === 0) return;

  isFlushing = true;
  setStatus('saving');

  let hadError = false;

  try {
    // Take a snapshot of current entries to process
    const entries = [...queue.entries()];

    for (const [projectId, entry] of entries) {
      // Skip tombstoned
      if (tombstones.has(projectId)) {
        queue.delete(projectId);
        continue;
      }

      let retries = 0;
      let succeeded = false;

      while (retries <= MAX_RETRIES) {
        try {
          await persistSnapshot(entry);
          succeeded = true;
          break;
        } catch (err) {
          retries++;
          if (retries > MAX_RETRIES) {
            console.error(`[autosaveCoordinator] Save failed for ${projectId} after ${MAX_RETRIES} retries:`, err);
            hadError = true;
          }
        }
      }

      if (succeeded) {
        // Only remove from queue if no newer snapshot arrived while we were writing
        const current = queue.get(projectId);
        if (current && current.generation === entry.generation) {
          queue.delete(projectId);
        }
        // If a newer generation arrived, it stays in the queue for the next drain
      }
      // If failed: entry remains in queue (never removed on failure),
      // and we continue to process other projects.
    }
  } finally {
    isFlushing = false;
  }

  if (hadError) {
    setStatus('error');
    // Schedule a retry after a delay for remaining items
    scheduleDrain();
  } else if (queue.size > 0) {
    // New items arrived during flush
    scheduleDrain();
  } else {
    setStatus('saved');
  }
}

function scheduleDrain(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    drain();
  }, DEBOUNCE_MS);
}

// --- Public API ---

/**
 * Enqueue a snapshot for persistence. The snapshot is captured immutably by the caller
 * at the moment of state change. Each project keeps only its latest snapshot (highest gen).
 */
export function enqueue(snapshot: SaveSnapshot): void {
  if (!snapshot.projectId) return;
  if (tombstones.has(snapshot.projectId)) return;

  const generation = ++generationCounter;
  queue.set(snapshot.projectId, { snapshot, generation });
  scheduleDrain();
}

/**
 * Cancel all pending/in-flight work for a project and tombstone it so no future
 * queued or completing save can resurrect it. Call this BEFORE deleteProject().
 */
export function cancelProject(projectId: string): void {
  tombstones.add(projectId);
  queue.delete(projectId);
}

/**
 * Best-effort synchronous-start flush of ALL queued snapshots.
 * Used on beforeunload. Returns the promise but callers may not await it.
 */
export function flushAll(): Promise<void> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  // Also capture the current project state as a final snapshot
  return drain();
}

/**
 * Flush immediately (awaitable). Used by saveNow / unmount.
 */
export async function flushNow(): Promise<void> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  await drain();
}

/** Subscribe to status changes. Returns unsubscribe function. */
export function onStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

/** Get current status. */
export function getStatus(): SaveStatus {
  return currentStatus;
}

/** Check if a project is tombstoned. */
export function isTombstoned(projectId: string): boolean {
  return tombstones.has(projectId);
}

/** Check if there are pending snapshots. */
export function hasPending(): boolean {
  return queue.size > 0;
}

/**
 * Reset coordinator state. Exported for testing only.
 * Clears queue, tombstones, committed generations, and resets counters.
 */
export function _reset(): void {
  queue.clear();
  tombstones.clear();
  committedGenerations.clear();
  generationCounter = 0;
  isFlushing = false;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  statusListeners.clear();
  currentStatus = 'idle';
}

/** Capture a snapshot from a ProjectState. */
export function captureSnapshot(state: ProjectState): SaveSnapshot {
  return {
    projectId: state.projectId,
    projectName: state.projectName,
    originalAudio: state.originalAudio,
    stems: state.stems,
    recordings: state.recordings,
    video: state.video,
    tracks: state.tracks,
  };
}
