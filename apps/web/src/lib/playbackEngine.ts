import type { TimelineTrack } from '../store/useProjectStore';

interface PlaybackState {
  isPlaying: boolean;
  playheadPosition: number;
  loopEnabled: boolean;
  projectDuration: number;
}

interface ActivePlaybackNode {
  source: AudioBufferSourceNode;
  gain: GainNode;
  trackId: string;
  cleanedUp: boolean;
}

interface LoadedTrack {
  track: TimelineTrack;
  buffer: AudioBuffer;
}

export type PlaybackErrorCode =
  | 'CONTEXT_FAILED'
  | 'DECODE_FAILED'
  | 'FETCH_FAILED'
  | 'NODE_CLEANUP_FAILED'
  | 'SCHEDULE_FAILED';

export class PlaybackError extends Error {
  readonly code: PlaybackErrorCode;
  readonly sourceUrl?: string;
  readonly cause: unknown;

  constructor(
    code: PlaybackErrorCode,
    message: string,
    options: { sourceUrl?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'PlaybackError';
    this.code = code;
    this.sourceUrl = options.sourceUrl;
    this.cause = options.cause;
  }
}

export type PlayheadCallback = (position: number) => void;
export type PlaybackEndCallback = () => void;
export type PlaybackErrorCallback = (error: PlaybackError) => void;

const GAIN_RAMP_SECONDS = 0.01;

export class PlaybackEngine {
  private audioContext: AudioContext | null = null;
  private bufferCache = new Map<string, AudioBuffer>();
  private pendingBufferLoads = new Map<string, Promise<AudioBuffer>>();
  private activeNodes = new Map<string, ActivePlaybackNode[]>();
  private currentTracks: TimelineTrack[] = [];
  private rafId: number | null = null;
  private startContextTime = 0;
  private startPlayheadPosition = 0;
  private operationGeneration = 0;
  private destroyed = false;
  private onPlayheadUpdate: PlayheadCallback | null = null;
  private onPlaybackEnd: PlaybackEndCallback | null = null;
  private onPlaybackError: PlaybackErrorCallback | null = null;
  private state: PlaybackState = {
    isPlaying: false,
    playheadPosition: 0,
    loopEnabled: false,
    projectDuration: 0,
  };

  setCallbacks(
    onPlayhead: PlayheadCallback,
    onEnd: PlaybackEndCallback,
    onError?: PlaybackErrorCallback,
  ) {
    this.onPlayheadUpdate = onPlayhead;
    this.onPlaybackEnd = onEnd;
    this.onPlaybackError = onError ?? null;
  }

  private getContext(): AudioContext {
    if (this.destroyed) {
      throw new PlaybackError('CONTEXT_FAILED', 'Playback engine has been destroyed.');
    }

    if (!this.audioContext) {
      try {
        this.audioContext = new AudioContext();
      } catch (error) {
        throw new PlaybackError('CONTEXT_FAILED', 'Unable to initialize the Web Audio context.', {
          cause: error,
        });
      }
    }
    return this.audioContext;
  }

  async loadBuffer(url: string): Promise<AudioBuffer | null> {
    if (!url) return null;

    const cached = this.bufferCache.get(url);
    if (cached) return cached;

    const pending = this.pendingBufferLoads.get(url);
    if (pending) return pending;

    const load = this.fetchAndDecodeBuffer(url);
    this.pendingBufferLoads.set(url, load);

    try {
      return await load;
    } finally {
      if (this.pendingBufferLoads.get(url) === load) {
        this.pendingBufferLoads.delete(url);
      }
    }
  }

  private async fetchAndDecodeBuffer(url: string): Promise<AudioBuffer> {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new PlaybackError(
        'FETCH_FAILED',
        `Failed to fetch audio source "${url}": ${this.describeError(error)}`,
        { sourceUrl: url, cause: error },
      );
    }

