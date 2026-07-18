import { describe, it, expect } from 'vitest';
import {
  hannWindow,
  computeSTFT,
  computeISTFT,
  encodeWavBlob,
  fftInPlace,
} from '../stemSeparationUtils';

describe('stemSeparationUtils', () => {
  describe('hannWindow', () => {
    it('returns a Float32Array of the given size', () => {
      const win = hannWindow(256);
      expect(win).toBeInstanceOf(Float32Array);
      expect(win.length).toBe(256);
    });

    it('starts and ends near zero', () => {
      const win = hannWindow(128);
      expect(win[0]).toBeCloseTo(0, 5);
      expect(win[127]).toBeCloseTo(0, 5);
    });

    it('peaks at the center', () => {
      const win = hannWindow(256);
      const mid = Math.floor(256 / 2);
      expect(win[mid]).toBeCloseTo(1, 2);
    });
  });

  describe('fftInPlace', () => {
    it('computes FFT of a DC signal', () => {
      const n = 8;
      const real = new Float32Array(n).fill(1);
      const imag = new Float32Array(n).fill(0);

      fftInPlace(real, imag, n);

      // DC bin should equal n, all other bins should be ~0
      expect(real[0]).toBeCloseTo(n, 4);
      for (let i = 1; i < n; i++) {
        expect(real[i]).toBeCloseTo(0, 4);
        expect(imag[i]).toBeCloseTo(0, 4);
      }
    });

    it('preserves Parseval energy relationship', () => {
      const n = 16;
      const real = new Float32Array(n);
      const imag = new Float32Array(n).fill(0);

      // Generate a test signal
      for (let i = 0; i < n; i++) {
        real[i] = Math.sin(2 * Math.PI * i / n);
      }

      const timeEnergy = real.reduce((sum, v) => sum + v * v, 0);

      fftInPlace(real, imag, n);

      const freqEnergy = real.reduce((sum, v, i) => sum + v * v + imag[i] * imag[i], 0) / n;

      expect(freqEnergy).toBeCloseTo(timeEnergy, 3);
    });
  });

  describe('STFT / ISTFT round-trip', () => {
    it('reconstructs the original signal with acceptable error', () => {
      const sampleRate = 44100;
      const duration = 0.05; // 50ms
      const length = Math.floor(sampleRate * duration);
      const fftSize = 256;
      const hopSize = 64;

      // Generate a test sine wave
      const samples = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        samples[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.8;
      }

      const { magnitude, phase, numFrames, numBins } = computeSTFT(samples, fftSize, hopSize);
      const reconstructed = computeISTFT(magnitude, phase, numFrames, numBins, fftSize, hopSize, length);

      // Check that reconstruction matches original within tolerance
      // Skip edges where windowing causes artifacts
      const margin = fftSize;
      let maxError = 0;
      for (let i = margin; i < length - margin; i++) {
        const error = Math.abs(samples[i] - reconstructed[i]);
        if (error > maxError) maxError = error;
      }

      // STFT/ISTFT should reconstruct with very small error in the middle
      expect(maxError).toBeLessThan(0.05);
    });

    it('handles silence correctly', () => {
      const fftSize = 256;
      const hopSize = 64;
      const length = 1024;
      const samples = new Float32Array(length); // all zeros

      const { magnitude, phase, numFrames, numBins } = computeSTFT(samples, fftSize, hopSize);
      const reconstructed = computeISTFT(magnitude, phase, numFrames, numBins, fftSize, hopSize, length);

      for (let i = 0; i < length; i++) {
        expect(reconstructed[i]).toBeCloseTo(0, 5);
      }
    });

    it('does not throw and yields zero frames for a segment shorter than fftSize', () => {
      const fftSize = 256;
      const hopSize = 64;
      const length = 100; // shorter than fftSize -> raw formula would be negative
      const samples = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.8;
      }

      let result: ReturnType<typeof computeSTFT> | undefined;
      expect(() => {
        result = computeSTFT(samples, fftSize, hopSize);
      }).not.toThrow();

      const { magnitude, phase, numFrames, numBins } = result!;
      expect(numFrames).toBeGreaterThanOrEqual(0);
      expect(numFrames).toBe(0);
      expect(numBins).toBe(fftSize / 2 + 1);
      expect(magnitude).toBeInstanceOf(Float32Array);
      expect(phase).toBeInstanceOf(Float32Array);
      expect(magnitude.length).toBe(0);
      expect(phase.length).toBe(0);

      // The inverse round-trip on an empty STFT must also be safe and produce silence.
      let reconstructed: Float32Array | undefined;
      expect(() => {
        reconstructed = computeISTFT(magnitude, phase, numFrames, numBins, fftSize, hopSize, length);
      }).not.toThrow();
      expect(reconstructed!.length).toBe(length);
      for (let i = 0; i < length; i++) {
        expect(reconstructed![i]).toBe(0);
      }
    });
  });

  describe('encodeWavBlob', () => {
    it('produces a blob with audio/wav type', () => {
      const channelData = [new Float32Array(100)];
      const blob = encodeWavBlob(channelData, 44100);
      expect(blob.type).toBe('audio/wav');
    });

    it('produces correct file size for mono', () => {
      const length = 100;
      const channelData = [new Float32Array(length)];
      const blob = encodeWavBlob(channelData, 44100);
      // 44 header + length * 1 channel * 2 bytes
      expect(blob.size).toBe(44 + length * 2);
    });

    it('produces correct file size for stereo', () => {
      const length = 100;
      const channelData = [new Float32Array(length), new Float32Array(length)];
      const blob = encodeWavBlob(channelData, 44100);
      // 44 header + length * 2 channels * 2 bytes
      expect(blob.size).toBe(44 + length * 4);
    });

    it('encodes non-zero samples', async () => {
      const samples = new Float32Array(10);
      samples[0] = 0.5;
      samples[1] = -0.5;
      const channelData = [samples];
      const blob = encodeWavBlob(channelData, 44100);

      // Read blob via FileReader since jsdom Blob lacks arrayBuffer()
      const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
      });
      const view = new DataView(arrayBuffer);

      // First sample at offset 44 should be positive
      const firstSample = view.getInt16(44, true);
      expect(firstSample).toBeGreaterThan(0);

      // Second sample should be negative
      const secondSample = view.getInt16(46, true);
      expect(secondSample).toBeLessThan(0);
    });
  });
});
