/**
 * Web Worker for auto-sync cross-correlation.
 *
 * The cross-correlation is a CPU-bound O(lags × N) computation that would
 * freeze the UI for seconds if run on the main thread. This worker runs it
 * off the main thread so the interface stays responsive while auto-sync is
 * analyzing.
 *
 * Communication protocol:
 *   Main → Worker: { type: 'correlate', reference: Float32Array, target: Float32Array, maxLagSamples: number }
 *   Worker → Main: { type: 'result', lagSamples: number, confidence: number }
 *   Worker → Main: { type: 'error', message: string }
 */

/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

import { crossCorrelate } from './autoSyncCore';

interface CorrelateMessage {
  type: 'correlate';
  reference: Float32Array;
  target: Float32Array;
  maxLagSamples: number;
}

self.addEventListener('message', (event: MessageEvent<CorrelateMessage>) => {
  const msg = event.data;

  if (msg.type !== 'correlate') {
    return;
  }

  try {
    const { lagSamples, confidence } = crossCorrelate(
      msg.reference,
      msg.target,
      msg.maxLagSamples,
    );
    self.postMessage({ type: 'result', lagSamples, confidence });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : 'Unknown correlation error',
    });
  }
});
