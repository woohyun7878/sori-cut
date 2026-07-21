import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineTrack } from '../../store/useProjectStore';
import { PlaybackEngine, PlaybackError } from '../playbackEngine';

interface MockSource {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface MockGain {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  gain: {
    value: number;
    cancelScheduledValues: ReturnType<typeof vi.fn>;
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createAudioBuffer(duration = 10): AudioBuffer {
  return {
    duration,
    length: duration * 44100,
    numberOfChannels: 2,
    sampleRate: 44100,
  } as AudioBuffer;
}

function createTrack(overrides: Partial<TimelineTrack> = {}): TimelineTrack {
  return {
    id: 'track-1',
    name: 'Track 1',
    type: 'audio',
    sourceUrl: 'blob:track-1',
    startOffset: 0,
    duration: 5,
    sourceStartOffset: 0,
    muted: false,
    volume: 1,
    ...overrides,
  };
}

const createdSources: MockSource[] = [];
const createdGains: MockGain[] = [];
const decodeAudioData = vi.fn();
const closeAudioContext = vi.fn();
const fetchMock = vi.fn();
const engines: PlaybackEngine[] = [];
const createdContexts: MockAudioContext[] = [];
const animationFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
let contextTime = 0;
let contextTimeReads = 0;
let startCount = 0;
let throwOnStartNumber: number | null = null;

class MockAudioContext {
  state: AudioContextState = 'running';
  destination = {};
  close = vi.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });

  constructor() {
    createdContexts.push(this);
  }

  get currentTime() {
    contextTimeReads++;
    return contextTime;
  }

  decodeAudioData(data: ArrayBuffer) {
    return decodeAudioData(data);
  }

  createBufferSource(): AudioBufferSourceNode {
    const source: MockSource = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      onended: null,
      start: vi.fn(() => {
        startCount++;
        if (startCount === throwOnStartNumber) {
          throw new DOMException('Invalid schedule', 'InvalidStateError');
        }
      }),
      stop: vi.fn(),
    };
    createdSources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    const gain: MockGain = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: {
        value: 1,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
    };
    createdGains.push(gain);
    return gain as unknown as GainNode;
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    return closeAudioContext();
  }
}

function createEngine() {
  const engine = new PlaybackEngine();
  engines.push(engine);
  return engine;
}

function successfulResponse(data = new ArrayBuffer(8)): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: () => Promise.resolve(data),
  } as Response;
}

function runNextAnimationFrame() {
  const entry = animationFrames.entries().next().value as
    [number, FrameRequestCallback] | undefined;
  if (!entry) throw new Error('No animation frame was scheduled.');
  animationFrames.delete(entry[0]);
  entry[1](0);
}

vi.stubGlobal('AudioContext', MockAudioContext);
vi.stubGlobal('fetch', fetchMock);
vi.stubGlobal(
  'requestAnimationFrame',
  vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    animationFrames.set(id, callback);
    return id;
  }),
);
vi.stubGlobal(
  'cancelAnimationFrame',
  vi.fn((id: number) => {
    animationFrames.delete(id);
  }),
);

