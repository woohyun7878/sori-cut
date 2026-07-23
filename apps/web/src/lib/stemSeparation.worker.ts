/**
 * Web Worker for stem separation using ONNX Runtime.
 *
 * Communication protocol:
 *   Main → Worker: { type: 'separate', channelData: Float32Array[], sampleRate: number, modelUrl: string }
 *   Worker → Main: { type: 'progress', progress: number }
 *   Worker → Main: { type: 'result', stems: { name, label, channelData: Float32Array[] }[] }
 *   Worker → Main: { type: 'error', message: string }
 */

/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

import * as ort from 'onnxruntime-web';
import { computeSTFT, computeISTFT } from './stemSeparationUtils';

// Configure ONNX Runtime for WebAssembly backend
ort.env.wasm.numThreads = 1;

/** Stem definitions matching the model output order. */
const STEM_DEFS = [
  { name: 'vocals', label: 'Vocals' },
  { name: 'drums', label: 'Drums' },
  { name: 'bass', label: 'Bass' },
  { name: 'guitar', label: 'Guitar' },
] as const;

const FFT_SIZE = 2048;
const HOP_SIZE = 512;
const SEGMENT_SAMPLES = 441000; // ~10 seconds at 44.1kHz
const OVERLAP_SAMPLES = 44100; // 1 second overlap for crossfade

interface SeparateMessage {
  type: 'separate';
  channelData: Float32Array[];
  sampleRate: number;
  modelUrl: string;
}

type WorkerMessage = SeparateMessage;

let session: ort.InferenceSession | null = null;
let loadedModelUrl: string | null = null;

function postProgress(progress: number): void {
  self.postMessage({ type: 'progress', progress: Math.round(progress) });
}

function postError(message: string): void {
  self.postMessage({ type: 'error', message });
}

/**
 * Validate incoming message payload. Returns an error string or null if valid.
 */
function validatePayload(msg: unknown): string | null {
  if (msg === null || typeof msg !== 'object') {
    return 'Invalid message: expected an object.';
  }

  const m = msg as Record<string, unknown>;

  if (m.type !== 'separate') {
    return `Unknown message type: "${String(m.type)}".`;
  }

  if (!Array.isArray(m.channelData) || m.channelData.length === 0) {
    return 'Invalid payload: channelData must be a non-empty array.';
  }

  for (let i = 0; i < m.channelData.length; i++) {
    if (!(m.channelData[i] instanceof Float32Array)) {
      return `Invalid payload: channelData[${i}] is not a Float32Array.`;
    }
    if (m.channelData[i].length === 0) {
      return `Invalid payload: channelData[${i}] is empty.`;
    }
  }

  // All channels must have the same length
  const expectedLength = (m.channelData[0] as Float32Array).length;
  for (let i = 1; i < m.channelData.length; i++) {
    if ((m.channelData[i] as Float32Array).length !== expectedLength) {
      return `Invalid payload: channel lengths differ (ch0=${expectedLength}, ch${i}=${(m.channelData[i] as Float32Array).length}).`;
    }
  }

  if (typeof m.sampleRate !== 'number' || m.sampleRate <= 0 || !Number.isFinite(m.sampleRate)) {
    return `Invalid payload: sampleRate must be a positive finite number, got ${String(m.sampleRate)}.`;
  }

  if (typeof m.modelUrl !== 'string' || m.modelUrl.length === 0) {
    return 'Invalid payload: modelUrl must be a non-empty string.';
  }

  return null;
}

/**
 * Load or reuse the ONNX model session.
 */
