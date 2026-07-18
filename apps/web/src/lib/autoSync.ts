/**
 * Auto-sync: cross-correlate a user's recording against the backing track
 * to determine the optimal time offset for alignment.
 *
 * Uses OfflineAudioContext for decoding and downsampling.
 */

/** Downsample rate used for correlation to keep computation fast. */
const ANALYSIS_SAMPLE_RATE = 8000;

/** Maximum lag to search in seconds (limits computation). */
const MAX_LAG_SECONDS = 10;

export interface AutoSyncResult {
  /** Optimal offset in seconds (positive = recording should start later on timeline). */
  offsetSeconds: number;
  /** Normalized correlation confidence (0–1). */
  confidence: number;
}

/**
 * Decode an audio source URL into a mono Float32Array at the analysis sample rate
 * using OfflineAudioContext.
 */
async function decodeToMono(url: string): Promise<Float32Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();

  // Use a temporary AudioContext solely for decoding.
  const tempCtx = new AudioContext({ sampleRate: ANALYSIS_SAMPLE_RATE });
  let decoded: AudioBuffer;
  try {
    decoded = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await tempCtx.close();
  }

  // Re-render as mono at the analysis rate via OfflineAudioContext.
  const length = Math.ceil(decoded.duration * ANALYSIS_SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(1, length, ANALYSIS_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Compute cross-correlation between two signals over a bounded lag range.
 * Returns the lag (in samples) that maximizes the normalized correlation.
 */
function crossCorrelate(
  reference: Float32Array,
  target: Float32Array,
  maxLagSamples: number,
): { lagSamples: number; confidence: number } {
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

/**
 * Automatically determine the time offset between a reference (backing) track
 * and a target (user recording) track using cross-correlation.
 *
 * @param referenceUrl - URL of the backing/reference audio (e.g. video audio or original track)
 * @param targetUrl - URL of the user's recording to align
 * @returns The computed offset and confidence.
 */
export async function computeAutoSyncOffset(
  referenceUrl: string,
  targetUrl: string,
): Promise<AutoSyncResult> {
  const [refSamples, tarSamples] = await Promise.all([
    decodeToMono(referenceUrl),
    decodeToMono(targetUrl),
  ]);

  const maxLagSamples = Math.ceil(MAX_LAG_SECONDS * ANALYSIS_SAMPLE_RATE);
  const { lagSamples, confidence } = crossCorrelate(refSamples, tarSamples, maxLagSamples);

  // A negative lag means the target should be placed later on the timeline.
  const offsetSeconds = -lagSamples / ANALYSIS_SAMPLE_RATE;

  return { offsetSeconds, confidence };
}
