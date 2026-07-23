import { useEffect, useRef, useState } from 'react';
import { extractPeaks, type PeakData } from '../lib/waveformPeaks';

interface ClipWaveformProps {
  /** URL of the source audio file. */
  sourceUrl: string;
  /** Offset into the source audio (seconds) where this clip starts. */
  sourceStartOffset: number;
  /** Duration of this clip in seconds. */
  duration: number;
  /** Pixel width of the clip container. */
  width: number;
  /** Pixel height to render. */
  height: number;
  /** High-contrast semantic track color. */
  color?: string;
}

/**
 * Renders a waveform for a timeline clip using a canvas element.
 * Respects sourceStartOffset so trimmed clips show the correct portion.
 */
export function ClipWaveform({
  sourceUrl,
  sourceStartOffset,
  duration,
  width,
  height,
  color = '#ffffff',
}: ClipWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peakData, setPeakData] = useState<PeakData | null>(null);

  useEffect(() => {
    if (!sourceUrl) return;

    let cancelled = false;
    extractPeaks(sourceUrl).then((data) => {
      if (!cancelled) setPeakData(data);
    });

    return () => {
      cancelled = true;
    };
  }, [sourceUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peakData || width <= 0 || height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const { peaks, peaksPerSecond } = peakData;
    if (peaks.length === 0) return;

    // Determine which slice of peaks corresponds to this clip
    const startPeak = Math.floor(sourceStartOffset * peaksPerSecond);
    const endPeak = Math.min(
      Math.ceil((sourceStartOffset + duration) * peaksPerSecond),
      peaks.length,
    );
    const peakCount = endPeak - startPeak;

    if (peakCount <= 0) return;

    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    const midY = canvasHeight / 2;

    // Draw waveform bars
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.82;

    const barWidth = Math.max(1, (canvasWidth / peakCount) * 0.7);
    const gap = canvasWidth / peakCount;

    for (let i = 0; i < peakCount; i++) {
      const peakIndex = startPeak + i;
      if (peakIndex >= peaks.length) break;

      const amplitude = peaks[peakIndex];
      const barHeight = Math.max(1 * dpr, amplitude * (canvasHeight * 0.8));
      const x = i * gap;

      ctx.fillRect(x, midY - barHeight / 2, Math.max(1, barWidth), barHeight);
    }
  }, [peakData, sourceStartOffset, duration, width, height, color]);

  if (!sourceUrl) return null;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
