/**
 * Pure signal analysis for auto-sync.
 *
 * This module contains no DOM, Worker, or AudioContext references so it can be
 * imported by the main thread, the auto-sync worker, and unit tests.
 */

export const AUTO_SYNC_ANALYSIS_SAMPLE_RATE = 8000;
export const AUTO_SYNC_MAX_LAG_SECONDS = 10;
export const AUTO_SYNC_MIN_DURATION_SECONDS = 1;
export const AUTO_SYNC_MAX_DURATION_SECONDS = 5 * 60;
export const AUTO_SYNC_ENVELOPE_RATE = 50;

export const AUTO_SYNC_FRAME_SIZE = AUTO_SYNC_ANALYSIS_SAMPLE_RATE / AUTO_SYNC_ENVELOPE_RATE;
export const AUTO_SYNC_MAX_ANALYSIS_SAMPLES =
  AUTO_SYNC_ANALYSIS_SAMPLE_RATE * AUTO_SYNC_MAX_DURATION_SECONDS;
export const AUTO_SYNC_MIN_ANALYSIS_SAMPLES =
  AUTO_SYNC_ANALYSIS_SAMPLE_RATE * AUTO_SYNC_MIN_DURATION_SECONDS;
export const AUTO_SYNC_MAX_LAG_SAMPLES = AUTO_SYNC_ANALYSIS_SAMPLE_RATE * AUTO_SYNC_MAX_LAG_SECONDS;
export const AUTO_SYNC_MAX_ENVELOPE_SAMPLES =
  AUTO_SYNC_ENVELOPE_RATE * AUTO_SYNC_MAX_DURATION_SECONDS;
export const AUTO_SYNC_MAX_CORRELATION_TERMS =
  (2 * AUTO_SYNC_ENVELOPE_RATE * AUTO_SYNC_MAX_LAG_SECONDS + 1) * AUTO_SYNC_MAX_ENVELOPE_SAMPLES;

const MIN_OVERLAP_FRAMES = AUTO_SYNC_ENVELOPE_RATE / 2;
const NEAR_SILENCE_RMS = 1e-5;
const SCORE_EPSILON = 1e-12;
const PEAK_EXCLUSION_FRAMES = 2;
const DISTINCT_PEAK_MARGIN = 0.25;

export interface CrossCorrelationResult {
  /**
   * Target timeline placement in 8 kHz analysis samples, quantized to 20 ms.
   * Positive delays the target; negative advances it within the source.
   */
  lagSamples: number;
  /** Overlap-weighted, normalized correlation confidence (0-1). */
  confidence: number;
}

export interface CorrelationDimensions {
  referenceEnvelopeSamples: number;
  targetEnvelopeSamples: number;
  maxLagEnvelopeSamples: number;
  candidateLags: number;
  /** Upper bound on dot-product terms evaluated by crossCorrelate. */
  maximumCorrelationTerms: number;
}

export interface CorrelationRequest {
  type: 'correlate';
  reference: Float32Array;
  target: Float32Array;
  maxLagSamples: number;
}

function assertValidLength(name: string, length: number): void {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error(`${name} must contain at least one sample`);
  }
  if (length < AUTO_SYNC_MIN_ANALYSIS_SAMPLES) {
    throw new Error(
      `${name} must be at least ${AUTO_SYNC_MIN_DURATION_SECONDS} second long for auto-sync`,
    );
  }
  if (length > AUTO_SYNC_MAX_ANALYSIS_SAMPLES) {
    throw new Error(
      `${name} exceeds the ${AUTO_SYNC_MAX_DURATION_SECONDS / 60}-minute auto-sync analysis limit`,
    );
  }
}

function assertValidMaxLag(maxLagSamples: number): void {
  if (!Number.isSafeInteger(maxLagSamples) || maxLagSamples < 0) {
    throw new Error('Auto-sync maximum lag must be a non-negative integer');
  }
  if (maxLagSamples > AUTO_SYNC_MAX_LAG_SAMPLES) {
    throw new Error(`Auto-sync maximum lag cannot exceed ${AUTO_SYNC_MAX_LAG_SECONDS} seconds`);
  }
}

/**
 * Describe the bounded work performed by crossCorrelate without running it.
 */