    if (!response.ok) {
      const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
      throw new PlaybackError(
        'FETCH_FAILED',
        `Failed to fetch audio source "${url}": HTTP ${status}.`,
        { sourceUrl: url },
      );
    }

    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (error) {
      throw new PlaybackError(
        'FETCH_FAILED',
        `Failed to read audio source "${url}": ${this.describeError(error)}`,
        { sourceUrl: url, cause: error },
      );
    }

    try {
      const audioBuffer = await this.getContext().decodeAudioData(arrayBuffer);
      this.bufferCache.set(url, audioBuffer);
      return audioBuffer;
    } catch (error) {
      if (error instanceof PlaybackError) throw error;
      throw new PlaybackError(
        'DECODE_FAILED',
        `Failed to decode audio source "${url}": ${this.describeError(error)}`,
        { sourceUrl: url, cause: error },
      );
    }
  }

  async preloadTracks(tracks: TimelineTrack[]): Promise<void> {
    const urls = new Set(
      tracks.filter((track) => track.sourceUrl && !track.muted).map((track) => track.sourceUrl),
    );

    await Promise.all([...urls].map((url) => this.loadBuffer(url)));
  }

  async play(
    tracks: TimelineTrack[],
    fromPosition: number,
    projectDuration: number,
    loopEnabled: boolean,
  ): Promise<void> {
    const generation = ++this.operationGeneration;
    this.cancelAnimationLoop();
    this.stopSources();
    this.state.isPlaying = false;

    try {
      const ctx = this.getContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      if (!this.isCurrentOperation(generation)) return;

      this.currentTracks = [...tracks];
      const anchorTime = await this.scheduleAllTracks(tracks, fromPosition, generation);
      if (anchorTime === null || !this.isCurrentOperation(generation)) return;

      this.state = {
        isPlaying: true,
        playheadPosition: fromPosition,
        loopEnabled,
        projectDuration,
      };
      this.startPlayheadPosition = fromPosition;
      this.startContextTime = anchorTime;
      this.startAnimationLoop(generation);
    } catch (error) {
      if (!this.isCurrentOperation(generation)) return;

      this.operationGeneration++;
      this.cancelAnimationLoop();
      this.stopSources();
      this.state.isPlaying = false;
      throw this.toPlaybackError(
        error,
        'SCHEDULE_FAILED',
        'Unable to schedule audio playback.',
      );
    }
  }

  private async scheduleAllTracks(
    tracks: TimelineTrack[],
    fromPosition: number,
    generation: number,
  ): Promise<number | null> {
    const ctx = this.getContext();
    const candidates = tracks.filter((track) => !track.muted && Boolean(track.sourceUrl));
    const loadedTracks = await Promise.all(
      candidates.map(async (track): Promise<LoadedTrack | null> => {
        const buffer = await this.loadBuffer(track.sourceUrl);
        return buffer ? { track, buffer } : null;
      }),
    );

    if (!this.isCurrentOperation(generation)) return null;

    const anchorTime = ctx.currentTime;
    for (const loadedTrack of loadedTracks) {
      if (!this.isCurrentOperation(generation)) return null;
      if (!loadedTrack) continue;
      this.scheduleTrack(ctx, loadedTrack, fromPosition, anchorTime);
    }

    return anchorTime;
  }

  private scheduleTrack(
    ctx: AudioContext,
    { track, buffer }: LoadedTrack,
    fromPosition: number,
    anchorTime: number,
  ) {
    const schedule = this.calculateSchedule(track, buffer, fromPosition, anchorTime);
    if (!schedule) return;

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const node: ActivePlaybackNode = {
      source,
      gain,
      trackId: track.id,
      cleanedUp: false,
    };

    source.buffer = buffer;
    gain.gain.value = track.volume;
    source.onended = () => {
      try {
        this.cleanupNode(node, false);
      } catch (error) {
        this.reportInternalError(
          this.toPlaybackError(error, 'NODE_CLEANUP_FAILED', 'Failed to release an ended audio node.'),
        );
      }
    };

    try {
      source.connect(gain);
      gain.connect(ctx.destination);
      this.addActiveNode(node);
      source.start(schedule.when, schedule.offset, schedule.duration);
    } catch (error) {
      try {
        this.cleanupNode(node, true);
      } catch (cleanupError) {
        this.reportInternalError(
          this.toPlaybackError(
            cleanupError,
            'NODE_CLEANUP_FAILED',
            'Failed to roll back an audio node after scheduling failed.',
          ),
        );
      }
      throw new PlaybackError(
        'SCHEDULE_FAILED',
        `Failed to schedule track "${track.name}" (${track.id}).`,
        { sourceUrl: track.sourceUrl, cause: error },
      );
    }
  }

