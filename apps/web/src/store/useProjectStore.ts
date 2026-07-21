import { create } from 'zustand';
import { getEffectiveSyncOffset } from '../lib/syncOffset';
import { type UndoRedoState, undoMiddleware } from './undoMiddleware';

export interface AudioFile {
  id: string;
  name: string;
  blob: Blob;
  url: string;
  duration: number;
}

export interface Stem {
  id: string;
  name: string;
  label: string;
  blob: Blob;
  url: string;
  muted: boolean;
  volume: number;
  solo: boolean;
}

export interface Recording {
  id: string;
  name: string;
  blob: Blob;
  url: string;
  duration: number;
  createdAt: number;
}

export interface VideoFile {
  id: string;
  name: string;
  blob: Blob;
  url: string;
  duration: number;
  width?: number;
  height?: number;
}

export type TrackType = 'audio' | 'video' | 'stem' | 'recording';

export interface TimelineTrack {
  id: string;
  name: string;
  type: TrackType;
  sourceUrl: string;
  startOffset: number;
  duration: number;
  /** Seconds into the source media where this clip begins playing. */
  sourceStartOffset: number;
  /** Signed auto/manual sync adjustment used to replace prior applications safely. */
  syncOffset?: number;
  muted: boolean;
  volume: number;
}

interface AddTrackInput {
  duration?: number;
  id?: string;
  muted?: boolean;
  name?: string;
  sourceUrl?: string;
  startOffset?: number;
  sourceStartOffset?: number;
  syncOffset?: number;
  type?: TrackType;
  volume?: number;
}

