import type { TimelineTrack } from '../store/useProjectStore';

interface PlaybackState {
  isPlaying: boolean;
  playheadPosition: number;
  loopEnabled: boolean;
  projectDuration: number;
}

export type PlayheadCallback = (position: number) => void;
export type PlaybackEndCallback = () => void;

export class PlaybackEngine {
  private audioContext: AudioContext | null = null;
  private bufferCache = new Map<string, AudioBuffer>();
  private activeNodes: { source: AudioBufferSourceNode; gain: GainNode }[] = [];
  private rafId: number | null = null;
  private startContextTime = 0;
  private startPlayheadPosition = 0;
  private onPlayheadUpdate: PlayheadCallback | null = null;
  private onPlaybackEnd: PlaybackEndCallback | null = null;
  private state: PlaybackState = {
    isPlaying: false,
    playheadPosition: 0,
    loopEnabled: false,
    projectDuration: 0,
  };

  setCallbacks(onPlayhead: PlayheadCallback, onEnd: PlaybackEndCallback) {
    this.onPlayheadUpdate = onPlayhead;
    this.onPlaybackEnd = onEnd;
  }

  private getContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  async loadBuffer(url: string): Promise<AudioBuffer | null> {
    if (!url) return null;

    const cached = this.bufferCache.get(url);
    if (cached) return cached;

    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const ctx = this.getContext();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      this.bufferCache.set(url, audioBuffer);
      return audioBuffer;
    } catch {
      console.warn(`[PlaybackEngine] Failed to decode audio from: ${url}`);
      return null;
    }
  }

  async preloadTracks(tracks: TimelineTrack[]): Promise<void> {
    const urls = tracks
      .filter((t) => t.sourceUrl && !t.muted)
      .map((t) => t.sourceUrl);

    await Promise.all(urls.map((url) => this.loadBuffer(url)));
  }

  async play(tracks: TimelineTrack[], fromPosition: number, projectDuration: number, loopEnabled: boolean) {
    const ctx = this.getContext();

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    this.stopSources();

    this.state = {
      isPlaying: true,
      playheadPosition: fromPosition,
      loopEnabled,
      projectDuration,
    };
    this.startPlayheadPosition = fromPosition;
    this.startContextTime = ctx.currentTime;

    await this.scheduleAllTracks(tracks, fromPosition);
    this.startAnimationLoop();
  }

  private async scheduleAllTracks(tracks: TimelineTrack[], fromPosition: number) {
    const ctx = this.getContext();

    for (const track of tracks) {
      if (track.muted || !track.sourceUrl) continue;

      const buffer = await this.loadBuffer(track.sourceUrl);
      if (!buffer) continue;

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const gain = ctx.createGain();
      gain.gain.value = track.volume;

      source.connect(gain);
      gain.connect(ctx.destination);

      // Calculate when to start this track relative to playhead position
      const trackStart = track.startOffset;
      const trackEnd = trackStart + track.duration;

      if (fromPosition >= trackEnd) {
        // Playhead is past this track
        continue;
      }

      if (fromPosition <= trackStart) {
        // Track hasn't started yet - schedule it for the future
        const delay = trackStart - fromPosition;
        source.start(ctx.currentTime + delay, 0, track.duration);
      } else {
        // Playhead is inside this track - start immediately with offset
        const offset = fromPosition - trackStart;
        const remaining = track.duration - offset;
        source.start(0, offset, remaining);
      }

      this.activeNodes.push({ source, gain });
    }
  }

  pause() {
    this.stopSources();
    this.cancelAnimationLoop();
    this.state.isPlaying = false;
  }

  stop() {
    this.stopSources();
    this.cancelAnimationLoop();
    this.state.isPlaying = false;
    this.state.playheadPosition = 0;
  }

  seek(tracks: TimelineTrack[], position: number, projectDuration: number, loopEnabled: boolean) {
    if (this.state.isPlaying) {
      // Re-schedule all tracks from the new position
      this.stopSources();
      this.cancelAnimationLoop();
      this.state.playheadPosition = position;
      void this.play(tracks, position, projectDuration, loopEnabled);
    } else {
      this.state.playheadPosition = position;
    }
  }

  updateTrackVolume(trackId: string, _tracks: TimelineTrack[]) {
    // Volume changes during playback won't take effect on already-playing nodes
    // without a full reschedule. We update gain on existing nodes if we track them per-track.
    // For simplicity, this is a no-op — volume changes take effect on next play/seek.
    void trackId;
  }

  private startAnimationLoop() {
    this.cancelAnimationLoop();

    const tick = () => {
      if (!this.state.isPlaying || !this.audioContext) return;

      const elapsed = this.audioContext.currentTime - this.startContextTime;
      let currentPosition = this.startPlayheadPosition + elapsed;

      if (currentPosition >= this.state.projectDuration) {
        if (this.state.loopEnabled) {
          // Loop: reset
          currentPosition = 0;
          this.startPlayheadPosition = 0;
          this.startContextTime = this.audioContext.currentTime;
          // Note: re-scheduling audio on loop would need to happen through the hook
          this.onPlayheadUpdate?.(0);
          this.onPlaybackEnd?.();
          return;
        }

        // End of project
        this.state.isPlaying = false;
        this.stopSources();
        this.onPlayheadUpdate?.(this.state.projectDuration);
        this.onPlaybackEnd?.();
        return;
      }

      this.state.playheadPosition = currentPosition;
      this.onPlayheadUpdate?.(currentPosition);
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private cancelAnimationLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private stopSources() {
    for (const { source } of this.activeNodes) {
      try {
        source.stop();
      } catch {
        // Already stopped
      }
    }
    this.activeNodes = [];
  }

  get isPlaying() {
    return this.state.isPlaying;
  }

  destroy() {
    this.stop();
    this.bufferCache.clear();
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
    this.onPlayheadUpdate = null;
    this.onPlaybackEnd = null;
  }
}
