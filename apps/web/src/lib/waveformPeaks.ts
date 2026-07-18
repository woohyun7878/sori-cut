/**
 * Waveform peak extraction — decodes audio from a URL and computes
 * downsampled peak amplitudes for lightweight waveform rendering.
 */

/** Number of peaks per second of audio (resolution). */
const PEAKS_PER_SECOND = 100;

export interface PeakData {
  /** Normalized peak values in [0, 1]. */
  peaks: Float32Array;
  /** Duration of the source audio in seconds. */
  duration: number;
  /** How many peaks represent one second of audio. */
  peaksPerSecond: number;
}

const cache = new Map<string, PeakData>();
const inflight = new Map<string, Promise<PeakData>>();

let offlineCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!offlineCtx) {
    offlineCtx = new AudioContext();
  }
  return offlineCtx;
}

/**
 * Extract peak amplitude data from an audio URL.
 * Results are cached per URL. Concurrent requests for the same URL are deduped.
 */
export async function extractPeaks(sourceUrl: string): Promise<PeakData> {
  if (!sourceUrl) {
    return { peaks: new Float32Array(0), duration: 0, peaksPerSecond: PEAKS_PER_SECOND };
  }

  const cached = cache.get(sourceUrl);
  if (cached) return cached;

  const existing = inflight.get(sourceUrl);
  if (existing) return existing;

  const promise = doExtract(sourceUrl);
  inflight.set(sourceUrl, promise);

  try {
    const result = await promise;
    cache.set(sourceUrl, result);
    return result;
  } finally {
    inflight.delete(sourceUrl);
  }
}

async function doExtract(sourceUrl: string): Promise<PeakData> {
  const response = await fetch(sourceUrl);
  const arrayBuffer = await response.arrayBuffer();
  const ctx = getAudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  const duration = audioBuffer.duration;
  const totalPeaks = Math.ceil(duration * PEAKS_PER_SECOND);
  const peaks = new Float32Array(totalPeaks);

  // Mix all channels to mono peaks
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const samplesPerPeak = sampleRate / PEAKS_PER_SECOND;

  for (let ch = 0; ch < channelCount; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < totalPeaks; i++) {
      const start = Math.floor(i * samplesPerPeak);
      const end = Math.min(Math.floor((i + 1) * samplesPerPeak), channelData.length);
      let max = 0;
      for (let s = start; s < end; s++) {
        const abs = Math.abs(channelData[s]);
        if (abs > max) max = abs;
      }
      // Take maximum across channels
      if (max > peaks[i]) {
        peaks[i] = max;
      }
    }
  }

  // Normalize peaks to [0, 1]
  let globalMax = 0;
  for (let i = 0; i < totalPeaks; i++) {
    if (peaks[i] > globalMax) globalMax = peaks[i];
  }
  if (globalMax > 0) {
    for (let i = 0; i < totalPeaks; i++) {
      peaks[i] /= globalMax;
    }
  }

  return { peaks, duration, peaksPerSecond: PEAKS_PER_SECOND };
}
