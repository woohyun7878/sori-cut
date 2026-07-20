import type { TimelineTrack, TrackType } from '../store/useProjectStore';

export interface TrackPalette {
  accent: string;
  clip: string;
  waveform: string;
}

const palettes: Record<'bass' | 'drums' | 'guitar' | 'other' | 'vocals', TrackPalette> = {
  vocals: {
    accent: 'bg-violet-400',
    clip: 'border-violet-400/80 bg-violet-500/20',
    waveform: '#c4b5fd',
  },
  drums: {
    accent: 'bg-blue-400',
    clip: 'border-blue-400/80 bg-blue-500/20',
    waveform: '#60a5fa',
  },
  bass: {
    accent: 'bg-teal-400',
    clip: 'border-teal-400/80 bg-teal-500/20',
    waveform: '#5eead4',
  },
  other: {
    accent: 'bg-orange-400',
    clip: 'border-orange-400/80 bg-orange-500/20',
    waveform: '#fb923c',
  },
  guitar: {
    accent: 'bg-yellow-400',
    clip: 'border-yellow-400/80 bg-yellow-500/20',
    waveform: '#facc15',
  },
};

const typePalettes: Record<TrackType, TrackPalette> = {
  audio: palettes.vocals,
  video: {
    accent: 'bg-slate-300',
    clip: 'border-slate-400/70 bg-slate-500/20',
    waveform: '#cbd5e1',
  },
  stem: palettes.other,
  recording: {
    accent: 'bg-fuchsia-400',
    clip: 'border-fuchsia-400/80 bg-fuchsia-500/20',
    waveform: '#e879f9',
  },
};

export function getTrackPalette(track: Pick<TimelineTrack, 'name' | 'type'>): TrackPalette {
  const name = track.name.toLowerCase();

  if (name.includes('vocal')) return palettes.vocals;
  if (name.includes('drum')) return palettes.drums;
  if (name.includes('bass')) return palettes.bass;
  if (name.includes('guitar')) return palettes.guitar;
  if (name.includes('other')) return palettes.other;

  return typePalettes[track.type];
}

export function getMarkerStep(zoom: number) {
  if (zoom <= 40) return 5;
  if (zoom <= 80) return 2;
  return 1;
}

export function snapTimelineTime(seconds: number, enabled: boolean, interval = 0.25) {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  if (!enabled || interval <= 0) return safeSeconds;

  return Math.round(safeSeconds / interval) * interval;
}

export function formatTimelineTime(seconds: number, precise = false) {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safeSeconds / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const base = `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}`;

  return precise ? `${base}.${String(Math.floor((safeSeconds % 1) * 100)).padStart(2, '0')}` : base;
}
