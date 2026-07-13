import { useEffect, useRef, useCallback } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import { saveProject } from '../lib/projectStorage';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const DEBOUNCE_MS = 2000;

export function useAutoSave(onStatusChange?: (status: SaveStatus) => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  const statusRef = useRef<SaveStatus>('idle');

  const setStatus = useCallback(
    (status: SaveStatus) => {
      statusRef.current = status;
      onStatusChange?.(status);
    },
    [onStatusChange],
  );

  const performSave = useCallback(async () => {
    const state = useProjectStore.getState();
    if (!state.projectId) return;
    if (isSavingRef.current) return;

    isSavingRef.current = true;
    setStatus('saving');

    try {
      await saveProject(state.projectId, state.projectName, {
        originalAudio: state.originalAudio,
        stems: state.stems,
        recordings: state.recordings,
        video: state.video,
        tracks: state.tracks,
      });
      setStatus('saved');
    } catch (err) {
      console.error('[useAutoSave] Save failed:', err);
      setStatus('error');
    } finally {
      isSavingRef.current = false;
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
      // Synchronous best-effort save — not guaranteed but helps
      const state = useProjectStore.getState();
      if (state.projectId) {
        // Use sendBeacon with a flag or just attempt sync save
        // IndexedDB writes are async but the browser may complete short ops before closing
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