async function getSession(modelUrl: string): Promise<ort.InferenceSession> {
  if (session && loadedModelUrl === modelUrl) {
    return session;
  }

  postProgress(2);

  try {
    session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    loadedModelUrl = modelUrl;
  } catch (err) {
    throw new Error(
      `[model-load] Failed to load ONNX model from "${modelUrl}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  postProgress(5);
  return session;
}

/**
 * Run separation model on a single segment's spectrogram.
 * Input: magnitude spectrogram [1, 1, numFrames, numBins]
 * Output: 4 masks [1, 4, numFrames, numBins]
 */
async function runModel(
  inferenceSession: ort.InferenceSession,
  magnitudeSegment: Float32Array,
  numFrames: number,
  numBins: number,
): Promise<Float32Array[]> {
  const inputTensor = new ort.Tensor('float32', magnitudeSegment, [1, 1, numFrames, numBins]);

  const inputName = inferenceSession.inputNames[0] ?? 'input';
  const feeds: Record<string, ort.Tensor> = { [inputName]: inputTensor };

  const results = await inferenceSession.run(feeds);
  const outputName = inferenceSession.outputNames[0] ?? 'output';
  const outputTensor = results[outputName];

  if (!outputTensor) {
    throw new Error('[inference] Model did not produce expected output tensor.');
  }

  const outputData = outputTensor.data as Float32Array;
  const numStems = 4;
  const segSize = numFrames * numBins;

  if (outputData.length < numStems * segSize) {
    throw new Error(
      `[inference] Output tensor size mismatch: expected >=${numStems * segSize}, got ${outputData.length}.`
    );
  }

  const masks: Float32Array[] = [];
  for (let s = 0; s < numStems; s++) {
    masks.push(outputData.slice(s * segSize, (s + 1) * segSize));
  }

  return masks;
}

/**
 * Spectral heuristic fallback when no ONNX model is available.
 */
function applySpectralHeuristic(
  _magnitude: Float32Array,
  _phase: Float32Array,
  numFrames: number,
  numBins: number,
): Float32Array[] {
  const masks: Float32Array[] = Array.from({ length: 4 }, () => new Float32Array(numFrames * numBins));

  const nyquist = numBins - 1;

  for (let frame = 0; frame < numFrames; frame++) {
    const frameOffset = frame * numBins;

    for (let bin = 0; bin < numBins; bin++) {
      const freq = bin / nyquist;

      let vocalMask = 0;
      if (freq > 0.01 && freq < 0.25) {
        vocalMask = Math.exp(-((freq - 0.08) ** 2) / (2 * 0.04 ** 2));
      }

      let drumMask = 0;
      if (freq < 0.015) {
        drumMask = 0.6 * Math.exp(-(freq ** 2) / (2 * 0.005 ** 2));
      }
      if (freq > 0.18) {
        drumMask += 0.7 * (1 - Math.exp(-((freq - 0.18) ** 2) / (2 * 0.1 ** 2)));
      }

      let bassMask = 0;
      if (freq < 0.03) {
        bassMask = Math.exp(-(freq ** 2) / (2 * 0.012 ** 2));
      }

      let guitarMask = 0;
      if (freq > 0.008 && freq < 0.15) {
        guitarMask = Math.exp(-((freq - 0.04) ** 2) / (2 * 0.03 ** 2));
      }

      const total = vocalMask + drumMask + bassMask + guitarMask + 1e-8;
      masks[0][frameOffset + bin] = vocalMask / total;
      masks[1][frameOffset + bin] = drumMask / total;
      masks[2][frameOffset + bin] = bassMask / total;
      masks[3][frameOffset + bin] = guitarMask / total;
    }
  }

  return masks;
}

/**
 * Separate a mono signal into 4 stems.
 */
async function separateChannel(
  samples: Float32Array,
  _sampleRate: number,
  inferenceSession: ort.InferenceSession | null,
  progressBase: number,
  progressScale: number,
): Promise<Float32Array[]> {
  const totalLength = samples.length;
  const numSegments = Math.ceil(totalLength / (SEGMENT_SAMPLES - OVERLAP_SAMPLES));
  const stemOutputs: Float32Array[] = Array.from({ length: 4 }, () => new Float32Array(totalLength));

  for (let seg = 0; seg < numSegments; seg++) {
    const start = seg * (SEGMENT_SAMPLES - OVERLAP_SAMPLES);
    const end = Math.min(start + SEGMENT_SAMPLES, totalLength);
    const segment = samples.slice(start, end);

    const { magnitude, phase, numFrames, numBins } = computeSTFT(segment, FFT_SIZE, HOP_SIZE);

    // Short segments that produce zero STFT frames get silence
    if (numFrames === 0) {
      const segProgress = progressBase + ((seg + 1) / numSegments) * progressScale;
      postProgress(segProgress);
      continue;
    }

    let masks: Float32Array[];
    if (inferenceSession) {
      try {
        masks = await runModel(inferenceSession, magnitude, numFrames, numBins);
      } catch {
        masks = applySpectralHeuristic(magnitude, phase, numFrames, numBins);
      }
    } else {
      masks = applySpectralHeuristic(magnitude, phase, numFrames, numBins);
    }

    for (let stemIdx = 0; stemIdx < 4; stemIdx++) {
      const maskedMag = new Float32Array(numFrames * numBins);
      for (let i = 0; i < maskedMag.length; i++) {
        maskedMag[i] = magnitude[i] * masks[stemIdx][i];
      }

      const stemSignal = computeISTFT(maskedMag, phase, numFrames, numBins, FFT_SIZE, HOP_SIZE, segment.length);

      for (let i = 0; i < stemSignal.length; i++) {
        const outIdx = start + i;
        if (outIdx >= totalLength) break;

        if (seg > 0 && i < OVERLAP_SAMPLES) {
          const fade = i / OVERLAP_SAMPLES;
          stemOutputs[stemIdx][outIdx] = stemOutputs[stemIdx][outIdx] * (1 - fade) + stemSignal[i] * fade;
        } else {
          stemOutputs[stemIdx][outIdx] = stemSignal[i];
        }
      }
    }

    const segProgress = progressBase + ((seg + 1) / numSegments) * progressScale;
    postProgress(segProgress);
  }

  return stemOutputs;
}

/**
 * Main separation entry point.
 */
async function handleSeparate(msg: SeparateMessage): Promise<void> {
  const { channelData, sampleRate, modelUrl } = msg;
  const numChannels = channelData.length;

  postProgress(0);

  // Try to load the ONNX model (non-fatal if unavailable)
  let inferenceSession: ort.InferenceSession | null = null;
  try {
    inferenceSession = await getSession(modelUrl);
  } catch {
    // Model not available — fall back to spectral heuristic
    postProgress(5);
  }

  // Process each channel
  const allStemChannels: Float32Array[][] = Array.from({ length: 4 }, () => []);

  for (let ch = 0; ch < numChannels; ch++) {
    const progressBase = 5 + (ch / numChannels) * 85;
    const progressScale = 85 / numChannels;

    const channelStems = await separateChannel(
      channelData[ch],
      sampleRate,
      inferenceSession,
      progressBase,
      progressScale,
    );

    for (let stemIdx = 0; stemIdx < 4; stemIdx++) {
      allStemChannels[stemIdx].push(channelStems[stemIdx]);
    }
  }

  postProgress(95);

  const stems = STEM_DEFS.map((def, idx) => ({
    name: def.name,
    label: def.label,
    channelData: allStemChannels[idx],
  }));

  postProgress(100);

  self.postMessage(
    { type: 'result', stems },
    { transfer: stems.flatMap(s => s.channelData).map(a => a.buffer) },
  );
}

self.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  // Validate payload before processing
  const validationError = validatePayload(msg);
  if (validationError) {
    postError(validationError);
    return;
  }

  handleSeparate(msg as SeparateMessage).catch((err) => {
    postError(err instanceof Error ? err.message : 'Unknown separation error');
  });
});
