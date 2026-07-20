/**
 * Web Audio metronome with count-in for the recording studio.
 *
 * Clicks are produced by short scheduled oscillator + gain envelopes and are
 * queued using a lookahead scheduler (a `setInterval` "clock" that repeatedly
 * schedules clicks a little way into the future against `AudioContext.currentTime`).
 * This keeps timing rock-solid even when the main thread is busy — clicks are
 * never scheduled with a `setTimeout` per beat.
 *
 * See Chris Wilson, "A Tale of Two Clocks" for the pattern.
 */

export interface TimeSignature {
  /** Beats per bar (numerator), e.g. 4 in 4/4. */
  beatsPerBar: number;
  /** Note value that gets one beat (denominator), e.g. 4 in 4/4. */
  beatUnit: number;
}

export const DEFAULT_TIME_SIGNATURE: TimeSignature = { beatsPerBar: 4, beatUnit: 4 };

export const DEFAULT_BPM = 100;
export const MIN_BPM = 30;
export const MAX_BPM = 300;

/** How often (ms) the scheduler "clock" wakes up to queue upcoming clicks. */
export const SCHEDULER_LOOKAHEAD_MS = 25;
/** How far ahead (seconds) each wake-up schedules clicks. */
export const SCHEDULE_AHEAD_TIME = 0.1;
/** Small pre-roll (seconds) before the very first click so it is not clipped. */
export const SCHEDULE_START_OFFSET = 0.05;

const ACCENT_FREQUENCY = 1500;
const BEAT_FREQUENCY = 900;
/** Length (seconds) of a single click's amplitude envelope. */
const CLICK_DURATION = 0.05;
const MIN_GAIN = 0.0001;

/** Information about a single scheduled beat, surfaced to the UI. */
export interface BeatEvent {
  /** Absolute beat index since start (count-in included), 0-based. */
  index: number;
  /** Position within the current bar, 0-based. */
  beatInBar: number;
  /** True on the accented downbeat (beat 1 of the bar). */
  accent: boolean;
  /** True while this beat belongs to the count-in phase. */
  countIn: boolean;
  /** `AudioContext` time (seconds) at which the click sounds. */
  time: number;
}

export interface MetronomeStartOptions {
  bpm?: number;
  timeSignature?: TimeSignature;
  /** Number of full bars to count in before the main downbeat. 0 = no count-in. */
  countInBars?: number;
  /** Keep clicking after the count-in completes (the actual metronome). */
  continueAfterCountIn?: boolean;
  /** Master volume, 0–1. */
  volume?: number;
  /** Fired (via the scheduler clock) as each beat sounds. */
  onBeat?: (beat: BeatEvent) => void;
  /** Fired once when the count-in finishes and the main downbeat is due. */
  onCountInComplete?: () => void;
  /** Fired when the metronome stops (manually or after a count-in-only run). */
  onStop?: () => void;
}

export interface MetronomeInit {
  /** Inject an AudioContext (used by tests). Created lazily otherwise. */
  context?: AudioContext;
  lookaheadMs?: number;
  scheduleAheadTime?: number;
}

/** Clamp/round a BPM value into the supported range. */
export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) {
    return DEFAULT_BPM;
  }
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
}

/**
 * Seconds between clicks for a BPM. BPM is treated as quarter-note based, so the
 * interval scales with the time-signature denominator (e.g. 6/8 clicks eighth notes).
 */
export function beatIntervalSeconds(
  bpm: number,
  timeSignature: TimeSignature = DEFAULT_TIME_SIGNATURE,
): number {
  const safeBpm = clampBpm(bpm);
  const unit = timeSignature.beatUnit > 0 ? timeSignature.beatUnit : 4;
  return (60 / safeBpm) * (4 / unit);
}

/** Position of a beat within its bar (0-based), tolerant of negative indices. */
export function beatInBar(index: number, beatsPerBar: number): number {
  const n = beatsPerBar > 0 ? beatsPerBar : 1;
  return ((index % n) + n) % n;
}

/** Whether a beat index is the accented downbeat (beat 1 of the bar). */
export function isAccent(index: number, beatsPerBar: number): boolean {
  return beatInBar(index, beatsPerBar) === 0;
}

/** Total number of count-in clicks for a number of bars in a time signature. */
export function countInBeats(
  bars: number,
  timeSignature: TimeSignature = DEFAULT_TIME_SIGNATURE,
): number {
  const safeBars = Number.isFinite(bars) ? Math.max(0, Math.floor(bars)) : 0;
  return safeBars * timeSignature.beatsPerBar;
}

/** Render a time signature as "n/d" for display. */
export function formatTimeSignature(timeSignature: TimeSignature): string {
  return `${timeSignature.beatsPerBar}/${timeSignature.beatUnit}`;
}

/** Parse an "n/d" string into a time signature, falling back to 4/4. */
export function parseTimeSignature(value: string): TimeSignature {
  const [rawTop, rawBottom] = value.split('/');
  const top = Number.parseInt(rawTop, 10);
  const bottom = Number.parseInt(rawBottom, 10);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || top <= 0 || bottom <= 0) {
    return DEFAULT_TIME_SIGNATURE;
  }
  return { beatsPerBar: top, beatUnit: bottom };
}

export class Metronome {
  private context: AudioContext | null;
  private readonly lookaheadMs: number;
  private readonly scheduleAheadTime: number;

  private masterGain: GainNode | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;

  private bpm = DEFAULT_BPM;
  private timeSignature: TimeSignature = DEFAULT_TIME_SIGNATURE;
  private totalCountInBeats = 0;
  private continueAfterCountIn = true;
  private volume = 0.8;