export function getCorrelationDimensions(
  referenceLength: number,
  targetLength: number,
  maxLagSamples: number,
): CorrelationDimensions {
  assertValidLength('Reference signal', referenceLength);
  assertValidLength('Target signal', targetLength);
  assertValidMaxLag(maxLagSamples);

  const referenceEnvelopeSamples = Math.ceil(referenceLength / AUTO_SYNC_FRAME_SIZE);
  const targetEnvelopeSamples = Math.ceil(targetLength / AUTO_SYNC_FRAME_SIZE);
  const maxLagEnvelopeSamples = Math.floor(maxLagSamples / AUTO_SYNC_FRAME_SIZE);
  const minLag = -Math.min(maxLagEnvelopeSamples, targetEnvelopeSamples - 1);
  const maxLag = Math.min(maxLagEnvelopeSamples, referenceEnvelopeSamples - 1);
  const candidateLags = maxLag - minLag + 1;
  const maximumCorrelationTerms =
    candidateLags * Math.min(referenceEnvelopeSamples, targetEnvelopeSamples);

  if (
    referenceEnvelopeSamples > AUTO_SYNC_MAX_ENVELOPE_SAMPLES ||
    targetEnvelopeSamples > AUTO_SYNC_MAX_ENVELOPE_SAMPLES ||
    maximumCorrelationTerms > AUTO_SYNC_MAX_CORRELATION_TERMS
  ) {
    throw new Error('Auto-sync correlation exceeds its bounded analysis budget');
  }

  return {
    referenceEnvelopeSamples,
    targetEnvelopeSamples,
    maxLagEnvelopeSamples,
    candidateLags,
    maximumCorrelationTerms,
  };
}

export function parseCorrelationRequest(value: unknown): CorrelationRequest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid auto-sync worker payload');
  }

  const message = value as Record<string, unknown>;
  if (message.type !== 'correlate') {
    throw new Error('Unsupported auto-sync worker message type');
  }
  if (!(message.reference instanceof Float32Array) || !(message.target instanceof Float32Array)) {
    throw new Error('Auto-sync worker signals must be Float32Array values');
  }
  if (typeof message.maxLagSamples !== 'number' || !Number.isSafeInteger(message.maxLagSamples)) {
    throw new Error('Auto-sync worker maximum lag must be an integer');
  }

  getCorrelationDimensions(message.reference.length, message.target.length, message.maxLagSamples);

  return {
    type: 'correlate',
    reference: message.reference,
    target: message.target,
    maxLagSamples: message.maxLagSamples,
  };
}

/**
 * Build a 50 Hz short-time RMS envelope. Removing each frame's mean rejects DC
 * bias before measuring energy; normalized correlation later rejects level
 * differences between recordings.
 */
function createEnergyEnvelope(signal: Float32Array): Float64Array {
  const frameCount = Math.ceil(signal.length / AUTO_SYNC_FRAME_SIZE);
  const envelope = new Float64Array(frameCount);

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * AUTO_SYNC_FRAME_SIZE;
    const end = Math.min(start + AUTO_SYNC_FRAME_SIZE, signal.length);
    const count = end - start;
    let sum = 0;
    let sumSquares = 0;

    for (let i = start; i < end; i++) {
      const sample = signal[i];
      if (!Number.isFinite(sample)) {
        throw new Error('Auto-sync signals must contain only finite samples');
      }
      sum += sample;
      sumSquares += sample * sample;
    }

    const mean = sum / count;
    const variance = Math.max(0, sumSquares / count - mean * mean);
    envelope[frame] = Math.sqrt(variance);
  }

  return envelope;
}

function createPrefixSums(values: Float64Array): {
  sums: Float64Array;
  squares: Float64Array;
} {
  const sums = new Float64Array(values.length + 1);
  const squares = new Float64Array(values.length + 1);

  for (let i = 0; i < values.length; i++) {
    sums[i + 1] = sums[i] + values[i];
    squares[i + 1] = squares[i] + values[i] * values[i];
  }

  return { sums, squares };
}

function rangeSum(prefix: Float64Array, start: number, length: number): number {
  return prefix[start + length] - prefix[start];
}