export interface ProjectState extends UndoRedoState {
  projectId: string;
  projectName: string;
  originalAudio: AudioFile | null;
  stems: Stem[];
  recordings: Recording[];
  video: VideoFile | null;
  tracks: TimelineTrack[];
  playheadPosition: number;
  isPlaying: boolean;
  loopEnabled: boolean;
  exportProgress: number;
  isExporting: boolean;
  selectedTrackId: string | null;
  setProjectName: (name: string) => void;
  loadFromSaved: (state: Partial<ProjectState>) => void;
  setOriginalAudio: (file: AudioFile) => void;
  setStems: (stems: Stem[]) => void;
  toggleStemMute: (id: string) => void;
  toggleStemSolo: (id: string) => void;
  setStemVolume: (id: string, volume: number) => void;
  addRecording: (recording: Recording) => void;
  removeRecording: (id: string) => void;
  setVideo: (video: VideoFile | null) => void;
  addTrack: (track?: AddTrackInput) => string;
  removeTrack: (id: string) => void;
  updateTrackOffset: (id: string, offset: number) => void;
  updateTrack: (id: string, updates: Partial<TimelineTrack>) => void;
  toggleTrackMute: (id: string) => void;
  setTrackVolume: (id: string, volume: number) => void;
  setPlayheadPosition: (position: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setLoopEnabled: (enabled: boolean) => void;
  stopPlayback: () => void;
  setExportProgress: (progress: number) => void;
  setIsExporting: (exporting: boolean) => void;
  setSelectedTrack: (id: string | null) => void;
  splitTrackAtPosition: (id: string, position: number) => void;
  trimTrack: (id: string, newOffset: number, newDuration: number) => void;
  reset: () => void;
}

const trackLabels: Record<TrackType, string> = {
  audio: 'Audio',
  video: 'Video',
  stem: 'Stem',
  recording: 'Recording',
};

const initialState = {
  projectId: crypto.randomUUID(),
  projectName: 'New Project' as string,
  originalAudio: null as AudioFile | null,
  stems: [] as Stem[],
  recordings: [] as Recording[],
  video: null as VideoFile | null,
  tracks: [] as TimelineTrack[],
  playheadPosition: 0,
  isPlaying: false,
  loopEnabled: false,
  exportProgress: 0,
  isExporting: false,
  selectedTrackId: null as string | null,
};

function revokeUrl(url?: string | null) {
  if (!url || !url.startsWith('blob:')) {
    return;
  }

  URL.revokeObjectURL(url);
}

/** The subset of project state that owns blob object URLs created via URL.createObjectURL. */
type ProjectUrlSlice = Pick<ProjectState, 'originalAudio' | 'stems' | 'recordings' | 'video' | 'tracks'>;

/** Gather every blob object URL referenced by a project-state slice (deduped). */
function collectObjectUrls(state: Partial<ProjectUrlSlice>): string[] {
  const urls = new Set<string>();
  const add = (url?: string | null) => {
    if (url && url.startsWith('blob:')) {
      urls.add(url);
    }
  };

  add(state.originalAudio?.url);
  state.stems?.forEach((stem) => add(stem.url));
  state.recordings?.forEach((recording) => add(recording.url));
  add(state.video?.url);
  state.tracks?.forEach((track) => add(track.sourceUrl));

  return [...urls];
}

/**
 * Revoke the blob object URLs held by an outgoing project state, skipping any URL
 * the incoming state still references. Used when the whole project is replaced
 * (load/switch) or reset so the previous project's audio/video/stem/recording
 * URLs are not leaked — while never revoking a URL that is carried over.
 */
function revokeDiscardedObjectUrls(
  outgoing: Partial<ProjectUrlSlice>,
  incoming?: Partial<ProjectUrlSlice>,
): void {
  const retained = new Set(incoming ? collectObjectUrls(incoming) : []);

  for (const url of collectObjectUrls(outgoing)) {
    if (!retained.has(url)) {
      revokeUrl(url);
    }
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function sanitizeTrack(track: AddTrackInput, existingTracks: TimelineTrack[], fallbackDuration: number): TimelineTrack {
  const type = track.type ?? 'audio';
  const count = existingTracks.filter((item) => item.type === type).length + 1;

  return {
    id: track.id ?? crypto.randomUUID(),
    name: track.name ?? `${trackLabels[type]} ${count}`,
    type,
    sourceUrl: track.sourceUrl ?? '',
    startOffset: Math.max(track.startOffset ?? 0, 0),
    duration: Math.max(track.duration ?? fallbackDuration, 0.5),
    sourceStartOffset: Math.max(track.sourceStartOffset ?? 0, 0),
    syncOffset: track.syncOffset ?? track.startOffset ?? 0,
    muted: track.muted ?? false,
    volume: clamp(track.volume ?? 0.9, 0, 1),
  };
}

function upsertTrack(tracks: TimelineTrack[], nextTrack: TimelineTrack) {
  const existingIndex = tracks.findIndex((track) => track.id === nextTrack.id);

  if (existingIndex === -1) {
    return [...tracks, nextTrack];
  }

  return tracks.map((track) => (track.id === nextTrack.id ? nextTrack : track));
}

function removeTracksByPrefix(tracks: TimelineTrack[], prefix: string) {
  return tracks.filter((track) => !track.id.startsWith(prefix));
}

export function calculateProjectDuration(tracks: TimelineTrack[], video: VideoFile | null): number {
  const trackDuration = tracks.reduce((maxDuration, track) => {
    return Math.max(maxDuration, Math.max(0, track.startOffset) + Math.max(track.duration, 0));
  }, 0);

  return Math.max(trackDuration, video?.duration ?? 0);
}

export const useProjectStore = create<ProjectState>()(undoMiddleware((set, get) => ({
  ...initialState,
  setProjectName: (name) => set({ projectName: name }),
  loadFromSaved: (saved) =>
    set((state) => {
      // Migrate tracks saved before sourceStartOffset and syncOffset existed.
      const migratedTracks = saved.tracks?.map((track) => ({
        ...track,
        sourceStartOffset: track.sourceStartOffset ?? 0,
        syncOffset: getEffectiveSyncOffset(track),
      }));

      const nextState = {
        ...initialState,
        ...saved,
        ...(migratedTracks ? { tracks: migratedTracks } : {}),
        projectId: saved.projectId ?? crypto.randomUUID(),
      };

      // Revoke the outgoing project's blob URLs, but keep any the incoming
      // project still references so carried-over media stays playable.
      revokeDiscardedObjectUrls(state, nextState);

      return nextState;
    }),
  setOriginalAudio: (file) =>
    set((state) => {
      if (state.originalAudio?.url !== file.url) {
        revokeUrl(state.originalAudio?.url);
      }

      const audioTrack = sanitizeTrack(
        {
          id: 'audio-original',
          name: file.name,
          sourceUrl: file.url,
          duration: file.duration,
          type: 'audio',
          volume: 1,
        },
        state.tracks,
        file.duration || 8,
      );

      return {
        originalAudio: file,
        tracks: upsertTrack(state.tracks, audioTrack),
      };
    }),
  setStems: (stems) =>
    set((state) => {
      state.stems.forEach((existingStem) => {
        const stillPresent = stems.some(
          (incomingStem) => incomingStem.id === existingStem.id && incomingStem.url === existingStem.url,
        );

        if (!stillPresent) {
          revokeUrl(existingStem.url);
        }
      });

      const nextTracks = stems.reduce((tracks, stem) => {
        const track = sanitizeTrack(
          {
            id: `stem-${stem.id}`,
            name: stem.label,
            sourceUrl: stem.url,
            duration: state.originalAudio?.duration ?? state.video?.duration ?? 8,
            type: 'stem',
            muted: stem.muted,
            volume: stem.volume,
          },
          tracks,
          state.originalAudio?.duration ?? state.video?.duration ?? 8,
        );
        return upsertTrack(tracks, track);
      }, removeTracksByPrefix(state.tracks, 'stem-'));

      return {
        stems,
        tracks: nextTracks,
      };
    }),
  toggleStemMute: (id) =>
    set((state) => {
      const nextStems = state.stems.map((stem) => (stem.id === id ? { ...stem, muted: !stem.muted } : stem));
      const targetStem = nextStems.find((stem) => stem.id === id);

      return {
        stems: nextStems,
        tracks: targetStem
          ? state.tracks.map((track) =>
              track.id === `stem-${id}`
                ? {
                    ...track,
                    muted: targetStem.muted,
                  }
                : track,
            )
          : state.tracks,
      };
    }),
  toggleStemSolo: (id) =>
    set((state) => ({
      stems: state.stems.map((stem) => (stem.id === id ? { ...stem, solo: !stem.solo } : stem)),
    })),
  setStemVolume: (id, volume) =>
    set((state) => {
      const nextVolume = clamp(volume, 0, 1);
      return {
        stems: state.stems.map((stem) => (stem.id === id ? { ...stem, volume: nextVolume } : stem)),
        tracks: state.tracks.map((track) =>
          track.id === `stem-${id}`
            ? {
                ...track,
                volume: nextVolume,
              }
            : track,
        ),
      };
    }),
  addRecording: (recording) =>
    set((state) => {
      const recordingTrack = sanitizeTrack(
        {
          id: `recording-${recording.id}`,
          name: recording.name,
          sourceUrl: recording.url,
          duration: recording.duration,
          type: 'recording',
          volume: 1,
        },
        state.tracks,
        recording.duration || 8,
      );

      return {
        recordings: [recording, ...state.recordings],
        tracks: upsertTrack(state.tracks, recordingTrack),
      };
    }),
  removeRecording: (id) =>
    set((state) => {
      const recordingToRemove = state.recordings.find((recording) => recording.id === id);
      revokeUrl(recordingToRemove?.url);

      return {
        recordings: state.recordings.filter((recording) => recording.id !== id),
        tracks: state.tracks.filter((track) => track.id !== `recording-${id}`),
      };
    }),
  setVideo: (video) =>
    set((state) => {
      if (!video) {
        revokeUrl(state.video?.url);
        return {
          video: null,
          tracks: state.tracks.filter((track) => track.type !== 'video'),
        };
      }

      if (state.video?.url !== video.url) {
        revokeUrl(state.video?.url);
      }

      const videoTrack = sanitizeTrack(
        {
          id: 'video-track',
          name: video.name,
          sourceUrl: video.url,
          duration: video.duration,
          type: 'video',
          muted: true,
          volume: 0,
        },
        state.tracks,
        video.duration || 8,
      );

      return {
        video,
        tracks: [videoTrack, ...state.tracks.filter((track) => track.type !== 'video')],
      };
    }),
  addTrack: (track = {}) => {
    const fallbackDuration = Math.max(get().video?.duration ?? get().originalAudio?.duration ?? 8, 4);
    const nextTrack = sanitizeTrack(track, get().tracks, fallbackDuration);

    set((state) => ({
      tracks: upsertTrack(state.tracks, nextTrack),
    }));

    return nextTrack.id;
  },
  removeTrack: (id) =>
    set((state) => ({
      tracks: state.tracks.filter((track) => track.id !== id),
    })),
  updateTrackOffset: (id, offset) =>
    set((state) => ({
      tracks: state.tracks.map((track) =>
        track.id === id
          ? {
              ...track,
              startOffset: Math.max(0, offset),
            }
          : track,
      ),
    })),
  updateTrack: (id, updates) =>
    set((state) => ({
      tracks: state.tracks.map((track) =>
        track.id === id
          ? {
              ...track,
              ...updates,
              duration: updates.duration === undefined ? track.duration : Math.max(updates.duration, 0.5),
              startOffset:
                updates.startOffset === undefined ? track.startOffset : Math.max(0, updates.startOffset),
              volume: updates.volume === undefined ? track.volume : clamp(updates.volume, 0, 1),
            }
          : track,
      ),
    })),
  toggleTrackMute: (id) =>
    set((state) => ({
      tracks: state.tracks.map((track) => (track.id === id ? { ...track, muted: !track.muted } : track)),
    })),
  setTrackVolume: (id, volume) =>
    set((state) => ({
      tracks: state.tracks.map((track) =>
        track.id === id
          ? {
              ...track,
              volume: clamp(volume, 0, 1),
            }
          : track,
      ),
    })),
  setPlayheadPosition: (position) =>
    set({
      playheadPosition: clamp(position, 0, calculateProjectDuration(get().tracks, get().video)),
    }),
  setIsPlaying: (playing) =>
    set({
      isPlaying: playing,
    }),
  setLoopEnabled: (enabled) =>
    set({
      loopEnabled: enabled,
    }),
  stopPlayback: () =>
    set({
      isPlaying: false,
      playheadPosition: 0,
    }),
  setExportProgress: (progress) =>
    set({
      exportProgress: Math.max(0, Math.min(100, progress)),
    }),
  setIsExporting: (exporting) =>
    set({
      isExporting: exporting,
    }),
  setSelectedTrack: (id) => set({ selectedTrackId: id }),
  splitTrackAtPosition: (id, position) =>
    set((state) => {
      const track = state.tracks.find((t) => t.id === id);
      if (!track) return state;

      const trackStart = track.startOffset;
      const trackEnd = track.startOffset + track.duration;

      if (position <= trackStart || position >= trackEnd) return state;

      const firstDuration = position - trackStart;
      const secondDuration = trackEnd - position;

      if (firstDuration < 0.1 || secondDuration < 0.1) return state;

      const firstPart: TimelineTrack = {
        ...track,
        duration: firstDuration,
      };

      const secondPart: TimelineTrack = {
        ...track,
        id: crypto.randomUUID(),
        name: `${track.name} (2)`,
        startOffset: position,
        duration: secondDuration,
        sourceStartOffset: track.sourceStartOffset + firstDuration,
      };

      return {
        tracks: state.tracks.map((t) => (t.id === id ? firstPart : t)).concat(secondPart),
      };
    }),
  trimTrack: (id, newOffset, newDuration) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== id) return t;

        const clampedOffset = Math.max(0, newOffset);
        // Moving the start edge right (or left) shifts the source in-point by the same amount.
        const offsetDelta = clampedOffset - t.startOffset;

        return {
          ...t,
          startOffset: clampedOffset,
          duration: Math.max(0.5, newDuration),
          sourceStartOffset: Math.max(0, t.sourceStartOffset + offsetDelta),
        };
      }),
    })),
  reset: () =>
    set((state) => {
      // Reset discards the whole project, so revoke all of its blob URLs.
      revokeDiscardedObjectUrls(state);

      return { ...initialState, projectId: crypto.randomUUID() };
    }),
})));
