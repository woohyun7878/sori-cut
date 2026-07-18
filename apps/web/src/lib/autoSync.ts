/**
 * Auto-sync: cross-correlate a user's recording against the backing track
 * to determine the optimal time offset for alignment.
 *
 * Uses OfflineAudioContext for decoding and downsampling. The CPU-bound
 * cross-correlation runs in a Web Worker so it never blocks the main thread.
 */

import type { CrossCorrelationResult } from './autoSyncCore';

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
 * Run the cross-correlation in a Web Worker so the CPU-bound work stays off
 * the main thread. The two signal buffers are transferred (zero-copy) to the
 * worker, so callers must not reuse them afterward.
 */
function correlateInWorker(
  reference: Float32Array,
  target: Float32Array,
  maxLagSamples: number,
): Promise<CrossCorrelationResult> {
  const worker = new Worker(new URL('./autoSync.worker.ts', import.meta.url), {
    type: 'module',
  });

  return new Promise<CrossCorrelationResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;

      if (msg?.type === 'result') {
        resolve({ lagSamples: msg.lagSamples, confidence: msg.confidence });
      } else if (msg?.type === 'error') {
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (err) => {
      reject(new Error(`Auto-sync worker error: ${err.message}`));
    };

    // Transfer the underlying buffers for zero-copy handoff.
    worker.postMessage(
      { type: 'correlate', reference, target, maxLagSamples },
      [reference.buffer, target.buffer] as unknown as Transferable[],
    );
  }).finally(() => {
    worker.terminate();
  });
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
  const { lagSamples, confidence } = await correlateInWorker(
    refSamples,
    tarSamples,
    maxLagSamples,
  );

  // A negative lag means the target should be placed later on the timeline.
  const offsetSeconds = -lagSamples / ANALYSIS_SAMPLE_RATE;

  return { offsetSeconds, confidence };
}
