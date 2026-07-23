import { useEffect, useRef, useCallback } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import { saveProject } from '../lib/projectStorage';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const DEBOUNCE_MS = 2000;

export function useAutoSave(onStatusChange?: (status: SaveStatus) => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  const pendingRef = useRef(false);
  const statusRef = useRef<SaveStatus>('idle');

  const setStatus = useCallback(
    (status: SaveStatus) => {
      statusRef.current = status;
      onStatusChange?.(status);
    },
    [onStatusChange],
  );

  const performSave = useCallback(async () => {
    // If already saving, mark as pending so we re-save when current save completes
    if (isSavingRef.current) {
      pendingRef.current = true;
      return;
    }

    // Snapshot projectId at the moment of save to guard against race conditions
    // where the user switches projects while a debounced save is in flight.
    const state = useProjectStore.getState();
    if (!state.projectId) return;
    const targetProjectId = state.projectId;

    isSavingRef.current = true;
    pendingRef.current = false;
    setStatus('saving');

    try {
      await saveProject(targetProjectId, state.projectName, {
        originalAudio: state.originalAudio,
        stems: state.stems,
        recordings: state.recordings,
        video: state.video,
        tracks: state.tracks,
      });

      // Only report success if we're still on the same project
      const currentId = useProjectStore.getState().projectId;
      if (currentId === targetProjectId) {
        setStatus('saved');
      }
    } catch (err) {
      console.error('[useAutoSave] Save failed:', err);
      setStatus('error');
    } finally {
      isSavingRef.current = false;
      // If changes came in while we were saving, schedule another save
      if (pendingRef.current) {
        pendingRef.current = false;
        performSave();
      }
    }
  }, [setStatus]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      performSave();
    }, DEBOUNCE_MS);
  }, [performSave]);

  // Subscribe to store changes
  useEffect(() => {
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
        scheduleSave();
      }
    });

    return () => {
      unsub();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [scheduleSave]);

  // Save on beforeunload
  useEffect(() => {
    const handleUnload = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      const state = useProjectStore.getState();
      if (state.projectId) {
        // Best-effort async save — browser may complete short IDB writes before close
        saveProject(state.projectId, state.projectName, {
          originalAudio: state.originalAudio,
          stems: state.stems,
          recordings: state.recordings,
          video: state.video,
          tracks: state.tracks,
        }).catch(() => {});
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  return { saveNow: performSave };
}
