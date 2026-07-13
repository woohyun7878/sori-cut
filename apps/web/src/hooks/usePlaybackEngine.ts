import { useCallback, useEffect, useRef } from 'react';
import { PlaybackEngine } from '../lib/playbackEngine';
import { calculateProjectDuration, useProjectStore } from '../store/useProjectStore';

/**
 * Manages the PlaybackEngine lifecycle and connects it to the Zustand store.
 * Mount once at the top level (e.g. Studio page).
 */
export function usePlaybackEngine() {
  const engineRef = useRef<PlaybackEngine | null>(null);
  const isPlayingRef = useRef(false);
  const throttleRef = useRef(0);
  // Flag to distinguish engine-driven position updates from user-initiated seeks
  const engineUpdatingRef = useRef(false);

  // Subscribe to store slices
  const tracks = useProjectStore((s) => s.tracks);
  const video = useProjectStore((s) => s.video);
  const isPlaying = useProjectStore((s) => s.isPlaying);
  const playheadPosition = useProjectStore((s) => s.playheadPosition);
  const loopEnabled = useProjectStore((s) => s.loopEnabled);
  const setPlayheadPosition = useProjectStore((s) => s.setPlayheadPosition);
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying);

  // Keep refs in sync for use inside callbacks
  const tracksRef = useRef(tracks);
  const loopEnabledRef = useRef(loopEnabled);
  const playheadRef = useRef(playheadPosition);
  const videoRef = useRef(video);

  useEffect(() => { tracksRef.current = tracks; }, [tracks]);
  useEffect(() => { loopEnabledRef.current = loopEnabled; }, [loopEnabled]);
  useEffect(() => { playheadRef.current = playheadPosition; }, [playheadPosition]);
  useEffect(() => { videoRef.current = video; }, [video]);

  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = new PlaybackEngine();
    }
    return engineRef.current;
  }, []);

  // Set up engine callbacks
  useEffect(() => {
    const engine = getEngine();

    engine.setCallbacks(
      // onPlayheadUpdate — throttle to ~30fps
      (position: number) => {
        const now = performance.now();
        if (now - throttleRef.current < 33) return;
        throttleRef.current = now;
        engineUpdatingRef.current = true;
        setPlayheadPosition(position);
        engineUpdatingRef.current = false;
      },
      // onPlaybackEnd
      () => {
        if (loopEnabledRef.current) {
          // Re-schedule from the beginning for loop
          const duration = calculateProjectDuration(tracksRef.current, videoRef.current);
          void engine.play(tracksRef.current, 0, duration, true);
        } else {
          setIsPlaying(false);
        }
      },
    );

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [getEngine, setIsPlaying, setPlayheadPosition]);

  // Respond to isPlaying changes
  useEffect(() => {
    const engine = getEngine();
    const duration = calculateProjectDuration(tracksRef.current, video);

    if (isPlaying && !isPlayingRef.current) {
      // Start playing
      void engine.play(tracksRef.current, playheadRef.current, duration, loopEnabledRef.current);
    } else if (!isPlaying && isPlayingRef.current) {
      // Pause
      engine.pause();
    }

    isPlayingRef.current = isPlaying;
  }, [isPlaying, getEngine, video]);

  // Handle seeking: when the playhead changes and it wasn't from the engine, seek the engine
  useEffect(() => {
    if (engineUpdatingRef.current) return;
    if (!isPlayingRef.current) return;

    const engine = getEngine();
    const duration = calculateProjectDuration(tracksRef.current, videoRef.current);
    engine.seek(tracksRef.current, playheadPosition, duration, loopEnabledRef.current);
  }, [playheadPosition, getEngine]);

  // Preload buffers when tracks change
  useEffect(() => {
    const engine = getEngine();
    void engine.preloadTracks(tracks);
  }, [tracks, getEngine]);
}
