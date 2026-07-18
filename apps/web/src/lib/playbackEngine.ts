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
  private activeNodes = new Map<string, { source: AudioBufferSourceNode; gain: GainNode }[]>();
  private currentTracks: TimelineTrack[] = [];
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

    this.currentTracks = tracks;
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

      const trackStart = track.startOffset;
      const trackEnd = trackStart + track.duration;

      if (fromPosition >= trackEnd) {
        continue;
      }

      const sourceStart = Math.max(track.sourceStartOffset ?? 0, 0);

      if (fromPosition <= trackStart) {
        const delay = trackStart - fromPosition;
        source.start(ctx.currentTime + delay, sourceStart, track.duration);
      } else {
        const intoClip = fromPosition - trackStart;
        const remaining = track.duration - intoClip;
        source.start(ctx.currentTime, sourceStart + intoClip, remaining);
      }

      const existing = this.activeNodes.get(track.id) ?? [];
      existing.push({ source, gain });
      this.activeNodes.set(track.id, existing);
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
      this.stopSources();
      this.cancelAnimationLoop();
      this.state.playheadPosition = position;
      void this.play(tracks, position, projectDuration, loopEnabled);
    } else {
      this.state.playheadPosition = position;
    }
  }

  updateTrackVolume(trackId: string, tracks: TimelineTrack[]) {
    const track = tracks.find((t) => t.id === trackId);
    if (!track) return;

    const nodes = this.activeNodes.get(trackId);
    if (!nodes) return;

    for (const { gain } of nodes) {
      gain.gain.value = track.volume;
    }
  }

  private startAnimationLoop() {
    this.cancelAnimationLoop();

    const tick = () => {
      if (!this.state.isPlaying || !this.audioContext) return;

      const elapsed = this.audioContext.currentTime - this.startContextTime;
      let currentPosition = this.startPlayheadPosition + elapsed;

      if (currentPosition >= this.state.projectDuration) {
        if (this.state.loopEnabled) {
          currentPosition = 0;
          this.startPlayheadPosition = 0;
          this.startContextTime = this.audioContext.currentTime;
          this.stopSources();
          void this.scheduleAllTracks(this.currentTracks, 0);
          this.onPlayheadUpdate?.(0);
          this.rafId = requestAnimationFrame(tick);
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
    for (const nodes of this.activeNodes.values()) {
      for (const { source } of nodes) {
        try {
          source.stop();
        } catch {
          // Already stopped
        }
      }
    }
    this.activeNodes.clear();
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