  private calculateSchedule(
    track: TimelineTrack,
    buffer: AudioBuffer,
    fromPosition: number,
    anchorTime: number,
  ): { when: number; offset: number; duration: number } | null {
    if (
      !Number.isFinite(track.startOffset) ||
      !Number.isFinite(track.duration) ||
      track.duration <= 0 ||
      !Number.isFinite(buffer.duration) ||
      buffer.duration <= 0
    ) {
      return null;
    }

    const trackEnd = track.startOffset + track.duration;
    if (fromPosition >= trackEnd) return null;

    const intoClip = Math.max(fromPosition - track.startOffset, 0);
    const rawSourceOffset = Number.isFinite(track.sourceStartOffset)
      ? Math.max(track.sourceStartOffset, 0)
      : 0;
    const sourceOffset = Math.min(rawSourceOffset + intoClip, buffer.duration);
    const requestedDuration = track.duration - intoClip;
    const availableDuration = buffer.duration - sourceOffset;
    const duration = Math.min(requestedDuration, availableDuration);

    if (duration <= 0) return null;

    return {
      when: anchorTime + Math.max(track.startOffset - fromPosition, 0),
      offset: sourceOffset,
      duration,
    };
  }

  pause() {
    this.operationGeneration++;
    this.stopSources();
    this.cancelAnimationLoop();
    this.state.isPlaying = false;
  }

  stop() {
    this.operationGeneration++;
    this.stopSources();
    this.cancelAnimationLoop();
    this.state.isPlaying = false;
    this.state.playheadPosition = 0;
  }

  async seek(
    tracks: TimelineTrack[],
    position: number,
    projectDuration: number,
    loopEnabled: boolean,
  ): Promise<void> {
    if (this.state.isPlaying) {
      await this.play(tracks, position, projectDuration, loopEnabled);
    } else {
      this.operationGeneration++;
      this.state.playheadPosition = position;
    }
  }

  updateTrackVolume(trackId: string, tracks: TimelineTrack[]) {
    const track = tracks.find((candidate) => candidate.id === trackId);
    if (!track) return;

    const nodes = this.activeNodes.get(trackId);
    if (!nodes) return;

    const now = this.getContext().currentTime;
    const targetVolume = track.muted ? 0 : track.volume;
    for (const { gain } of nodes) {
      const currentVolume = gain.gain.value;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(currentVolume, now);
      gain.gain.linearRampToValueAtTime(targetVolume, now + GAIN_RAMP_SECONDS);
    }
  }

