/**
 * Pure cross-correlation math for auto-sync.
 *
 * This module contains no DOM/Worker/AudioContext references so it can be
 * imported by both the main thread, the auto-sync Web Worker, and unit tests.
 */

export interface CrossCorrelationResult {
  /** Lag (in samples) that maximizes the normalized correlation. */
  lagSamples: number;
  /** Normalized correlation confidence (0–1). */
  confidence: number;
}

/**
 * Compute cross-correlation between two signals over a bounded lag range.
 * Returns the lag (in samples) that maximizes the normalized correlation.
 *
 * This is a CPU-bound O(lags × N) computation. It is intentionally kept as a
 * plain function so the heavy work can run inside a Web Worker (off the main
 * thread) while remaining directly unit-testable.
 */
export function crossCorrelate(
  reference: Float32Array,
  target: Float32Array,
  maxLagSamples: number,
): CrossCorrelationResult {
  const refLen = reference.length;
  const tarLen = target.length;

  // Compute energy for normalization.
  let refEnergy = 0;
  for (let i = 0; i < refLen; i++) {
    refEnergy += reference[i] * reference[i];
  }

  let tarEnergy = 0;
  for (let i = 0; i < tarLen; i++) {
    tarEnergy += target[i] * target[i];
  }

  const normFactor = Math.sqrt(refEnergy * tarEnergy);
  if (normFactor === 0) {
    return { lagSamples: 0, confidence: 0 };
  }

  let bestCorrelation = -Infinity;
  let bestLag = 0;

  // Search both negative and positive lags.
  const minLag = -Math.min(maxLagSamples, tarLen - 1);
  const maxLag = Math.min(maxLagSamples, refLen - 1);

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const startRef = Math.max(0, lag);
    const startTar = Math.max(0, -lag);
    const end = Math.min(refLen - lag, tarLen);

    for (let i = startTar, j = startRef; i < end && j < refLen; i++, j++) {
      sum += reference[j] * target[i];
    }

    if (sum > bestCorrelation) {
      bestCorrelation = sum;
      bestLag = lag;
    }
  }

  const confidence = Math.max(0, Math.min(1, bestCorrelation / normFactor));
  return { lagSamples: bestLag, confidence };
}
