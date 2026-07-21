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
const fetchMock = vi.fn();
const engines: PlaybackEngine[] = [];
const animationFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
let contextTime = 0;
let contextTimeReads = 0;
let startCount = 0;
let throwOnStartNumber: number | null = null;

class MockAudioContext {
  state: AudioContextState = 'running';
  destination = {};

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
    return Promise.resolve();
  }
}

function createEngine() {
  const engine = new PlaybackEngine();
  engines.push(engine);
  return engine;
}

function successfulResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  } as Response;
}

function runNextAnimationFrame() {
  const entry = animationFrames.entries().next().value as
    | [number, FrameRequestCallback]
    | undefined;
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
    animationFrames.clear();
    nextFrameId = 1;
    contextTime = 0;
    contextTimeReads = 0;
    startCount = 0;
    throwOnStartNumber = null;
    decodeAudioData.mockResolvedValue(createAudioBuffer());
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
    expect(createdSources[0].start.mock.calls[0][0]).toBe(
      createdSources[1].start.mock.calls[0][0],
    );
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

    engine.updateTrackVolume('ended', [
      { ...tracks[0], volume: 0.25 },
      tracks[1],
    ]);
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

    engine.updateTrackVolume(track.id, [{ ...track, volume: 0.25 }]);

    const parameter = createdGains[0].gain;
    expect(parameter.cancelScheduledValues).toHaveBeenCalledWith(0);
    expect(parameter.setValueAtTime).toHaveBeenCalledWith(1, 0);
    expect(parameter.linearRampToValueAtTime).toHaveBeenCalledWith(0.25, 0.01);

    engine.updateTrackVolume(track.id, [{ ...track, muted: true }]);
    expect(parameter.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 0.01);
    expect(contextTimeReads).toBe(2);
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
});