describe('PlaybackEngine reliability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdSources.length = 0;
    createdGains.length = 0;
    createdContexts.length = 0;
    animationFrames.clear();
    nextFrameId = 1;
    contextTime = 0;
    contextTimeReads = 0;
    startCount = 0;
    throwOnStartNumber = null;
    decodeAudioData.mockResolvedValue(createAudioBuffer());
    closeAudioContext.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(successfulResponse());
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.destroy();
  });

  it('rejects non-OK fetches with an actionable typed error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });
    const engine = createEngine();

    await expect(engine.loadBuffer('https://cdn.example.test/missing.wav')).rejects.toMatchObject({
      name: 'PlaybackError',
      code: 'FETCH_FAILED',
      sourceUrl: 'https://cdn.example.test/missing.wav',
      message:
        'Failed to fetch audio source "https://cdn.example.test/missing.wav": HTTP 503 Service Unavailable.',
    });
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('shares one fetch and decode across concurrent requests for the same URL', async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const engine = createEngine();

    const first = engine.loadBuffer('blob:shared');
    const second = engine.loadBuffer('blob:shared');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    response.resolve(successfulResponse());
    const [firstBuffer, secondBuffer] = await Promise.all([first, second]);

    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(firstBuffer).toBe(secondBuffer);
  });

  it('loads uncached tracks in parallel and starts them from one scheduling anchor', async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const engine = createEngine();

    const play = engine.play(
      [
        createTrack({ id: 'first', sourceUrl: 'blob:first' }),
        createTrack({ id: 'second', sourceUrl: 'blob:second' }),
      ],
      0,
      5,
      false,
    );
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    secondResponse.resolve(successfulResponse());
    firstResponse.resolve(successfulResponse());
    await play;

    expect(createdSources).toHaveLength(2);
    expect(createdSources[0].start.mock.calls[0][0]).toBe(createdSources[1].start.mock.calls[0][0]);
    expect(contextTimeReads).toBe(1);
  });

  it('rolls back playback state and every node when scheduling fails', async () => {
    throwOnStartNumber = 2;
    const engine = createEngine();

    await expect(
      engine.play(
        [
          createTrack({ id: 'first', sourceUrl: 'blob:first' }),
          createTrack({ id: 'second', sourceUrl: 'blob:second' }),
        ],
        0,
        5,
        false,
      ),
    ).rejects.toBeInstanceOf(PlaybackError);

    expect(engine.isPlaying).toBe(false);
    expect(createdSources).toHaveLength(2);
    expect(createdSources.every((source) => source.disconnect.mock.calls.length === 1)).toBe(true);
    expect(createdGains.every((gain) => gain.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it('skips out-of-range source offsets and clips with no remaining duration', async () => {
    const engine = createEngine();

    await engine.play(
      [
        createTrack({
          id: 'out-of-range',
          sourceUrl: 'blob:out-of-range',
          sourceStartOffset: 20,
        }),
        createTrack({
          id: 'empty',
          sourceUrl: 'blob:empty',
          duration: 0,
        }),
      ],
      0,
      5,
      false,
    );

    expect(createdSources).toHaveLength(0);
    expect(engine.isPlaying).toBe(true);
  });

  it.each(['pause', 'stop', 'destroy'] as const)(
    '%s during startup cancels without restarting playback',
    async (action) => {
      const response = deferred<Response>();
      fetchMock.mockReturnValue(response.promise);
      const engine = createEngine();

      const play = engine.play([createTrack()], 0, 5, false);
      await Promise.resolve();
      engine[action]();
      response.resolve(successfulResponse());
      await play;

      expect(createdSources).toHaveLength(0);
      expect(engine.isPlaying).toBe(false);
      expect(engine.isStarting).toBe(false);
    },
  );

  it('restarts a pending play at the requested seek position', async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const engine = createEngine();
    const track = createTrack();

    const initialPlay = engine.play([track], 0, 5, false);
    await Promise.resolve();
    expect(engine.isStarting).toBe(true);

    const seek = engine.seek([track], 2, 5, false);
    expect(engine.isStarting).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    response.resolve(successfulResponse());
    await Promise.all([initialPlay, seek]);

    expect(createdSources).toHaveLength(1);
    expect(createdSources[0].start).toHaveBeenCalledWith(0, 2, 3);
    expect(engine.isStarting).toBe(false);
    expect(engine.isPlaying).toBe(true);
  });

  it('preserves the requested startup position when the mix changes during loading', async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const engine = createEngine();
    const track = createTrack();

    const play = engine.play([track], 2, 5, false);
    await Promise.resolve();
    const mixUpdate = engine.updateTracks([{ ...track, volume: 0.4 }], 5);
    response.resolve(successfulResponse());
    await Promise.all([play, mixUpdate]);

    expect(createdSources).toHaveLength(1);
    expect(createdSources[0].start).toHaveBeenCalledWith(0, 2, 3);
    expect(createdGains[0].gain.value).toBe(0.4);
    expect(engine.isPlaying).toBe(true);
  });

  it('disconnects ended and stopped nodes without retaining ended nodes', async () => {
    const engine = createEngine();
    const tracks = [
      createTrack({ id: 'ended', sourceUrl: 'blob:ended' }),
      createTrack({ id: 'stopped', sourceUrl: 'blob:stopped' }),
    ];
    await engine.play(tracks, 0, 5, false);

    createdSources[0].onended?.();
    expect(createdSources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(createdGains[0].disconnect).toHaveBeenCalledTimes(1);

    await engine.updateTracks([{ ...tracks[0], volume: 0.25 }, tracks[1]], 5);
    expect(createdGains[0].gain.linearRampToValueAtTime).not.toHaveBeenCalled();

    engine.stop();
    expect(createdSources[0].stop).not.toHaveBeenCalled();
    expect(createdSources[1].stop).toHaveBeenCalledTimes(1);
    expect(createdSources[1].disconnect).toHaveBeenCalledTimes(1);
    expect(createdGains[1].disconnect).toHaveBeenCalledTimes(1);
  });

  it('smooths live volume and mute changes with a short AudioParam ramp', async () => {
    const engine = createEngine();
    const track = createTrack();
    await engine.play([track], 0, 5, false);
    contextTimeReads = 0;

    await engine.updateTracks([{ ...track, volume: 0.25 }], 5);

    const parameter = createdGains[0].gain;
    expect(parameter.cancelScheduledValues).toHaveBeenCalledWith(0);
    expect(parameter.setValueAtTime).toHaveBeenCalledWith(1, 0);
    expect(parameter.linearRampToValueAtTime).toHaveBeenCalledWith(0.25, 0.01);

    await engine.updateTracks([{ ...track, volume: 0.25, muted: true }], 5);
    expect(parameter.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 0.01);
    expect(contextTimeReads).toBe(2);
    expect(createdSources).toHaveLength(1);
    expect(createdSources[0].start).toHaveBeenCalledTimes(1);
    expect(createdSources[0].stop).not.toHaveBeenCalled();
  });

  it('schedules an initially muted track from the live playhead and source offset', async () => {
    const engine = createEngine();
    const track = createTrack({ muted: true, sourceStartOffset: 1 });
    await engine.play([track], 0, 5, false);
    expect(createdSources).toHaveLength(0);

    contextTime = 2;
    await engine.updateTracks([{ ...track, muted: false }], 5);

    expect(createdSources).toHaveLength(1);
    expect(createdSources[0].start).toHaveBeenCalledWith(2, 3, 3);
    expect(engine.isPlaying).toBe(true);
  });

  it('ignores a failed unmute load after the track is muted again', async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const engine = createEngine();
    const track = createTrack({ muted: true });
    await engine.play([track], 0, 5, false);

    const unmute = engine.updateTracks([{ ...track, muted: false }], 5);
    await Promise.resolve();
    await engine.updateTracks([track], 5);
    response.reject(new Error('network failed'));

    await expect(unmute).resolves.toBeUndefined();
    expect(createdSources).toHaveLength(0);
    expect(engine.isPlaying).toBe(true);
  });

  it('uses the latest live mix when scheduling the next loop', async () => {
    const engine = createEngine();
    const track = createTrack({ duration: 1 });
    await engine.play([track], 0, 1, true);

    await engine.updateTracks([{ ...track, volume: 0.3 }], 1);
    contextTime = 2;
    runNextAnimationFrame();
    await vi.waitFor(() => expect(createdSources).toHaveLength(2));

    expect(createdGains[1].gain.value).toBe(0.3);
    expect(engine.isPlaying).toBe(true);
  });

  it('cancels a pending loop schedule when the latest mix mutes the track', async () => {
    const engine = createEngine();
    const track = createTrack({ duration: 1 });
    await engine.play([track], 0, 1, true);

    contextTime = 2;
    runNextAnimationFrame();
    await engine.updateTracks([{ ...track, muted: true }], 1);
    await Promise.resolve();

    expect(createdSources).toHaveLength(1);
    expect(createdSources[0].stop).toHaveBeenCalledTimes(1);
    expect(engine.isPlaying).toBe(true);
    expect(animationFrames.size).toBe(1);
  });

  it('atomically reschedules source changes and removals at the current position', async () => {
    const engine = createEngine();
    const first = createTrack({ id: 'first', sourceUrl: 'blob:first' });
    const second = createTrack({ id: 'second', sourceUrl: 'blob:second' });
    await engine.play([first, second], 0, 5, false);

    contextTime = 2;
    await engine.updateTracks([{ ...first, sourceUrl: 'blob:replacement' }], 5);

    expect(createdSources).toHaveLength(3);
    expect(createdSources[0].stop).toHaveBeenCalledTimes(1);
    expect(createdSources[1].stop).toHaveBeenCalledTimes(1);
    expect(createdSources[2].start).toHaveBeenCalledWith(2, 2, 3);
    expect(engine.isPlaying).toBe(true);
  });

  it('synchronizes live volume without restarting playback', async () => {
    const engine = createEngine();
    const track = createTrack();
    await engine.play([track], 0, 5, false);

    await engine.syncTracks([{ ...track, volume: 0.25 }]);
    await engine.syncTracks([{ ...track, volume: 0.25 }]);

    expect(createdSources).toHaveLength(1);
    expect(createdGains[0].gain.linearRampToValueAtTime).toHaveBeenCalledTimes(1);
    expect(createdGains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.25, 0.01);
  });

  it('smooths a live mute to zero without restarting playback', async () => {
    const engine = createEngine();
    const track = createTrack();
    await engine.play([track], 0, 5, false);

    await engine.syncTracks([{ ...track, muted: true }]);

    expect(createdSources).toHaveLength(1);
    expect(createdGains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 0.01);
  });

  it('starts an initially muted track at the current playhead when unmuted', async () => {
    const engine = createEngine();
    const activeTrack = createTrack({ id: 'active', sourceUrl: 'blob:active' });
    const mutedTrack = createTrack({ id: 'muted', sourceUrl: 'blob:muted', muted: true });
    await engine.play([activeTrack, mutedTrack], 0, 5, false);
    contextTime = 2;

    await engine.syncTracks([activeTrack, { ...mutedTrack, muted: false }]);

    expect(createdSources).toHaveLength(2);
    expect(createdSources[0].stop).not.toHaveBeenCalled();
    expect(createdSources[1].start).toHaveBeenCalledWith(2, 2, 3);
    expect(engine.isPlaying).toBe(true);
  });

  it('does not duplicate a pending unmute across rapid track syncs', async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const engine = createEngine();
    const mutedTrack = createTrack({ muted: true });
    await engine.play([mutedTrack], 0, 5, false);

    const unmutedTrack = { ...mutedTrack, muted: false };
    const firstSync = engine.syncTracks([unmutedTrack]);
    const secondSync = engine.syncTracks([{ ...unmutedTrack }]);
    response.resolve(successfulResponse());
    await Promise.all([firstSync, secondSync]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createdSources).toHaveLength(1);
  });

  it('does not start a pending unmute after playback is paused', async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const engine = createEngine();
    const mutedTrack = createTrack({ muted: true });
    await engine.play([mutedTrack], 0, 5, false);

    const sync = engine.syncTracks([{ ...mutedTrack, muted: false }]);
    await Promise.resolve();
    engine.pause();
    response.resolve(successfulResponse());
    await sync;

    expect(createdSources).toHaveLength(0);
    expect(engine.isPlaying).toBe(false);
  });

  it('suppresses a stale unmute rejection after playback is paused', async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const engine = createEngine();
    const mutedTrack = createTrack({ muted: true });
    await engine.play([mutedTrack], 0, 5, false);

    const sync = engine.syncTracks([{ ...mutedTrack, muted: false }]);
    await Promise.resolve();
    engine.pause();
    response.reject(new Error('stale network failure'));

    await expect(sync).resolves.toBeUndefined();
    expect(createdSources).toHaveLength(0);
    expect(engine.isPlaying).toBe(false);
  });

  it('suppresses a stale unmute rejection after newer playback starts', async () => {
    const oldResponse = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(successfulResponse());
    const engine = createEngine();
    const mutedTrack = createTrack({ muted: true });
    await engine.play([mutedTrack], 0, 5, false);

    const staleSync = engine.syncTracks([{ ...mutedTrack, muted: false }]);
    await Promise.resolve();
    const replacement = { ...mutedTrack, sourceUrl: 'blob:new', muted: false };
    await engine.play([replacement], 1, 5, false);
    oldResponse.reject(new Error('stale old-source failure'));

    await expect(staleSync).resolves.toBeUndefined();
    expect(createdSources).toHaveLength(1);
    expect(createdSources[0].start).toHaveBeenCalledWith(0, 1, 4);
    expect(engine.isPlaying).toBe(true);
  });

  it('surfaces one active unmute failure across overlapping sync calls', async () => {
    fetchMock.mockRejectedValue(new Error('active network failure'));
    const engine = createEngine();
    const mutedTrack = createTrack({ muted: true });
    await engine.play([mutedTrack], 0, 5, false);

    const unmutedTrack = { ...mutedTrack, muted: false };
    const firstSync = engine.syncTracks([unmutedTrack]);
    const secondSync = engine.syncTracks([{ ...unmutedTrack }]);
    const results = await Promise.allSettled([firstSync, secondSync]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('schedules valid co-batched tracks when another stale load fails', async () => {
    const staleResponse = deferred<Response>();
    const validResponse = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(staleResponse.promise)
      .mockReturnValueOnce(validResponse.promise);
    const staleTrack = createTrack({
      id: 'stale',
      sourceUrl: 'blob:stale',
      muted: true,
    });
    const validTrack = createTrack({
      id: 'valid',
      sourceUrl: 'blob:valid',
      muted: true,
    });
    const engine = createEngine();
    await engine.play([staleTrack, validTrack], 0, 5, false);

    const sync = engine.syncTracks([
      { ...staleTrack, muted: false },
      { ...validTrack, muted: false },
    ]);
    await Promise.resolve();
    await engine.syncTracks([
      staleTrack,
      { ...validTrack, muted: false },
    ]);
    staleResponse.reject(new Error('stale load failed'));
    validResponse.resolve(successfulResponse());
    await sync;

    expect(createdSources).toHaveLength(1);
    expect(createdSources[0].start).toHaveBeenCalledTimes(1);
  });

  it('adds a track without restarting existing nodes and extends the boundary', async () => {
    const existing = createTrack({ id: 'existing', sourceUrl: 'blob:existing' });
    const added = createTrack({
      id: 'added',
      sourceUrl: 'blob:added',
      duration: 10,
    });
    const engine = createEngine();
    await engine.play([existing], 0, 5, false);

    contextTime = 2;
    await engine.syncTracks([existing, added], 10);

    expect(createdSources).toHaveLength(2);
    expect(createdSources[0].stop).not.toHaveBeenCalled();
    expect(createdSources[1].start).toHaveBeenCalledWith(2, 2, 8);

    contextTime = 6;
    runNextAnimationFrame();
    expect(engine.isPlaying).toBe(true);
  });

  it('removes a track without disturbing retained nodes', async () => {
    const retained = createTrack({ id: 'retained', sourceUrl: 'blob:retained' });
    const removed = createTrack({ id: 'removed', sourceUrl: 'blob:removed' });
    const engine = createEngine();
    await engine.play([retained, removed], 0, 5, false);

    await engine.syncTracks([retained], 5);

    expect(createdSources[0].stop).not.toHaveBeenCalled();
    expect(createdSources[1].stop).toHaveBeenCalledTimes(1);
    expect(createdSources[1].disconnect).toHaveBeenCalledTimes(1);
  });

  it('replaces a changed source without disturbing other tracks', async () => {
    const retained = createTrack({ id: 'retained', sourceUrl: 'blob:retained' });
    const changed = createTrack({ id: 'changed', sourceUrl: 'blob:old' });
    const engine = createEngine();
    await engine.play([retained, changed], 0, 5, false);

    contextTime = 2;
    await engine.syncTracks([retained, { ...changed, sourceUrl: 'blob:new' }], 5);

    expect(createdSources).toHaveLength(3);
    expect(createdSources[0].stop).not.toHaveBeenCalled();
    expect(createdSources[1].stop).toHaveBeenCalledTimes(1);
    expect(createdSources[2].start).toHaveBeenCalledWith(2, 2, 3);
    expect(fetchMock).toHaveBeenCalledWith('blob:new');
  });

  it('reschedules timing changes at the current playhead', async () => {
    const track = createTrack();
    const engine = createEngine();
    await engine.play([track], 0, 6, false);

    contextTime = 2;
    await engine.syncTracks(
      [{ ...track, startOffset: 1, duration: 6, sourceStartOffset: 1 }],
      7,
    );

    expect(createdSources).toHaveLength(2);
    expect(createdSources[0].stop).toHaveBeenCalledTimes(1);
    expect(createdSources[1].start).toHaveBeenCalledWith(2, 2, 5);
  });

  it('refreshes unrelated track metadata without rescheduling playback', async () => {
    const track = createTrack();
    const engine = createEngine();
    await engine.play([track], 0, 5, false);

    await engine.syncTracks([{ ...track, name: 'Renamed track' }], 5);

    expect(createdSources).toHaveLength(1);
    expect(createdSources[0].stop).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('binds pending replacement loads to source identity so the newest URL wins', async () => {
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    const oldData = new ArrayBuffer(4);
    const newData = new ArrayBuffer(6);
    const oldBuffer = createAudioBuffer(4);
    const newBuffer = createAudioBuffer(6);
    fetchMock
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise);
    decodeAudioData.mockImplementation((data: ArrayBuffer) =>
      Promise.resolve(data === oldData ? oldBuffer : newBuffer),
    );
    const engine = createEngine();
    const mutedTrack = createTrack({ muted: true, sourceUrl: 'blob:old' });
    await engine.play([mutedTrack], 0, 5, false);

    const oldSync = engine.syncTracks([{ ...mutedTrack, muted: false }]);
    await Promise.resolve();
    const newTrack = { ...mutedTrack, muted: false, sourceUrl: 'blob:new' };
    const newSync = engine.syncTracks([newTrack]);
    newResponse.resolve(successfulResponse(newData));
    await newSync;
    oldResponse.resolve(successfulResponse(oldData));
    await oldSync;

    expect(createdSources).toHaveLength(1);
    expect(createdSources[0].buffer).toBe(newBuffer);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['blob:old', 'blob:new']);
  });

  it('uses the latest volume and mute values on the next loop', async () => {
    const first = createTrack({ id: 'first', sourceUrl: 'blob:first' });
    const second = createTrack({ id: 'second', sourceUrl: 'blob:second' });
    const engine = createEngine();
    await engine.play([first, second], 0, 5, true);

    await engine.syncTracks([
      { ...first, volume: 0.3 },
      { ...second, muted: true },
    ]);
    contextTime = 6;
    runNextAnimationFrame();
    await vi.waitFor(() => expect(createdSources).toHaveLength(3));

    expect(createdGains[2].gain.value).toBe(0.3);
    expect(createdSources.filter((source) => source.start.mock.calls.length > 0)).toHaveLength(3);
  });

  it('does not spawn stale loop nodes when a seek wins a loop-load race', async () => {
    const loopResponse = deferred<Response>();
    fetchMock.mockReturnValue(loopResponse.promise);
    const loopTrack = createTrack({ muted: true, duration: 1 });
    const engine = createEngine();
    await engine.play([loopTrack], 0, 1, true);

    loopTrack.muted = false;
    contextTime = 2;
    runNextAnimationFrame();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await engine.seek([], 0.5, 2, false);
    loopResponse.resolve(successfulResponse());
    await Promise.resolve();
    await Promise.resolve();

    expect(createdSources).toHaveLength(0);
    expect(engine.isPlaying).toBe(true);
  });

  it('ends once when looping is disabled before the project boundary', async () => {
    const onEnd = vi.fn();
    const engine = createEngine();
    engine.setCallbacks(vi.fn(), onEnd);
    await engine.play([createTrack({ muted: true })], 0, 1, true);

    engine.setLoopEnabled(false);
    contextTime = 2;
    runNextAnimationFrame();

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(engine.isPlaying).toBe(false);
    expect(animationFrames.size).toBe(0);
  });

  it('loops when looping is enabled before the project boundary', async () => {
    const onEnd = vi.fn();
    const engine = createEngine();
    engine.setCallbacks(vi.fn(), onEnd);
    await engine.play([createTrack()], 0, 1, false);

    engine.setLoopEnabled(true);
    contextTime = 2;
    runNextAnimationFrame();
    await vi.waitFor(() => expect(createdSources).toHaveLength(2));

    expect(onEnd).not.toHaveBeenCalled();
    expect(engine.isPlaying).toBe(true);
  });

  it('continues to the project boundary and loops after a shorter video would end', async () => {
    const onEnd = vi.fn();
    const engine = createEngine();
    engine.setCallbacks(vi.fn(), onEnd);
    await engine.play([createTrack()], 0, 5, true);

    contextTime = 2;
    runNextAnimationFrame();
    expect(createdSources).toHaveLength(1);
    expect(onEnd).not.toHaveBeenCalled();
    expect(engine.isPlaying).toBe(true);
    expect(animationFrames.size).toBe(1);

    contextTime = 6;
    runNextAnimationFrame();
    await vi.waitFor(() => expect(createdSources).toHaveLength(2));
    expect(onEnd).not.toHaveBeenCalled();
    expect(engine.isPlaying).toBe(true);
  });

  it('preserves a loop toggle made during pending startup', async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const onEnd = vi.fn();
    const engine = createEngine();
    engine.setCallbacks(vi.fn(), onEnd);

    const play = engine.play([createTrack()], 0, 1, false);
    await Promise.resolve();
    engine.setLoopEnabled(true);
    response.resolve(successfulResponse());
    await play;

    contextTime = 2;
    runNextAnimationFrame();
    await vi.waitFor(() => expect(createdSources).toHaveLength(2));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    expect(engine.isPlaying).toBe(true);
  });

  it('preserves disabling loop during pending startup', async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const onEnd = vi.fn();
    const engine = createEngine();
    engine.setCallbacks(vi.fn(), onEnd);

    const play = engine.play([createTrack()], 0, 1, true);
    await Promise.resolve();
    engine.setLoopEnabled(false);
    response.resolve(successfulResponse());
    await play;

    contextTime = 2;
    runNextAnimationFrame();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createdSources).toHaveLength(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(engine.isPlaying).toBe(false);
  });

  it('cancels a pending loop restart when looping is disabled', async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const onEnd = vi.fn();
    const loopTrack = createTrack({ muted: true, duration: 1 });
    const engine = createEngine();
    engine.setCallbacks(vi.fn(), onEnd);
    await engine.play([loopTrack], 0, 1, true);

    loopTrack.muted = false;
    contextTime = 2;
    runNextAnimationFrame();
    await Promise.resolve();
    engine.setLoopEnabled(false);
    engine.setLoopEnabled(true);
    response.resolve(successfulResponse());
    await vi.waitFor(() => expect(decodeAudioData).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(createdSources).toHaveLength(0);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(engine.isPlaying).toBe(false);
    expect(animationFrames.size).toBe(0);
  });

  it('does not resurrect playback when stopped during a pending loop restart', async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const loopTrack = createTrack({ muted: true, duration: 1 });
    const engine = createEngine();
    await engine.play([loopTrack], 0, 1, true);

    loopTrack.muted = false;
    contextTime = 2;
    runNextAnimationFrame();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    engine.stop();
    response.resolve(successfulResponse());
    await vi.waitFor(() => expect(decodeAudioData).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(createdSources).toHaveLength(0);
    expect(engine.isPlaying).toBe(false);
    expect(engine.isStarting).toBe(false);
    expect(animationFrames.size).toBe(0);
  });

  it('attempts every node and completes destroy when cleanup fails', async () => {
    const onError = vi.fn();
    const first = createTrack({ id: 'first', sourceUrl: 'blob:first' });
    const second = createTrack({ id: 'second', sourceUrl: 'blob:second' });
    const engine = createEngine();
    engine.setCallbacks(vi.fn(), vi.fn(), onError);
    await engine.play([first, second], 0, 5, false);
    createdSources[0].stop.mockImplementation(() => {
      throw new Error('stop failed');
    });
    createdSources[0].disconnect.mockImplementation(() => {
      throw new Error('source disconnect failed');
    });
    createdGains[0].disconnect.mockImplementation(() => {
      throw new Error('gain disconnect failed');
    });

    expect(() => engine.destroy()).not.toThrow();

    expect(createdSources[1].stop).toHaveBeenCalledTimes(1);
    expect(createdSources[1].disconnect).toHaveBeenCalledTimes(1);
    expect(createdGains[1].disconnect).toHaveBeenCalledTimes(1);
    expect(closeAudioContext).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ code: 'NODE_CLEANUP_FAILED' });
    const nodeErrors = onError.mock.calls[0][0].cause as PlaybackError[];
    expect(nodeErrors[0].cause).toHaveLength(3);
    await expect(engine.loadBuffer('blob:first')).rejects.toMatchObject({
      code: 'CONTEXT_FAILED',
    });
  });

  it('stops consistently and reports once when loop restart cleanup fails', async () => {
    const onEnd = vi.fn();
    const onError = vi.fn();
    const engine = createEngine();
    engine.setCallbacks(vi.fn(), onEnd, onError);
    await engine.play([createTrack()], 0, 1, true);
    createdSources[0].stop.mockImplementation(() => {
      throw new Error('stop failed');
    });

    contextTime = 2;
    runNextAnimationFrame();
    await Promise.resolve();

    expect(engine.isPlaying).toBe(false);
    expect(engine.isStarting).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ code: 'NODE_CLEANUP_FAILED' });
    expect(animationFrames.size).toBe(0);
  });
});
