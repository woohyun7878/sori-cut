import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Metronome,
  beatIntervalSeconds,
  beatInBar,
  isAccent,
  countInBeats,
  clampBpm,
  parseTimeSignature,
  formatTimeSignature,
  DEFAULT_TIME_SIGNATURE,
  DEFAULT_BPM,
  MIN_BPM,
  MAX_BPM,
  SCHEDULER_LOOKAHEAD_MS,
} from '../metronome';

const ACCENT_FREQUENCY = 1500;
const BEAT_FREQUENCY = 900;

// --- Pure scheduler math -----------------------------------------------------

describe('clampBpm', () => {
  it('rounds fractional BPM values', () => {
    expect(clampBpm(119.4)).toBe(119);
    expect(clampBpm(119.6)).toBe(120);
  });

  it('clamps to the supported range', () => {
    expect(clampBpm(5)).toBe(MIN_BPM);
    expect(clampBpm(9000)).toBe(MAX_BPM);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampBpm(Number.NaN)).toBe(DEFAULT_BPM);
    expect(clampBpm(Number.POSITIVE_INFINITY)).toBe(DEFAULT_BPM);
  });
});

describe('beatIntervalSeconds (BPM-to-interval math)', () => {
  it('is 60 / bpm for 4/4', () => {
    expect(beatIntervalSeconds(120)).toBeCloseTo(0.5, 10);
    expect(beatIntervalSeconds(60)).toBeCloseTo(1, 10);
    expect(beatIntervalSeconds(90)).toBeCloseTo(60 / 90, 10);
  });

  it('scales with the time-signature denominator', () => {
    // 6/8 at 120 quarter-note BPM → eighth-note clicks (half the interval).
    expect(beatIntervalSeconds(120, { beatsPerBar: 6, beatUnit: 8 })).toBeCloseTo(0.25, 10);
    // x/2 signatures → half-note clicks (double the interval).
    expect(beatIntervalSeconds(120, { beatsPerBar: 2, beatUnit: 2 })).toBeCloseTo(1, 10);
  });

  it('clamps the BPM before computing', () => {
    expect(beatIntervalSeconds(0)).toBeCloseTo(60 / MIN_BPM, 10);
  });
});

describe('beat accent pattern', () => {
  it('accents only the first beat of each 4/4 bar', () => {
    const pattern = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => isAccent(i, 4));
    expect(pattern).toEqual([true, false, false, false, true, false, false, false]);
  });

  it('accents the first beat of a 3/4 bar', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => isAccent(i, 3))).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it('computes position within the bar', () => {
    expect(beatInBar(0, 4)).toBe(0);
    expect(beatInBar(5, 4)).toBe(1);
    expect(beatInBar(-1, 4)).toBe(3);
  });
});

describe('countInBeats (count-in beat count)', () => {
  it('multiplies bars by beats-per-bar', () => {
    expect(countInBeats(1, DEFAULT_TIME_SIGNATURE)).toBe(4);
    expect(countInBeats(2, DEFAULT_TIME_SIGNATURE)).toBe(8);
    expect(countInBeats(2, { beatsPerBar: 3, beatUnit: 4 })).toBe(6);
  });

  it('treats zero / negative / non-finite bars as no count-in', () => {
    expect(countInBeats(0, DEFAULT_TIME_SIGNATURE)).toBe(0);
    expect(countInBeats(-3, DEFAULT_TIME_SIGNATURE)).toBe(0);
    expect(countInBeats(Number.NaN, DEFAULT_TIME_SIGNATURE)).toBe(0);
  });
});

describe('time signature parse / format', () => {
  it('parses "n/d" strings', () => {
    expect(parseTimeSignature('3/4')).toEqual({ beatsPerBar: 3, beatUnit: 4 });
    expect(parseTimeSignature('6/8')).toEqual({ beatsPerBar: 6, beatUnit: 8 });
  });

  it('falls back to 4/4 for malformed input', () => {
    expect(parseTimeSignature('garbage')).toEqual(DEFAULT_TIME_SIGNATURE);
    expect(parseTimeSignature('0/0')).toEqual(DEFAULT_TIME_SIGNATURE);
  });

  it('formats a time signature', () => {
    expect(formatTimeSignature({ beatsPerBar: 5, beatUnit: 4 })).toBe('5/4');
  });
});

