import type { TimelineTrack } from '../store/useProjectStore';

interface PlaybackState {
  isPlaying: boolean;
  isStarting: boolean;
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

interface PendingTrackStart {
  token: symbol;
  sourceUrl: string;
}

export type PlaybackErrorCode =
  'CONTEXT_FAILED' | 'DECODE_FAILED' | 'FETCH_FAILED' | 'NODE_CLEANUP_FAILED' | 'SCHEDULE_FAILED';

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
  private pendingTrackStarts = new Map<string, PendingTrackStart>();
  private activeNodes = new Map<string, ActivePlaybackNode[]>();
  private currentTracks: TimelineTrack[] = [];
  private rafId: number | null = null;
  private startContextTime = 0;
  private startPlayheadPosition = 0;
  private operationGeneration = 0;
  private loopRestartGeneration: number | null = null;
  private destroyed = false;
  private onPlayheadUpdate: PlayheadCallback | null = null;
  private onPlaybackEnd: PlaybackEndCallback | null = null;
  private onPlaybackError: PlaybackErrorCallback | null = null;
  private state: PlaybackState = {
    isPlaying: false,
    isStarting: false,
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
      if (this.destroyed) {
        throw new PlaybackError(
          'CONTEXT_FAILED',
          'Playback engine was destroyed before audio decoding completed.',
          { sourceUrl: url },
        );
      }
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
    this.loopRestartGeneration = null;
    this.pendingTrackStarts.clear();
    this.cancelAnimationLoop();
    this.state.isPlaying = false;
    this.state.isStarting = true;
    this.state.playheadPosition = fromPosition;
    this.state.loopEnabled = loopEnabled;
    this.state.projectDuration = projectDuration;
    this.currentTracks = [...tracks];

    try {
      const cleanupError = this.stopSources();
      if (cleanupError) throw cleanupError;

      const ctx = this.getContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      if (!this.isCurrentOperation(generation)) return;

      const anchorTime = await this.scheduleAllTracks(this.currentTracks, fromPosition, generation);
      if (anchorTime === null || !this.isCurrentOperation(generation)) return;

      this.state = {
        isPlaying: true,
        isStarting: false,
        playheadPosition: fromPosition,
        loopEnabled: this.state.loopEnabled,
        projectDuration: this.state.projectDuration,
      };
      this.startPlayheadPosition = fromPosition;
      this.startContextTime = anchorTime;
      this.startAnimationLoop(generation);
    } catch (error) {
      if (!this.isCurrentOperation(generation)) return;

      this.operationGeneration++;
      this.cancelAnimationLoop();
      const cleanupError = this.stopSources();
      this.state.isPlaying = false;
      this.state.isStarting = false;
      if (cleanupError) this.reportInternalError(cleanupError);
      throw this.toPlaybackError(error, 'SCHEDULE_FAILED', 'Unable to schedule audio playback.');
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
      const currentTrack = this.currentTracks.find(
        (track) =>
          track.id === loadedTrack.track.id && track.sourceUrl === loadedTrack.track.sourceUrl,
      );
      if (!currentTrack || currentTrack.muted) continue;
      this.scheduleTrack(
        ctx,
        { track: currentTrack, buffer: loadedTrack.buffer },
        fromPosition,
        anchorTime,
      );
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
          this.toPlaybackError(
            error,
            'NODE_CLEANUP_FAILED',
            'Failed to release an ended audio node.',
          ),
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
    this.loopRestartGeneration = null;
    this.pendingTrackStarts.clear();
    this.cancelAnimationLoop();
    this.state.isPlaying = false;
    this.state.isStarting = false;
    const cleanupError = this.stopSources();
    if (cleanupError) this.reportInternalError(cleanupError);
  }

  stop() {
    this.operationGeneration++;
    this.loopRestartGeneration = null;
    this.pendingTrackStarts.clear();
    this.cancelAnimationLoop();
    this.state.isPlaying = false;
    this.state.isStarting = false;
    this.state.playheadPosition = 0;
    const cleanupError = this.stopSources();
    if (cleanupError) this.reportInternalError(cleanupError);
  }

  async seek(
    tracks: TimelineTrack[],
    position: number,
    projectDuration: number,
    loopEnabled: boolean,
  ): Promise<void> {
    if (this.state.isPlaying || this.state.isStarting) {
      await this.play(tracks, position, projectDuration, loopEnabled);
    } else {
      this.operationGeneration++;
      this.loopRestartGeneration = null;
      this.pendingTrackStarts.clear();
      this.state.playheadPosition = position;
    }
  }

  setLoopEnabled(enabled: boolean) {
    this.state.loopEnabled = enabled;
    if (!enabled && this.loopRestartGeneration === this.operationGeneration) {
      this.finishPlaybackAtEnd();
    }
  }

  async syncTracks(
    tracks: TimelineTrack[],
    projectDuration = this.state.projectDuration,
  ): Promise<void> {
    const previousTracks = new Map(this.currentTracks.map((track) => [track.id, track]));
    const nextTracks = new Map(tracks.map((track) => [track.id, track]));
    const mixChanges = tracks.filter((track) => {
      const previous = previousTracks.get(track.id);
      return previous && (previous.volume !== track.volume || previous.muted !== track.muted);
    });
    const structuralChanges = tracks.filter((track) => {
      const previous = previousTracks.get(track.id);
      return previous && this.hasStructuralChange(previous, track);
    });
    const addedTracks = tracks.filter((track) => !previousTracks.has(track.id));
    const removedTracks = this.currentTracks.filter((track) => !nextTracks.has(track.id));
    this.currentTracks = [...tracks];
    this.state.projectDuration = projectDuration;

    if (!this.state.isPlaying && !this.state.isStarting) return;

    const reconciliationErrors: PlaybackError[] = [];
    for (const track of [...removedTracks, ...structuralChanges]) {
      this.pendingTrackStarts.delete(track.id);
      const cleanupError = this.stopTrackSources(track.id);
      if (cleanupError) reconciliationErrors.push(cleanupError);
    }

    const cleanupErrors: PlaybackError[] = [];
    for (const trackId of scheduleChanges) {
      this.pendingTrackStarts.delete(trackId);
      const cleanupError = this.stopTrackSources(trackId);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new PlaybackError('NODE_CLEANUP_FAILED', 'Failed to release changed audio tracks.', {
        cause: cleanupErrors,
      });
    }

    for (const track of mixChanges) {
      if (scheduleChanges.has(track.id)) continue;
      if (track.muted) this.pendingTrackStarts.delete(track.id);
      if (this.activeNodes.has(track.id)) {
        this.updateTrackVolume(track.id, this.currentTracks);
      }
    }

    const currentPosition = this.getCurrentPlaybackPosition();
    const missingTracks = [...addedTracks, ...structuralChanges, ...mixChanges].filter(
      (track, index, candidates) => {
        const previous = previousTracks.get(track.id);
        const becameAudible = previous?.muted === true && !track.muted;
        const requiresReplacement =
          !previous || this.hasStructuralChange(previous, track) || becameAudible;
        return (
          candidates.findIndex((candidate) => candidate.id === track.id) === index &&
          requiresReplacement &&
          !track.muted &&
          Boolean(track.sourceUrl) &&
          !this.activeNodes.has(track.id) &&
          currentPosition < track.startOffset + track.duration
        );
      },
    );

    if (reconciliationErrors.length > 0) {
      throw new PlaybackError(
        'NODE_CLEANUP_FAILED',
        'Failed to reconcile changed playback tracks.',
        { cause: reconciliationErrors },
      );
    }

    if (missingTracks.length === 0) return;

    await this.scheduleMissingTracks(missingTracks);
  }

  private async scheduleMissingTracks(tracks: TimelineTrack[]) {
    const ctx = this.getContext();
    const operationGeneration = this.operationGeneration;
    const pendingTracks = tracks
      .filter((track) => {
        const pending = this.pendingTrackStarts.get(track.id);
        return !pending || pending.sourceUrl !== track.sourceUrl;
      })
      .map((track) => {
        const token = Symbol(track.id);
        this.pendingTrackStarts.set(track.id, { token, sourceUrl: track.sourceUrl });
        return { track, token };
      });

    if (pendingTracks.length === 0) return;

    try {
      const loadedTracks = await Promise.allSettled(
        pendingTracks.map(async ({ track, token }) => ({
          track,
          token,
          buffer: await this.loadBuffer(track.sourceUrl),
        })),
      );
      if (!this.isCurrentOperation(operationGeneration) || !this.state.isPlaying) {
        return;
      }

      const currentPosition = this.getCurrentPlaybackPosition();
      const anchorTime = ctx.currentTime;
      const activeFailures: unknown[] = [];
      for (let index = 0; index < loadedTracks.length; index++) {
        const result = loadedTracks[index];
        if (result.status === 'rejected') {
          const pendingTrack = pendingTracks[index];
          if (this.isActiveTrackStartFailure(result.reason, [pendingTrack])) {
            activeFailures.push(result.reason);
          }
          continue;
        }

        const { track, token, buffer } = result.value;
        const currentTrack = this.currentTracks.find(
          (candidate) => candidate.id === track.id,
        );
        const pending = this.pendingTrackStarts.get(track.id);
        if (
          pending?.token !== token ||
          pending.sourceUrl !== track.sourceUrl ||
          !buffer ||
          !currentTrack ||
          currentTrack.sourceUrl !== track.sourceUrl ||
          currentTrack.muted ||
          this.activeNodes.has(track.id)
        ) {
          continue;
        }
        this.scheduleTrack(ctx, { track: currentTrack, buffer }, currentPosition, anchorTime);
      }

      if (activeFailures.length === 1) {
        throw activeFailures[0];
      }
      if (activeFailures.length > 1) {
        throw new PlaybackError(
          'FETCH_FAILED',
          'Failed to load multiple active playback tracks.',
          { cause: activeFailures },
        );
      }
    } finally {
      for (const { track, token } of pendingTracks) {
        if (this.pendingTrackStarts.get(track.id)?.token === token) {
          this.pendingTrackStarts.delete(track.id);
        }
      }
    }
  }

  private isActiveTrackStartFailure(
    error: unknown,
    pendingTracks: { track: TimelineTrack; token: symbol }[],
  ) {
    const failedSourceUrl = error instanceof PlaybackError ? error.sourceUrl : undefined;
    return pendingTracks.some(({ track, token }) => {
      const pending = this.pendingTrackStarts.get(track.id);
      const currentTrack = this.currentTracks.find((candidate) => candidate.id === track.id);
      return (
        pending?.token === token &&
        pending.sourceUrl === track.sourceUrl &&
        currentTrack?.sourceUrl === track.sourceUrl &&
        !currentTrack.muted &&
        (!failedSourceUrl || failedSourceUrl === track.sourceUrl)
      );
    });
  }

  private hasStructuralChange(previous: TimelineTrack, next: TimelineTrack) {
    return (
      previous.sourceUrl !== next.sourceUrl ||
      previous.startOffset !== next.startOffset ||
      previous.duration !== next.duration ||
      previous.sourceStartOffset !== next.sourceStartOffset
    );
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

  private getCurrentPlaybackPosition() {
    if (
      !this.state.isPlaying ||
      !this.audioContext ||
      this.loopRestartGeneration === this.operationGeneration
    ) {
      return this.state.playheadPosition;
    }

    const elapsed = this.audioContext.currentTime - this.startContextTime;
    return Math.min(this.startPlayheadPosition + Math.max(elapsed, 0), this.state.projectDuration);
  }

  private startAnimationLoop(generation: number) {
    this.cancelAnimationLoop();

    const tick = () => {
      this.rafId = null;
      if (!this.isCurrentOperation(generation) || !this.state.isPlaying || !this.audioContext) {
        return;
      }

      const elapsed = this.audioContext.currentTime - this.startContextTime;
      const currentPosition = this.startPlayheadPosition + elapsed;

      if (currentPosition >= this.state.projectDuration) {
        if (this.state.loopEnabled) {
          void this.restartLoop(generation);
          return;
        }

        this.finishPlaybackAtEnd();
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
    this.loopRestartGeneration = generation;
    this.pendingTrackStarts.clear();

    try {
      const cleanupError = this.stopSources();
      if (cleanupError) throw cleanupError;

      this.state.playheadPosition = 0;
      this.onPlayheadUpdate?.(0);
      const anchorTime = await this.scheduleAllTracks(this.currentTracks, 0, generation);
      if (anchorTime === null || !this.isCurrentOperation(generation)) return;

      this.loopRestartGeneration = null;
      this.startPlayheadPosition = 0;
      this.startContextTime = anchorTime;
      this.startAnimationLoop(generation);
    } catch (error) {
      if (!this.isCurrentOperation(generation)) return;
      this.failInternalPlayback(
        generation,
        this.toPlaybackError(error, 'SCHEDULE_FAILED', 'Unable to reschedule loop playback.'),
      );
    } finally {
      if (this.loopRestartGeneration === generation) {
        this.loopRestartGeneration = null;
      }
    }
  }

  private finishPlaybackAtEnd() {
    this.operationGeneration++;
    this.loopRestartGeneration = null;
    this.pendingTrackStarts.clear();
    this.cancelAnimationLoop();
    this.state.isPlaying = false;
    this.state.isStarting = false;
    this.state.playheadPosition = this.state.projectDuration;
    const cleanupError = this.stopSources();
    if (cleanupError) this.reportInternalError(cleanupError);
    this.onPlayheadUpdate?.(this.state.projectDuration);
    this.onPlaybackEnd?.();
  }

  private failInternalPlayback(generation: number, error: PlaybackError) {
    if (!this.isCurrentOperation(generation)) return;

    this.operationGeneration++;
    this.loopRestartGeneration = null;
    this.pendingTrackStarts.clear();
    this.cancelAnimationLoop();
    const cleanupError = this.stopSources();
    this.state.isPlaying = false;
    this.state.isStarting = false;
    if (cleanupError) {
      this.reportInternalError(
        new PlaybackError(error.code, `${error.message} Cleanup also failed.`, {
          sourceUrl: error.sourceUrl,
          cause: [error, cleanupError],
        }),
      );
    } else {
      this.reportInternalError(error);
    }
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

    const errors: unknown[] = [];
    if (stopSource) {
      try {
        node.source.stop();
      } catch (error) {
        if (!this.isAlreadyStoppedError(error)) errors.push(error);
      }
    }

    try {
      node.source.disconnect();
    } catch (error) {
      errors.push(error);
    }

    try {
      node.gain.disconnect();
    } catch (error) {
      errors.push(error);
    }

    this.removeActiveNode(node);
    if (errors.length > 0) {
      throw new PlaybackError('NODE_CLEANUP_FAILED', `Failed to release track "${node.trackId}".`, {
        cause: errors,
      });
    }
  }

  private stopTrackSources(trackId: string): PlaybackError | null {
    const nodes = [...(this.activeNodes.get(trackId) ?? [])];
    const errors: unknown[] = [];

    for (const node of nodes) {
      try {
        this.cleanupNode(node, true);
      } catch (error) {
        errors.push(error);
      }
    }
    this.activeNodes.delete(trackId);

    return errors.length > 0
      ? new PlaybackError('NODE_CLEANUP_FAILED', `Failed to release track "${trackId}".`, {
          cause: errors,
        })
      : null;
  }

  private stopSources(): PlaybackError | null {
    const nodes = [...this.activeNodes.values()].flat();
    const errors: unknown[] = [];

    for (const node of nodes) {
      try {
        this.cleanupNode(node, true);
      } catch (error) {
        errors.push(error);
      }
    }
    this.activeNodes.clear();

    return errors.length > 0
      ? new PlaybackError('NODE_CLEANUP_FAILED', 'Failed to release active audio nodes.', {
          cause: errors,
        })
      : null;
  }

  private stopTrackSources(trackId: string): PlaybackError | null {
    const nodes = [...(this.activeNodes.get(trackId) ?? [])];
    const errors: unknown[] = [];

    for (const node of nodes) {
      try {
        this.cleanupNode(node, true);
      } catch (error) {
        errors.push(error);
      }
    }
    this.activeNodes.delete(trackId);

    return errors.length > 0
      ? new PlaybackError(
          'NODE_CLEANUP_FAILED',
          `Failed to release changed track "${trackId}".`,
          { cause: errors },
        )
      : null;
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

  private toPlaybackError(error: unknown, code: PlaybackErrorCode, message: string): PlaybackError {
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

  get isStarting() {
    return this.state.isStarting;
  }

  destroy() {
    if (this.destroyed) return;

    this.destroyed = true;
    this.operationGeneration++;
    this.loopRestartGeneration = null;
    this.pendingTrackStarts.clear();
    this.cancelAnimationLoop();
    const errorCallback = this.onPlaybackError;
    const cleanupError = this.stopSources();
    this.state = {
      isPlaying: false,
      isStarting: false,
      playheadPosition: 0,
      loopEnabled: false,
      projectDuration: 0,
    };
    this.startContextTime = 0;
    this.startPlayheadPosition = 0;
    this.currentTracks = [];
    this.activeNodes.clear();
    this.bufferCache.clear();
    this.pendingBufferLoads.clear();

    const context = this.audioContext;
    this.audioContext = null;
    this.onPlayheadUpdate = null;
    this.onPlaybackEnd = null;
    this.onPlaybackError = null;

    if (context) {
      try {
        void context.close().catch((error: unknown) => {
          this.reportError(
            errorCallback,
            this.toPlaybackError(error, 'CONTEXT_FAILED', 'Failed to close the Web Audio context.'),
          );
        });
      } catch (error) {
        this.reportError(
          errorCallback,
          this.toPlaybackError(error, 'CONTEXT_FAILED', 'Failed to close the Web Audio context.'),
        );
      }
    }

    if (cleanupError) {
      this.reportError(errorCallback, cleanupError);
    }
  }

  private reportError(callback: PlaybackErrorCallback | null, error: PlaybackError) {
    if (callback) {
      callback(error);
    } else {
      console.error('[PlaybackEngine]', error);
    }
  }
}
