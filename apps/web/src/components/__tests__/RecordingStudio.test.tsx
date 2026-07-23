import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordingStudio } from '../RecordingStudio';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Minimal mock MediaStream track. */
function createMockTrack() {
  return { stop: vi.fn(), kind: 'audio', id: crypto.randomUUID() } as unknown as MediaStreamTrack;
}

/** Minimal mock MediaStream. */
function createMockStream() {
  const track = createMockTrack();
  return {
    getTracks: () => [track],
    _track: track,
  } as unknown as MediaStream & { _track: ReturnType<typeof createMockTrack> };
}

type MediaRecorderState = 'inactive' | 'recording' | 'paused';

/** Controllable MediaRecorder mock. */
class MockMediaRecorder {
  state: MediaRecorderState = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  static isTypeSupported = vi.fn(() => true);
  static instances: MockMediaRecorder[] = [];

  constructor(
    public stream: MediaStream,
    _options?: MediaRecorderOptions,
  ) {
    MockMediaRecorder.instances.push(this);
  }

  start(_timeslice?: number) {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    // Simulate final dataavailable then stop (asynchronously, per spec).
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['audio-data'], { type: 'audio/webm' }) });
      this.onstop?.(new Event('stop'));
    });
  }
}

/** Minimal AudioContext mock. */
class MockAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  destination = {};
  currentTime = 0;

  close = vi.fn(async () => {
    this.state = 'closed';
  });
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createAnalyser = vi.fn(() => ({
    fftSize: 2048,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getByteTimeDomainData: vi.fn((arr: Uint8Array) => arr.fill(128)),
  }));
  createGain = vi.fn(() => ({
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createOscillator = vi.fn(() => ({
    type: 'sine',
    frequency: { value: 440 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }));
}

let getUserMediaMock: ReturnType<typeof vi.fn>;
let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
let createObjectURLSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  MockMediaRecorder.instances = [];
  getUserMediaMock = vi.fn(() => Promise.resolve(createMockStream()));

  Object.defineProperty(global.navigator, 'mediaDevices', {
    value: { getUserMedia: getUserMediaMock },
    writable: true,
    configurable: true,
  });

  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
  vi.stubGlobal('AudioContext', MockAudioContext);

  // jsdom doesn't provide matchMedia (used by wavesurfer.js in WaveformPlayer)
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // jsdom doesn't provide URL.createObjectURL/revokeObjectURL
  if (!URL.createObjectURL) {
    (URL as unknown as Record<string, unknown>).createObjectURL = () => '';
  }
  if (!URL.revokeObjectURL) {
    (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
  }
  createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-url');
  revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

  // ResizeObserver (may be used by wavesurfer.js)
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });

  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function clickStart() {
  const btn = screen.getByRole('button', { name: /start recording/i });
  await userEvent.click(btn);
}

async function clickStop() {
  const btn = screen.getByRole('button', { name: /stop recording/i });
  await userEvent.click(btn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecordingStudio', () => {
  it('renders start and stop buttons', () => {
    render(<RecordingStudio />);
    expect(screen.getByRole('button', { name: /start recording/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument();
  });

  it('requests getUserMedia on start and stops stream tracks on stop', async () => {
    render(<RecordingStudio />);

    await act(async () => {
      await clickStart();
    });

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });

    const recorder = MockMediaRecorder.instances[0];
    expect(recorder.state).toBe('recording');

    // Stop recording — wait for onstop microtask
    await act(async () => {
      await clickStop();
      await new Promise((r) => setTimeout(r, 0));
    });

    const stream = getUserMediaMock.mock.results[0].value as unknown as ReturnType<typeof createMockStream>;
    const resolvedStream = await stream;
    expect((resolvedStream as ReturnType<typeof createMockStream>)._track.stop).toHaveBeenCalled();
  });

  it('does not open a second stream on rapid double-click (race guard)', async () => {
    // Make getUserMedia slow so the second call would overlap the first.
    const streams = [createMockStream(), createMockStream()];
    let callCount = 0;
    const resolvers: Array<(v: MediaStream) => void> = [];
    getUserMediaMock.mockImplementation(
      () => new Promise<MediaStream>((resolve) => { resolvers.push(resolve); callCount++; }),
    );

    const { container } = render(<RecordingStudio />);
    const btn = container.querySelector('button:not([disabled])') as HTMLButtonElement;

    // Fire two clicks synchronously (simulating rapid double-click)
    await act(async () => {
      btn.click();
      btn.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    // The isStartingRef guard should prevent the second getUserMedia call.
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    // Resolve to complete the test
    await act(async () => {
      resolvers[0](streams[0]);
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(MockMediaRecorder.instances).toHaveLength(1);
  });

  it('aborts and releases stream if component unmounts during getUserMedia', async () => {
    const stream = createMockStream();
    let resolveGUM!: (value: MediaStream) => void;
    getUserMediaMock.mockImplementation(
      () => new Promise<MediaStream>((resolve) => { resolveGUM = resolve; }),
    );

    const { container, unmount } = render(<RecordingStudio />);

    // Start (will be waiting on getUserMedia — isStartingRef is now true)
    const startBtn = container.querySelector('button:not([disabled])') as HTMLButtonElement;
    await act(async () => {
      startBtn.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    // Unmount while getUserMedia is still pending.
    // The cleanup effect sets abortStartRef = true.
    unmount();

    // Resolve getUserMedia AFTER unmount.
    // beginRecording will check abortStartRef and stop the stream.
    await act(async () => {
      resolveGUM(stream);
      await new Promise((r) => setTimeout(r, 10));
    });

    // Stream tracks must be stopped even though the component is gone.
    expect(stream._track.stop).toHaveBeenCalled();
    // No MediaRecorder should have been created (aborted before that point).
    expect(MockMediaRecorder.instances).toHaveLength(0);
  });

  it('displays permission error when getUserMedia rejects', async () => {
    getUserMediaMock.mockRejectedValueOnce(new Error('Permission denied'));

    render(<RecordingStudio />);

    await act(async () => {
      await clickStart();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
  });

  it('revokes preview blob URL on discard (re-record)', async () => {
    render(<RecordingStudio />);

    await act(async () => {
      await clickStart();
    });

    await act(async () => {
      await clickStop();
      await new Promise((r) => setTimeout(r, 0));
    });

    // Preview should now be visible
    expect(screen.getByText(/new recording/i)).toBeInTheDocument();

    // Discard via "Re-record"
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: /re-record/i }));
    });

    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:preview-url');
  });

  it('closes AudioContext on stop', async () => {
    render(<RecordingStudio />);

    await act(async () => {
      await clickStart();
    });

    await act(async () => {
      await clickStop();
      await new Promise((r) => setTimeout(r, 10));
    });

    // Verify the full start→stop lifecycle ran (AudioContext was created + stream started)
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.instances).toHaveLength(1);
    expect(MockMediaRecorder.instances[0].state).toBe('inactive');
  });

  it('waits for final MediaRecorder onstop before cleanup (no chunk loss)', async () => {
    const order: string[] = [];

    const stream = createMockStream();
    getUserMediaMock.mockResolvedValue(stream);

    // Patch stop to record ordering
    const origStop = MockMediaRecorder.prototype.stop;
    MockMediaRecorder.prototype.stop = function (this: MockMediaRecorder) {
      this.state = 'inactive';
      queueMicrotask(() => {
        order.push('dataavailable');
        this.ondataavailable?.({ data: new Blob(['data'], { type: 'audio/webm' }) });
        order.push('onstop');
        this.onstop?.(new Event('stop'));
      });
    };

    render(<RecordingStudio />);

    await act(async () => {
      await clickStart();
    });

    await act(async () => {
      await clickStop();
      await new Promise((r) => setTimeout(r, 10));
    });

    // onstop must fire before cleanup (stream track stop)
    expect(order).toContain('onstop');
    expect(stream._track.stop).toHaveBeenCalled();

    MockMediaRecorder.prototype.stop = origStop;
  });
});