// --- Scheduler behaviour with a mocked AudioContext --------------------------

interface ScheduledOsc {
  frequency: { value: number };
  type: string;
  startTime: number;
  stopTime: number;
  connect: ReturnType<typeof vi.fn>;
}

class MockGainNode {
  gain = {
    value: 1,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockAudioContext {
  currentTime = 0;
  state: 'running' | 'suspended' | 'closed' = 'running';
  destination = {};
  createdOscillators: ScheduledOsc[] = [];
  gains: MockGainNode[] = [];

  createOscillator(): ScheduledOsc {
    const osc: ScheduledOsc = {
      frequency: { value: 0 },
      type: 'sine',
      startTime: -1,
      stopTime: -1,
      connect: vi.fn(),
      start(this: ScheduledOsc, when: number) {
        this.startTime = when;
      },
      stop(this: ScheduledOsc, when: number) {
        this.stopTime = when;
      },
    } as unknown as ScheduledOsc;
    this.createdOscillators.push(osc);
    return osc;
  }

  createGain(): MockGainNode {
    const gain = new MockGainNode();
    this.gains.push(gain);
    return gain;
  }

  async close() {
    this.state = 'closed';
  }

  async resume() {
    this.state = 'running';
  }
}

/**
 * Advance the simulated audio clock and the fake timers together, in lookahead-
 * sized steps, so the scheduler wakes up and observes a moving `currentTime`.
 */
function advance(ctx: MockAudioContext, seconds: number) {
  const stepMs = SCHEDULER_LOOKAHEAD_MS;
  let remaining = seconds * 1000;
  while (remaining > 0) {
    const step = Math.min(stepMs, remaining);
    ctx.currentTime += step / 1000;
    vi.advanceTimersByTime(step);
    remaining -= step;
  }
}

describe('Metronome scheduler', () => {
  let ctx: MockAudioContext;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new MockAudioContext();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function makeMetronome() {
    return new Metronome({ context: ctx as unknown as AudioContext });
  }

  it('schedules count-in clicks spaced by the BPM interval', () => {
    const metronome = makeMetronome();
    metronome.start({
      bpm: 120,
      timeSignature: DEFAULT_TIME_SIGNATURE,
      countInBars: 1,
      continueAfterCountIn: false,
    });

    advance(ctx, 3);

    // 1 bar of 4/4 count-in → exactly 4 clicks (downbeat itself is not sounded).
    expect(ctx.createdOscillators).toHaveLength(4);

    const startTimes = ctx.createdOscillators.map((o) => o.startTime);
    for (let i = 1; i < startTimes.length; i++) {
      expect(startTimes[i] - startTimes[i - 1]).toBeCloseTo(0.5, 5);
    }
  });

  it('accents beat 1 of every bar', () => {
    const metronome = makeMetronome();
    metronome.start({
      bpm: 200, // fast so two bars fit quickly
      timeSignature: DEFAULT_TIME_SIGNATURE,
      countInBars: 0,
      continueAfterCountIn: true,
    });

    advance(ctx, 2.6);
    metronome.stop();

    const freqs = ctx.createdOscillators.map((o) => o.frequency.value);
    expect(freqs.length).toBeGreaterThanOrEqual(8);
    // Accent (higher pitch) on every 4th click, plain click otherwise.
    freqs.forEach((freq, index) => {
      if (index % 4 === 0) {
        expect(freq).toBe(ACCENT_FREQUENCY);
      } else {
        expect(freq).toBe(BEAT_FREQUENCY);
      }
    });
  });

  it('honours the time-signature denominator when spacing clicks', () => {
    const metronome = makeMetronome();
    metronome.start({
      bpm: 120,
      timeSignature: { beatsPerBar: 6, beatUnit: 8 },
      continueAfterCountIn: true,
    });

    advance(ctx, 1);
    metronome.stop();

    const startTimes = ctx.createdOscillators.map((o) => o.startTime);
    expect(startTimes.length).toBeGreaterThanOrEqual(3);
    // 6/8 at 120 → eighth-note clicks, 0.25s apart.
    expect(startTimes[1] - startTimes[0]).toBeCloseTo(0.25, 5);
  });

  it('fires onCountInComplete once after the count-in beats', () => {
    const metronome = makeMetronome();
    const onCountInComplete = vi.fn();
    const countInBeatsSeen: number[] = [];

    metronome.start({
      bpm: 120,
      countInBars: 1,
      continueAfterCountIn: true,
      onCountInComplete,
      onBeat: (beat) => {
        if (beat.countIn) {
          countInBeatsSeen.push(beat.beatInBar);
        }
      },
    });

    // Before the count-in elapses, it must not have fired.
    advance(ctx, 1);
    expect(onCountInComplete).not.toHaveBeenCalled();

    // After 1 bar (4 * 0.5s ≈ 2s) it fires exactly once.
    advance(ctx, 2);
    expect(onCountInComplete).toHaveBeenCalledTimes(1);

    // The count-in surfaced 4 beats (positions 0..3).
    expect(countInBeatsSeen).toEqual([0, 1, 2, 3]);

    metronome.stop();
  });

  it('keeps clicking after the count-in when continueAfterCountIn is true', () => {
    const metronome = makeMetronome();
    metronome.start({
      bpm: 240,
      countInBars: 1,
      continueAfterCountIn: true,
    });

    advance(ctx, 3);
    // 4 count-in clicks + several main-phase clicks.
    expect(ctx.createdOscillators.length).toBeGreaterThan(4);
    expect(metronome.isRunning).toBe(true);

    metronome.stop();
    expect(metronome.isRunning).toBe(false);
  });

  it('auto-stops after a count-in-only run and reports it', () => {
    const metronome = makeMetronome();
    const onStop = vi.fn();
    const onCountInComplete = vi.fn();

    metronome.start({
      bpm: 120,
      countInBars: 1,
      continueAfterCountIn: false,
      onStop,
      onCountInComplete,
    });

    advance(ctx, 3);

    expect(onCountInComplete).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(metronome.isRunning).toBe(false);
    // Only the 4 count-in clicks were produced.
    expect(ctx.createdOscillators).toHaveLength(4);
  });

  it('does not fire onCountInComplete when there is no count-in', () => {
    const metronome = makeMetronome();
    const onCountInComplete = vi.fn();

    metronome.start({
      bpm: 120,
      countInBars: 0,
      continueAfterCountIn: true,
      onCountInComplete,
    });

    advance(ctx, 2);
    metronome.stop();

    expect(onCountInComplete).not.toHaveBeenCalled();
    expect(ctx.createdOscillators.length).toBeGreaterThan(0);
  });

  it('produces two bars of count-in when requested', () => {
    const metronome = makeMetronome();
    metronome.start({
      bpm: 240,
      countInBars: 2,
      continueAfterCountIn: false,
    });

    advance(ctx, 3);
    // 2 bars * 4 beats = 8 count-in clicks.
    expect(ctx.createdOscillators).toHaveLength(8);
  });

  it('resumes a suspended AudioContext on start', () => {
    ctx.state = 'suspended';
    const resumeSpy = vi.spyOn(ctx, 'resume');
    const metronome = makeMetronome();

    metronome.start({ bpm: 120, continueAfterCountIn: true });
    expect(resumeSpy).toHaveBeenCalled();

    metronome.stop();
  });

  it('stops scheduling and clears timers on stop', () => {
    const metronome = makeMetronome();
    metronome.start({ bpm: 120, continueAfterCountIn: true });

    advance(ctx, 1);
    const countAfterFirstRun = ctx.createdOscillators.length;
    expect(countAfterFirstRun).toBeGreaterThan(0);

    metronome.stop();
    advance(ctx, 2);
    // No new clicks scheduled once stopped.
    expect(ctx.createdOscillators.length).toBe(countAfterFirstRun);
  });
});