  private startAnimationLoop(generation: number) {
    this.cancelAnimationLoop();

    const tick = () => {
      this.rafId = null;
      if (
        !this.isCurrentOperation(generation) ||
        !this.state.isPlaying ||
        !this.audioContext
      ) {
        return;
      }

      const elapsed = this.audioContext.currentTime - this.startContextTime;
      const currentPosition = this.startPlayheadPosition + elapsed;

      if (currentPosition >= this.state.projectDuration) {
        if (this.state.loopEnabled) {
          void this.restartLoop(generation);
          return;
        }

        this.operationGeneration++;
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

  private async restartLoop(previousGeneration: number) {
    if (!this.isCurrentOperation(previousGeneration) || !this.state.isPlaying) return;

    const generation = ++this.operationGeneration;
    this.stopSources();
    this.state.playheadPosition = 0;
    this.onPlayheadUpdate?.(0);

    try {
      const anchorTime = await this.scheduleAllTracks(this.currentTracks, 0, generation);
      if (anchorTime === null || !this.isCurrentOperation(generation)) return;

      this.startPlayheadPosition = 0;
      this.startContextTime = anchorTime;
      this.startAnimationLoop(generation);
    } catch (error) {
      if (!this.isCurrentOperation(generation)) return;
      this.failInternalPlayback(
        generation,
        this.toPlaybackError(error, 'SCHEDULE_FAILED', 'Unable to reschedule loop playback.'),
      );
    }
  }

  private failInternalPlayback(generation: number, error: PlaybackError) {
    if (!this.isCurrentOperation(generation)) return;

    this.operationGeneration++;
    this.cancelAnimationLoop();
    try {
      this.stopSources();
    } catch (cleanupError) {
      this.reportInternalError(
        this.toPlaybackError(
          cleanupError,
          'NODE_CLEANUP_FAILED',
          'Failed to release audio nodes after playback failed.',
        ),
      );
    }
    this.state.isPlaying = false;
    this.reportInternalError(error);
  }

  private cancelAnimationLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private addActiveNode(node: ActivePlaybackNode) {
    const existing = this.activeNodes.get(node.trackId) ?? [];
    existing.push(node);
    this.activeNodes.set(node.trackId, existing);
  }

  private removeActiveNode(node: ActivePlaybackNode) {
    const existing = this.activeNodes.get(node.trackId);
    if (!existing) return;

    const remaining = existing.filter((candidate) => candidate !== node);
    if (remaining.length > 0) {
      this.activeNodes.set(node.trackId, remaining);
    } else {
      this.activeNodes.delete(node.trackId);
    }
  }

  private cleanupNode(node: ActivePlaybackNode, stopSource: boolean) {
    if (node.cleanedUp) return;
    node.cleanedUp = true;
    node.source.onended = null;

    let firstError: unknown;
    if (stopSource) {
      try {
        node.source.stop();
      } catch (error) {
        if (!this.isAlreadyStoppedError(error)) firstError = error;
      }
    }

    try {
      node.source.disconnect();
    } catch (error) {
      firstError ??= error;
    }

    try {
      node.gain.disconnect();
    } catch (error) {
      firstError ??= error;
    }

    this.removeActiveNode(node);
    if (firstError) throw firstError;
  }

  private stopSources() {
    const nodes = [...this.activeNodes.values()].flat();
    let firstError: unknown;

    for (const node of nodes) {
      try {
        this.cleanupNode(node, true);
      } catch (error) {
        firstError ??= error;
      }
    }
    this.activeNodes.clear();

    if (firstError) {
      throw new PlaybackError('NODE_CLEANUP_FAILED', 'Failed to release active audio nodes.', {
        cause: firstError,
      });
    }
  }

  private isCurrentOperation(generation: number) {
    return !this.destroyed && generation === this.operationGeneration;
  }

  private isAlreadyStoppedError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'InvalidStateError'
    );
  }

  private describeError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  private toPlaybackError(
    error: unknown,
    code: PlaybackErrorCode,
    message: string,
  ): PlaybackError {
    return error instanceof PlaybackError
      ? error
      : new PlaybackError(code, `${message} ${this.describeError(error)}`, { cause: error });
  }

  private reportInternalError(error: PlaybackError) {
    if (this.onPlaybackError) {
      this.onPlaybackError(error);
    } else {
      console.error('[PlaybackEngine]', error);
    }
  }

  get isPlaying() {
    return this.state.isPlaying;
  }

  destroy() {
    this.destroyed = true;
    this.operationGeneration++;
    this.cancelAnimationLoop();
    this.stopSources();
    this.state.isPlaying = false;
    this.bufferCache.clear();
    this.pendingBufferLoads.clear();

    const context = this.audioContext;
    this.audioContext = null;
    if (context) {
      void context.close().catch((error: unknown) => {
        this.reportInternalError(
          this.toPlaybackError(error, 'CONTEXT_FAILED', 'Failed to close the Web Audio context.'),
        );
      });
    }

    this.onPlayheadUpdate = null;
    this.onPlaybackEnd = null;
    this.onPlaybackError = null;
  }
}