  private nextBeatIndex = 0;
  private nextBeatTime = 0;
  private downbeatTime: number | null = null;
  private countInReported = false;
  private schedulingComplete = false;
  private running = false;

  private visualQueue: BeatEvent[] = [];
  private callbacks: Pick<MetronomeStartOptions, 'onBeat' | 'onCountInComplete' | 'onStop'> = {};

  constructor(init: MetronomeInit = {}) {
    this.context = init.context ?? null;
    this.lookaheadMs = init.lookaheadMs ?? SCHEDULER_LOOKAHEAD_MS;
    this.scheduleAheadTime = init.scheduleAheadTime ?? SCHEDULE_AHEAD_TIME;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Begin the metronome (and count-in, if any). Restarts if already running. */
  start(options: MetronomeStartOptions = {}): void {
    if (this.running) {
      this.stop();
    }

    const ctx = this.ensureContext();
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      void ctx.resume();
    }

    this.bpm = clampBpm(options.bpm ?? this.bpm);
    this.timeSignature = options.timeSignature ?? this.timeSignature;
    this.continueAfterCountIn = options.continueAfterCountIn ?? true;
    this.volume = options.volume ?? this.volume;
    this.totalCountInBeats = countInBeats(options.countInBars ?? 0, this.timeSignature);
    this.callbacks = {
      onBeat: options.onBeat,
      onCountInComplete: options.onCountInComplete,
      onStop: options.onStop,
    };

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.volume;
    this.masterGain.connect(ctx.destination);

    this.nextBeatIndex = 0;
    this.nextBeatTime = ctx.currentTime + SCHEDULE_START_OFFSET;
    this.downbeatTime = null;
    this.countInReported = false;
    this.schedulingComplete = false;
    this.visualQueue = [];
    this.running = true;

    // Schedule immediately, then keep the scheduler clock running.
    this.tick();
    this.timerId = setInterval(() => this.tick(), this.lookaheadMs);
  }

  /** Stop the metronome and fire `onStop`. Safe to call when already stopped. */
  stop(): void {
    if (!this.running) {
      return;
    }
    const onStop = this.callbacks.onStop;
    this.teardown();
    onStop?.();
  }

  /** Stop and release the underlying AudioContext. */
  destroy(): void {
    this.teardown();
    this.callbacks = {};
    const ctx = this.context;
    this.context = null;
    if (ctx && typeof ctx.close === 'function' && ctx.state !== 'closed') {
      void ctx.close();
    }
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
    }
    return this.context;
  }

  /** Scheduler clock: queue upcoming clicks, then flush due UI callbacks. */
  private tick(): void {
    const ctx = this.context;
    if (!this.running || !ctx || !this.masterGain) {
      return;
    }

    const interval = beatIntervalSeconds(this.bpm, this.timeSignature);
    const horizon = ctx.currentTime + this.scheduleAheadTime;

    while (!this.schedulingComplete && this.nextBeatTime < horizon) {
      const index = this.nextBeatIndex;
      const positionInBar = beatInBar(index, this.timeSignature.beatsPerBar);
      const accent = positionInBar === 0;
      const isCountInBeat = index < this.totalCountInBeats;

      if (index === this.totalCountInBeats) {
        // First beat of the main phase — where recording should begin.
        this.downbeatTime = this.nextBeatTime;
        if (!this.continueAfterCountIn) {
          // Count-in only: mark the downbeat time but do not sound/continue it.
          this.schedulingComplete = true;
          break;
        }
      }

      this.scheduleClick(accent, this.nextBeatTime);
      this.visualQueue.push({
        index,
        beatInBar: positionInBar,
        accent,
        countIn: isCountInBeat,
        time: this.nextBeatTime,
      });

      this.nextBeatTime += interval;
      this.nextBeatIndex += 1;
    }

    this.drain();
  }

  /** Fire UI callbacks for beats/events that have become due. */
  private drain(): void {
    const ctx = this.context;
    if (!ctx) {
      return;
    }
    const now = ctx.currentTime;

    if (
      this.totalCountInBeats > 0 &&
      !this.countInReported &&
      this.downbeatTime !== null &&
      now >= this.downbeatTime
    ) {
      this.countInReported = true;
      this.callbacks.onCountInComplete?.();
    }

    while (this.visualQueue.length > 0 && this.visualQueue[0].time <= now) {
      const beat = this.visualQueue.shift() as BeatEvent;
      this.callbacks.onBeat?.(beat);
    }

    // Count-in-only run: once the downbeat is reached, stop on our own.
    if (
      this.schedulingComplete &&
      this.visualQueue.length === 0 &&
      this.downbeatTime !== null &&
      now >= this.downbeatTime
    ) {
      const onStop = this.callbacks.onStop;
      this.teardown();
      onStop?.();
    }
  }

  private scheduleClick(accent: boolean, time: number): void {
    const ctx = this.context;
    if (!ctx || !this.masterGain) {
      return;
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.value = accent ? ACCENT_FREQUENCY : BEAT_FREQUENCY;

    const peak = accent ? 1 : 0.7;
    // Percussive click: fast attack, short exponential decay.
    gain.gain.setValueAtTime(MIN_GAIN, time);
    gain.gain.exponentialRampToValueAtTime(peak, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, time + CLICK_DURATION);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(time);
    osc.stop(time + CLICK_DURATION + 0.02);
  }

  private teardown(): void {
    this.running = false;
    this.schedulingComplete = true;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch {
        // Already disconnected.
      }
      this.masterGain = null;
    }
    this.visualQueue = [];
  }
}
