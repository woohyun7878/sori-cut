/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

import { crossCorrelate, parseCorrelationRequest } from './autoSyncCore';

function postError(error: unknown): void {
  self.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : 'Unknown auto-sync worker error',
  });
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  try {
    const message = parseCorrelationRequest(event.data);
    const result = crossCorrelate(message.reference, message.target, message.maxLagSamples);
    self.postMessage({ type: 'result', ...result });
  } catch (error) {
    postError(error);
  }
});

self.addEventListener('messageerror', () => {
  postError(new Error('Auto-sync worker could not deserialize its request'));
});