/**
 * Correlate two 8 kHz mono signals over a bounded lag range.
 *
 * Work is O((2 * maxLagSeconds * 50 + 1) * durationSeconds * 50), capped at
 * AUTO_SYNC_MAX_CORRELATION_TERMS (about 15 million terms). Lag resolution is
 * one 20 ms envelope frame. Every lag uses overlap-local Pearson correlation,
 * weighted by the fraction of the shorter signal that overlaps.
 */
export function crossCorrelate(
  reference: Float32Array,
  target: Float32Array,
  maxLagSamples: number,
): CrossCorrelationResult {
  const dimensions = getCorrelationDimensions(reference.length, target.length, maxLagSamples);
  const referenceEnvelope = createEnergyEnvelope(reference);
  const targetEnvelope = createEnergyEnvelope(target);

  let referencePeak = 0;
  for (const value of referenceEnvelope) {
    referencePeak = Math.max(referencePeak, value);
  }
  let targetPeak = 0;
  for (const value of targetEnvelope) {
    targetPeak = Math.max(targetPeak, value);
  }
  if (referencePeak <= NEAR_SILENCE_RMS || targetPeak <= NEAR_SILENCE_RMS) {
    return { lagSamples: 0, confidence: 0 };
  }

  const referencePrefix = createPrefixSums(referenceEnvelope);
  const targetPrefix = createPrefixSums(targetEnvelope);
  const shorterLength = Math.min(referenceEnvelope.length, targetEnvelope.length);
  const minimumOverlap = Math.min(MIN_OVERLAP_FRAMES, Math.max(1, Math.floor(shorterLength / 2)));
  const minLag = -Math.min(dimensions.maxLagEnvelopeSamples, targetEnvelope.length - 1);
  const maxLag = Math.min(dimensions.maxLagEnvelopeSamples, referenceEnvelope.length - 1);

  let bestScore = 0;
  let bestLag = 0;
  const scores = new Float64Array(maxLag - minLag + 1);

  for (let lag = minLag; lag <= maxLag; lag++) {
    const referenceStart = Math.max(0, lag);
    const targetStart = Math.max(0, -lag);
    const overlap = Math.min(
      referenceEnvelope.length - referenceStart,
      targetEnvelope.length - targetStart,
    );
    if (overlap < minimumOverlap) {
      continue;
    }

    const referenceSum = rangeSum(referencePrefix.sums, referenceStart, overlap);
    const targetSum = rangeSum(targetPrefix.sums, targetStart, overlap);
    const referenceVariance =
      rangeSum(referencePrefix.squares, referenceStart, overlap) -
      (referenceSum * referenceSum) / overlap;
    const targetVariance =
      rangeSum(targetPrefix.squares, targetStart, overlap) - (targetSum * targetSum) / overlap;
    if (referenceVariance <= SCORE_EPSILON || targetVariance <= SCORE_EPSILON) {
      continue;
    }

    let dotProduct = 0;
    for (let i = 0; i < overlap; i++) {
      dotProduct += referenceEnvelope[referenceStart + i] * targetEnvelope[targetStart + i];
    }

    const covariance = dotProduct - (referenceSum * targetSum) / overlap;
    const correlation = Math.max(
      -1,
      Math.min(1, covariance / Math.sqrt(referenceVariance * targetVariance)),
    );
    const overlapWeight = Math.sqrt(overlap / shorterLength);
    const score = Math.max(0, correlation * overlapWeight);
    scores[lag - minLag] = score;

    if (
      score > bestScore + SCORE_EPSILON ||
      (Math.abs(score - bestScore) <= SCORE_EPSILON && Math.abs(lag) < Math.abs(bestLag))
    ) {
      bestScore = score;
      bestLag = lag;
    }
  }

  let secondBestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (Math.abs(lag - bestLag) > PEAK_EXCLUSION_FRAMES) {
      secondBestScore = Math.max(secondBestScore, scores[lag - minLag]);
    }
  }
  const distinctiveness = Math.min(
    1,
    Math.max(0, (bestScore - secondBestScore) / DISTINCT_PEAK_MARGIN),
  );

  return {
    lagSamples: bestLag * AUTO_SYNC_FRAME_SIZE,
    confidence: Math.max(0, Math.min(1, bestScore * distinctiveness)),
  };
}
