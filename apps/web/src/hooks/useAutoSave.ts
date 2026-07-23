import { useEffect, useRef, useCallback } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import {
  enqueue,
  flushAll,
  flushNow,
  onStatus,
  captureSnapshot,
  type SaveStatus,
} from '../lib/autosaveCoordinator';

export type { SaveStatus } from '../lib/autosaveCoordinator';

/**
 * Thin hook that subscribes to store changes and delegates to the global
 * autosave coordinator. The coordinator owns queue state, write serialization,
 * and generation ordering — hook mount/unmount lifetime does not affect
 * write ordering or queue contents.
 */
export function useAutoSave(onStatusChange?: (status: SaveStatus) => void) {
  const mountedRef = useRef(true);

  // Forward coordinator status to the component
  useEffect(() => {
    mountedRef.current = true;
    const unsub = onStatus((status) => {
      if (mountedRef.current) {
        onStatusChange?.(status);
      }
    });
    return () => {
      mountedRef.current = false;
      unsub();
    };
  }, [onStatusChange]);

  // Subscribe to store changes → enqueue snapshots in the coordinator
  useEffect(() => {
    const unsub = useProjectStore.subscribe((state, prev) => {
      // Only persist on data-bearing changes, ignore transient playback state
      if (
        state.originalAudio !== prev.originalAudio ||
        state.stems !== prev.stems ||
        state.recordings !== prev.recordings ||
        state.video !== prev.video ||
        state.tracks !== prev.tracks ||
        state.projectName !== prev.projectName
      ) {
        enqueue(captureSnapshot(state));
      }
    });
    return () => { unsub(); };
  }, []);

  // Best-effort flush all queued projects on beforeunload
  useEffect(() => {
    const handleUnload = () => {
      // Also capture the very latest state for the current project
      const state = useProjectStore.getState();
      if (state.projectId) {
        enqueue(captureSnapshot(state));
      }
      flushAll();
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  const saveNow = useCallback(() => flushNow(), []);

  return { saveNow };
}
