import { useCallback, useEffect, useRef } from 'react';
import { PlaybackEngine, type PlaybackError } from '../lib/playbackEngine';
import { calculateProjectDuration, useProjectStore } from '../store/useProjectStore';

/**
 * Manages the PlaybackEngine lifecycle and connects it to the Zustand store.
 * Mount once at the top level (e.g. Studio page).
 */
export function usePlaybackEngine() {
  const engineRef = useRef<PlaybackEngine | null>(null);
  const isPlayingRef = useRef(false);
  const throttleRef = useRef(0);
  const lastEnginePositionRef = useRef<number | null>(null);

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

  useEffect(() => { playheadRef.current = playheadPosition; }, [playheadPosition]);
  useEffect(() => { videoRef.current = video; }, [video]);

  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = new PlaybackEngine();
    }
    return engineRef.current;
  }, []);

  useEffect(() => {
    loopEnabledRef.current = loopEnabled;
    getEngine().setLoopEnabled(loopEnabled);
  }, [getEngine, loopEnabled]);

  const handlePlaybackError = useCallback(
    (error: PlaybackError) => {
      console.error('[usePlaybackEngine] Playback failed:', error);
      isPlayingRef.current = false;
      setIsPlaying(false);
    },
    [setIsPlaying],
  );

  // Set up engine callbacks
  useEffect(() => {
    const engine = getEngine();

    engine.setCallbacks(
      // onPlayheadUpdate — throttle to ~30fps
      (position: number) => {
        const now = performance.now();
        if (now - throttleRef.current < 33) return;
        throttleRef.current = now;
        lastEnginePositionRef.current = position;
        setPlayheadPosition(position);
      },
      // onPlaybackEnd
      () => {
        const duration = calculateProjectDuration(tracksRef.current, videoRef.current);
        lastEnginePositionRef.current = duration;
        setPlayheadPosition(duration);
        isPlayingRef.current = false;
        setIsPlaying(false);
      },
      handlePlaybackError,
    );

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [getEngine, handlePlaybackError, setIsPlaying, setPlayheadPosition]);

  useEffect(() => {
    tracksRef.current = tracks;
    void getEngine().syncTracks(tracks).catch(handlePlaybackError);
  }, [getEngine, handlePlaybackError, tracks]);

  // Respond to isPlaying changes
  useEffect(() => {
    const engine = getEngine();
    const duration = calculateProjectDuration(tracksRef.current, video);

    if (isPlaying && !isPlayingRef.current) {
      // Start playing
      void engine
        .play(tracksRef.current, playheadRef.current, duration, loopEnabledRef.current)
        .catch(handlePlaybackError);
    } else if (!isPlaying && isPlayingRef.current) {
      // Pause
      engine.pause();
    }

    isPlayingRef.current = isPlaying;
  }, [isPlaying, getEngine, handlePlaybackError, video]);

  // Handle seeking: when the playhead changes and it wasn't from the engine, seek the engine
  useEffect(() => {
    if (lastEnginePositionRef.current === playheadPosition) {
      lastEnginePositionRef.current = null;
      return;
    }
    if (!isPlayingRef.current) return;

    const engine = getEngine();
    const duration = calculateProjectDuration(tracksRef.current, videoRef.current);
    void engine
      .seek(tracksRef.current, playheadPosition, duration, loopEnabledRef.current)
      .catch(handlePlaybackError);
  }, [playheadPosition, getEngine, handlePlaybackError]);

  // Preload buffers when tracks change
  useEffect(() => {
    const engine = getEngine();
    void engine.preloadTracks(tracks).catch((error: unknown) => {
      console.error('[usePlaybackEngine] Audio preload failed:', error);
    });
  }, [tracks, getEngine]);
}
