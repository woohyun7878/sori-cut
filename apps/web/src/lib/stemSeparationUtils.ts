/**
 * Shared utilities for stem separation: STFT, ISTFT, and WAV encoding.
 */

/** Create a Hann window of the given size. */
export function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

/**
 * Compute Short-Time Fourier Transform.
 * Returns magnitude and phase as separate arrays for model processing.
 */
export function computeSTFT(
  samples: Float32Array,
  fftSize: number,
  hopSize: number,
): { magnitude: Float32Array; phase: Float32Array; numFrames: number; numBins: number } {
  const numBins = fftSize / 2 + 1;
  const numFrames = Math.floor((samples.length - fftSize) / hopSize) + 1;
  const window = hannWindow(fftSize);

  const magnitude = new Float32Array(numFrames * numBins);
  const phase = new Float32Array(numFrames * numBins);

  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);

  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * hopSize;

    for (let i = 0; i < fftSize; i++) {
      real[i] = (samples[offset + i] ?? 0) * window[i];
      imag[i] = 0;
    }

    fftInPlace(real, imag, fftSize);

    const frameOffset = frame * numBins;
    for (let bin = 0; bin < numBins; bin++) {
      const r = real[bin];
      const im = imag[bin];
      magnitude[frameOffset + bin] = Math.sqrt(r * r + im * im);
      phase[frameOffset + bin] = Math.atan2(im, r);
    }
  }

  return { magnitude, phase, numFrames, numBins };
}

/**
 * Compute Inverse STFT from magnitude and phase.
 */
export function computeISTFT(
  magnitude: Float32Array,
  phase: Float32Array,
  numFrames: number,
  numBins: number,
  fftSize: number,
  hopSize: number,
  outputLength: number,
): Float32Array {
  const window = hannWindow(fftSize);
  const output = new Float32Array(outputLength);
  const windowSum = new Float32Array(outputLength);

  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);

  for (let frame = 0; frame < numFrames; frame++) {
    const frameOffset = frame * numBins;

    for (let bin = 0; bin < numBins; bin++) {
      const mag = magnitude[frameOffset + bin];
      const ph = phase[frameOffset + bin];
      real[bin] = mag * Math.cos(ph);
      imag[bin] = mag * Math.sin(ph);
    }
    // Mirror for negative frequencies
    for (let bin = 1; bin < numBins - 1; bin++) {
      real[fftSize - bin] = real[bin];
      imag[fftSize - bin] = -imag[bin];
    }

    // Inverse FFT (conjugate → forward FFT → conjugate → scale)
    for (let i = 0; i < fftSize; i++) imag[i] = -imag[i];
    fftInPlace(real, imag, fftSize);
    const scale = 1 / fftSize;
    for (let i = 0; i < fftSize; i++) {
      real[i] *= scale;
      imag[i] = 0;
    }

    // Overlap-add with window
    const outOffset = frame * hopSize;
    for (let i = 0; i < fftSize && outOffset + i < outputLength; i++) {
      output[outOffset + i] += real[i] * window[i];
      windowSum[outOffset + i] += window[i] * window[i];
    }
  }

  // Normalize by window sum
  for (let i = 0; i < outputLength; i++) {
    if (windowSum[i] > 1e-8) {
      output[i] /= windowSum[i];
    }
  }

  return output;
}

/** Bit-reversal permutation for Cooley-Tukey FFT. */
function bitReverse(x: number, bits: number): number {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | (x & 1);
    x >>= 1;
  }
  return result;
}

/** In-place radix-2 Cooley-Tukey FFT. */
export function fftInPlace(real: Float32Array, imag: Float32Array, n: number): void {
  const bits = Math.log2(n);

  for (let i = 0; i < n; i++) {
    const j = bitReverse(i, bits);
    if (j > i) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size / 2;
    const angleStep = (-2 * Math.PI) / size;

    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < halfSize; j++) {
        const angle = angleStep * j;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const evenIdx = i + j;
        const oddIdx = i + j + halfSize;

        const tReal = cos * real[oddIdx] - sin * imag[oddIdx];
        const tImag = sin * real[oddIdx] + cos * imag[oddIdx];

        real[oddIdx] = real[evenIdx] - tReal;
        imag[oddIdx] = imag[evenIdx] - tImag;
        real[evenIdx] += tReal;
        imag[evenIdx] += tImag;
      }
    }
  }
}

/** Encode channel data to a WAV blob. */
export function encodeWavBlob(
  channelData: Float32Array[],
  sampleRate: number,
): Blob {
  const numberOfChannels = channelData.length;
  const length = channelData[0].length;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numberOfChannels * bytesPerSample;
  const dataLength = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i] ?? 0));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
