import { useEffect, useRef, useCallback } from 'react';
import { useProjectStore, type ProjectState } from '../store/useProjectStore';
import { saveProject } from '../lib/projectStorage';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const DEBOUNCE_MS = 2000;

/** Immutable snapshot of the data needed to persist a single project. */
interface SaveSnapshot {
  projectId: string;
  projectName: string;
  originalAudio: ProjectState['originalAudio'];
  stems: ProjectState['stems'];
  recordings: ProjectState['recordings'];
  video: ProjectState['video'];
  tracks: ProjectState['tracks'];
}

function captureSnapshot(state: ProjectState): SaveSnapshot {
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

export function useAutoSave(onStatusChange?: (status: SaveStatus) => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  /** Per-project pending snapshots — ensures each project gets its own final state. */
  const pendingSnapshotsRef = useRef<Map<string, SaveSnapshot>>(new Map());
  const statusRef = useRef<SaveStatus>('idle');
  const mountedRef = useRef(true);

  const setStatus = useCallback(
    (status: SaveStatus) => {
      statusRef.current = status;
      if (mountedRef.current) {
        onStatusChange?.(status);
      }
    },
    [onStatusChange],
  );

  const flushSnapshot = useCallback(
    async (snapshot: SaveSnapshot): Promise<void> => {
      await saveProject(snapshot.projectId, snapshot.projectName, {
        originalAudio: snapshot.originalAudio,
        stems: snapshot.stems,
        recordings: snapshot.recordings,
        video: snapshot.video,
        tracks: snapshot.tracks,
      });
    },
    [],
  );

  const drainQueue = useCallback(async () => {
    if (isSavingRef.current) return;
    const pending = pendingSnapshotsRef.current;
    if (pending.size === 0) return;

    isSavingRef.current = true;
    setStatus('saving');

    try {
      // Process all queued project snapshots
      while (pending.size > 0) {
        const entries = [...pending.entries()];
        pending.clear();

        for (const [, snapshot] of entries) {
          await flushSnapshot(snapshot);
        }
      }

      // Report success relative to the current project
      const currentId = useProjectStore.getState().projectId;
      if (!pending.has(currentId)) {
        setStatus('saved');
      }
    } catch (err) {
      console.error('[useAutoSave] Save failed:', err);
      setStatus('error');
    } finally {
      isSavingRef.current = false;
      // Re-drain in case new snapshots arrived while we were saving
      if (pending.size > 0) {
        drainQueue();
      }
    }
  }, [setStatus, flushSnapshot]);

  const enqueueAndSchedule = useCallback(() => {
    // Capture an immutable snapshot at the moment of the change
    const snapshot = captureSnapshot(useProjectStore.getState());
    if (!snapshot.projectId) return;
    pendingSnapshotsRef.current.set(snapshot.projectId, snapshot);

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      drainQueue();
    }, DEBOUNCE_MS);
  }, [drainQueue]);

  // Subscribe to store changes
  useEffect(() => {
    mountedRef.current = true;
    const pending = pendingSnapshotsRef.current;

    const unsub = useProjectStore.subscribe((state, prev) => {
      // Only save on data-bearing changes, ignore transient playback state
      if (
        state.originalAudio !== prev.originalAudio ||
        state.stems !== prev.stems ||
        state.recordings !== prev.recordings ||
        state.video !== prev.video ||
        state.tracks !== prev.tracks ||
        state.projectName !== prev.projectName
      ) {
        enqueueAndSchedule();
      }
    });

    return () => {
      unsub();
      mountedRef.current = false;

      // Flush any pending snapshot on unmount to avoid losing edits
      // when navigating away (e.g. Studio→Export).
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (pending.size > 0 && !isSavingRef.current) {
        // Fire-and-forget flush (no state updates post-unmount)
        const entries = [...pending.entries()];
        pending.clear();
        for (const [, snapshot] of entries) {
          saveProject(snapshot.projectId, snapshot.projectName, {
            originalAudio: snapshot.originalAudio,
            stems: snapshot.stems,
            recordings: snapshot.recordings,
            video: snapshot.video,
            tracks: snapshot.tracks,
          }).catch(() => {});
        }
      }
    };
  }, [enqueueAndSchedule]);

  // Save on beforeunload
  useEffect(() => {
    const handleUnload = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      // Flush the latest snapshot for the current project
      const snapshot = captureSnapshot(useProjectStore.getState());
      if (snapshot.projectId) {
        saveProject(snapshot.projectId, snapshot.projectName, {
          originalAudio: snapshot.originalAudio,
          stems: snapshot.stems,
          recordings: snapshot.recordings,
          video: snapshot.video,
          tracks: snapshot.tracks,
        }).catch(() => {});
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  return { saveNow: drainQueue };
}
