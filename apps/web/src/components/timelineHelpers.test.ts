import { describe, expect, it } from 'vitest';
import {
  formatTimelineTime,
  getMarkerStep,
  getTrackPalette,
  snapTimelineTime,
} from './timelineHelpers';

describe('timeline helpers', () => {
  it('assigns semantic stem colors from track names', () => {
    expect(getTrackPalette({ name: 'Lead Vocals', type: 'stem' }).waveform).toBe('#c4b5fd');
    expect(getTrackPalette({ name: 'Drums', type: 'stem' }).waveform).toBe('#60a5fa');
    expect(getTrackPalette({ name: 'Bass DI', type: 'stem' }).waveform).toBe('#5eead4');
    expect(getTrackPalette({ name: 'Other', type: 'stem' }).waveform).toBe('#fb923c');
    expect(getTrackPalette({ name: 'Guitar take', type: 'recording' }).waveform).toBe('#facc15');
  });

  it('uses readable ruler intervals at each zoom range', () => {
    expect(getMarkerStep(24)).toBe(5);
    expect(getMarkerStep(64)).toBe(2);
    expect(getMarkerStep(120)).toBe(1);
  });

  it('formats ruler and precise timecode values', () => {
    expect(formatTimelineTime(65.25)).toBe('01:05');
    expect(formatTimelineTime(65.25, true)).toBe('01:05.25');
    expect(formatTimelineTime(Number.NaN, true)).toBe('00:00.00');
  });

  it('snaps edit positions to quarter-second intervals when enabled', () => {
    expect(snapTimelineTime(1.13, true)).toBe(1.25);
    expect(snapTimelineTime(1.13, false)).toBe(1.13);
    expect(snapTimelineTime(-1, true)).toBe(0);
  });
});
