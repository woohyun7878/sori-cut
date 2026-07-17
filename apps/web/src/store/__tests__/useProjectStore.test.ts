import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProjectStore } from '../useProjectStore';

// Mock crypto.randomUUID (incrementing so newly created tracks get unique ids)
let uuidCounter = 0;
vi.stubGlobal('crypto', { randomUUID: () => `test-uuid-${++uuidCounter}` });

// Mock URL.createObjectURL / revokeObjectURL
vi.stubGlobal('URL', {
  createObjectURL: () => 'blob:test-url',
  revokeObjectURL: vi.fn(),
});

function makeAudioFile(overrides = {}) {
  return {
    id: 'audio-1',
    name: 'test-audio.mp3',
    blob: new Blob(['audio'], { type: 'audio/mp3' }),
    url: 'blob:audio-url',
    duration: 10,
    ...overrides,
  };
}

function makeStem(overrides = {}) {
  return {
    id: 'stem-1',
    name: 'vocals',
    label: 'Vocals',
    blob: new Blob(['stem'], { type: 'audio/wav' }),
    url: 'blob:stem-url',
    muted: false,
    volume: 0.8,
    solo: false,
    ...overrides,
  };
}

function makeRecording(overrides = {}) {
  return {
    id: 'rec-1',
    name: 'Recording 1',
    blob: new Blob(['recording'], { type: 'audio/wav' }),
    url: 'blob:rec-url',
    duration: 5,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeVideo(overrides = {}) {
  return {
    id: 'video-1',
    name: 'test-video.mp4',
    blob: new Blob(['video'], { type: 'video/mp4' }),
    url: 'blob:video-url',
    duration: 15,
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

describe('useProjectStore', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
  });

  describe('setOriginalAudio', () => {
    it('sets the original audio file', () => {
      const audio = makeAudioFile();
      useProjectStore.getState().setOriginalAudio(audio);
      expect(useProjectStore.getState().originalAudio).toEqual(audio);
    });

    it('adds an audio track to the timeline', () => {
      const audio = makeAudioFile();
      useProjectStore.getState().setOriginalAudio(audio);
      const tracks = useProjectStore.getState().tracks;
      expect(tracks.length).toBe(1);
      expect(tracks[0].id).toBe('audio-original');
      expect(tracks[0].type).toBe('audio');
      expect(tracks[0].duration).toBe(10);
    });
  });

  describe('addRecording', () => {
    it('adds a recording to the recordings array', () => {
      const recording = makeRecording();
      useProjectStore.getState().addRecording(recording);
      expect(useProjectStore.getState().recordings).toHaveLength(1);
      expect(useProjectStore.getState().recordings[0].id).toBe('rec-1');
    });

    it('adds a recording track to the timeline', () => {
      const recording = makeRecording();
      useProjectStore.getState().addRecording(recording);
      const tracks = useProjectStore.getState().tracks;
      expect(tracks.some((t) => t.id === 'recording-rec-1')).toBe(true);
    });
  });

  describe('setVideo', () => {
    it('sets the video file', () => {
      const video = makeVideo();
      useProjectStore.getState().setVideo(video);
      expect(useProjectStore.getState().video).toEqual(video);
    });

    it('adds a video track to the timeline', () => {
      const video = makeVideo();
      useProjectStore.getState().setVideo(video);
      const tracks = useProjectStore.getState().tracks;
      expect(tracks.some((t) => t.type === 'video')).toBe(true);
    });

    it('removes video when set to null', () => {
      const video = makeVideo();
      useProjectStore.getState().setVideo(video);
      useProjectStore.getState().setVideo(null);
      expect(useProjectStore.getState().video).toBeNull();
      expect(useProjectStore.getState().tracks.filter((t) => t.type === 'video')).toHaveLength(0);
    });
  });

  describe('toggleStemMute', () => {
    it('toggles muted state on a stem', () => {
      const stem = makeStem({ muted: false });
      useProjectStore.getState().setStems([stem]);
      useProjectStore.getState().toggleStemMute('stem-1');
      const updatedStem = useProjectStore.getState().stems.find((s) => s.id === 'stem-1');
      expect(updatedStem?.muted).toBe(true);
    });

    it('toggles back from muted to unmuted', () => {
      const stem = makeStem({ muted: true });
      useProjectStore.getState().setStems([stem]);
      useProjectStore.getState().toggleStemMute('stem-1');
      const updatedStem = useProjectStore.getState().stems.find((s) => s.id === 'stem-1');
      expect(updatedStem?.muted).toBe(false);
    });
  });

  describe('toggleStemSolo', () => {
    it('toggles solo state on a stem', () => {
      const stem = makeStem({ solo: false });
      useProjectStore.getState().setStems([stem]);
      useProjectStore.getState().toggleStemSolo('stem-1');
      const updatedStem = useProjectStore.getState().stems.find((s) => s.id === 'stem-1');
      expect(updatedStem?.solo).toBe(true);
    });
  });

  describe('setStemVolume', () => {
    it('sets volume on a stem', () => {
      const stem = makeStem({ volume: 0.5 });
      useProjectStore.getState().setStems([stem]);
      useProjectStore.getState().setStemVolume('stem-1', 0.75);
      const updatedStem = useProjectStore.getState().stems.find((s) => s.id === 'stem-1');
      expect(updatedStem?.volume).toBe(0.75);
    });

    it('clamps volume to 0-1 range', () => {
      const stem = makeStem();
      useProjectStore.getState().setStems([stem]);
      useProjectStore.getState().setStemVolume('stem-1', 1.5);
      expect(useProjectStore.getState().stems.find((s) => s.id === 'stem-1')?.volume).toBe(1);
      useProjectStore.getState().setStemVolume('stem-1', -0.5);
      expect(useProjectStore.getState().stems.find((s) => s.id === 'stem-1')?.volume).toBe(0);
    });
  });

  describe('removeTrack', () => {
    it('removes a track by id', () => {
      useProjectStore.getState().addTrack({ id: 'track-1', type: 'audio' });
      expect(useProjectStore.getState().tracks.length).toBe(1);
      useProjectStore.getState().removeTrack('track-1');
      expect(useProjectStore.getState().tracks.length).toBe(0);
    });
  });

  describe('updateTrackOffset', () => {
    it('updates the start offset of a track', () => {
      useProjectStore.getState().addTrack({ id: 'track-1', type: 'audio' });
      useProjectStore.getState().updateTrackOffset('track-1', 5);
      const track = useProjectStore.getState().tracks.find((t) => t.id === 'track-1');
      expect(track?.startOffset).toBe(5);
    });

    it('clamps negative offsets to 0', () => {
      useProjectStore.getState().addTrack({ id: 'track-1', type: 'audio' });
      useProjectStore.getState().updateTrackOffset('track-1', -3);
      const track = useProjectStore.getState().tracks.find((t) => t.id === 'track-1');
      expect(track?.startOffset).toBe(0);
    });
  });

  describe('reset', () => {
    it('resets the store to initial state', () => {
      useProjectStore.getState().setOriginalAudio(makeAudioFile());
      useProjectStore.getState().addRecording(makeRecording());
      useProjectStore.getState().reset();
      const state = useProjectStore.getState();
      expect(state.originalAudio).toBeNull();
      expect(state.recordings).toHaveLength(0);
      expect(state.tracks).toHaveLength(0);
      expect(state.stems).toHaveLength(0);
    });
  });

  describe('setProjectName', () => {
    it('sets the project name', () => {
      useProjectStore.getState().setProjectName('My Project');
      expect(useProjectStore.getState().projectName).toBe('My Project');
    });
  });

  describe('loadFromSaved', () => {
    it('loads partial state from saved data', () => {
      useProjectStore.getState().loadFromSaved({
        projectName: 'Saved Project',
        projectId: 'saved-id',
      });
      expect(useProjectStore.getState().projectName).toBe('Saved Project');
      expect(useProjectStore.getState().projectId).toBe('saved-id');
    });

    it('resets other fields to initial when loading', () => {
      useProjectStore.getState().addRecording(makeRecording());
      useProjectStore.getState().loadFromSaved({ projectName: 'Fresh' });
      expect(useProjectStore.getState().recordings).toHaveLength(0);
    });
  });

  describe('addTrack', () => {
    it('returns the id of the new track', () => {
      const id = useProjectStore.getState().addTrack({ type: 'audio' });
      expect(id).toBeTruthy();
      expect(useProjectStore.getState().tracks.find((t) => t.id === id)).toBeDefined();
    });

    it('uses provided id if given', () => {
      const id = useProjectStore.getState().addTrack({ id: 'custom-id', type: 'stem' });
      expect(id).toBe('custom-id');
    });
  });

  describe('splitTrackAtPosition', () => {
    function addSourceTrack() {
      useProjectStore.getState().addTrack({
        id: 'track-1',
        type: 'audio',
        startOffset: 0,
        duration: 10,
        sourceUrl: 'blob:source',
      });
    }

    it('defaults sourceStartOffset to 0 on new tracks', () => {
      addSourceTrack();
      expect(useProjectStore.getState().tracks[0].sourceStartOffset).toBe(0);
    });

    it('gives the second half a sourceStartOffset at the split point', () => {
      addSourceTrack();
      useProjectStore.getState().splitTrackAtPosition('track-1', 4);

      const tracks = useProjectStore.getState().tracks;
      expect(tracks).toHaveLength(2);

      const first = tracks.find((t) => t.id === 'track-1')!;
      expect(first.startOffset).toBe(0);
      expect(first.duration).toBe(4);
      expect(first.sourceStartOffset).toBe(0);

      const second = tracks.find((t) => t.id !== 'track-1')!;
      expect(second.startOffset).toBe(4);
      expect(second.duration).toBe(6);
      expect(second.sourceStartOffset).toBe(4);
    });

    it('accumulates sourceStartOffset when splitting an already-split clip', () => {
      addSourceTrack();
      useProjectStore.getState().splitTrackAtPosition('track-1', 4);

      const secondId = useProjectStore.getState().tracks.find((t) => t.id !== 'track-1')!.id;
      // Second clip spans timeline [4, 10) with sourceStartOffset 4; split it at 7.
      useProjectStore.getState().splitTrackAtPosition(secondId, 7);

      const tracks = useProjectStore.getState().tracks;
      expect(tracks).toHaveLength(3);

      const middle = tracks.find((t) => t.id === secondId)!;
      expect(middle.startOffset).toBe(4);
      expect(middle.duration).toBe(3);
      expect(middle.sourceStartOffset).toBe(4);

      const last = tracks.find((t) => t.id !== 'track-1' && t.id !== secondId)!;
      expect(last.startOffset).toBe(7);
      expect(last.duration).toBe(3);
      expect(last.sourceStartOffset).toBe(4 + (7 - 4));
    });

    it('splitting a trimmed clip offsets from the existing sourceStartOffset', () => {
      addSourceTrack();
      // Trim the start: clip now starts at timeline 2 with source in-point 2.
      useProjectStore.getState().trimTrack('track-1', 2, 8);
      useProjectStore.getState().splitTrackAtPosition('track-1', 5);

      const second = useProjectStore.getState().tracks.find((t) => t.id !== 'track-1')!;
      expect(second.sourceStartOffset).toBe(2 + (5 - 2));
    });
  });

  describe('trimTrack', () => {
    beforeEach(() => {
      useProjectStore.getState().addTrack({
        id: 'track-1',
        type: 'audio',
        startOffset: 2,
        duration: 8,
        sourceUrl: 'blob:source',
      });
    });

    it('advances sourceStartOffset when trimming from the start', () => {
      // Start edge moves right from 2 to 4 (delta +2), duration shrinks by 2.
      useProjectStore.getState().trimTrack('track-1', 4, 6);

      const track = useProjectStore.getState().tracks.find((t) => t.id === 'track-1')!;
      expect(track.startOffset).toBe(4);
      expect(track.duration).toBe(6);
      expect(track.sourceStartOffset).toBe(2);
    });

    it('only shrinks duration when trimming from the end', () => {
      useProjectStore.getState().trimTrack('track-1', 2, 5);

      const track = useProjectStore.getState().tracks.find((t) => t.id === 'track-1')!;
      expect(track.startOffset).toBe(2);
      expect(track.duration).toBe(5);
      expect(track.sourceStartOffset).toBe(0);
    });

    it('accumulates sourceStartOffset over successive start trims', () => {
      useProjectStore.getState().trimTrack('track-1', 3, 7);
      useProjectStore.getState().trimTrack('track-1', 5, 5);

      const track = useProjectStore.getState().tracks.find((t) => t.id === 'track-1')!;
      expect(track.sourceStartOffset).toBe(3);
    });

    it('moving the start edge back left restores the source in-point (never below 0)', () => {
      useProjectStore.getState().trimTrack('track-1', 4, 6);
      useProjectStore.getState().trimTrack('track-1', 3, 7);

      const track = useProjectStore.getState().tracks.find((t) => t.id === 'track-1')!;
      expect(track.sourceStartOffset).toBe(1);

      useProjectStore.getState().trimTrack('track-1', 0, 10);
      expect(useProjectStore.getState().tracks.find((t) => t.id === 'track-1')!.sourceStartOffset).toBe(0);
    });
  });

  describe('playback controls', () => {
    it('setIsPlaying toggles play state', () => {
      useProjectStore.getState().setIsPlaying(true);
      expect(useProjectStore.getState().isPlaying).toBe(true);
      useProjectStore.getState().setIsPlaying(false);
      expect(useProjectStore.getState().isPlaying).toBe(false);
    });

    it('stopPlayback resets playing and position', () => {
      useProjectStore.getState().setIsPlaying(true);
      useProjectStore.getState().setPlayheadPosition(5);
      useProjectStore.getState().stopPlayback();
      expect(useProjectStore.getState().isPlaying).toBe(false);
      expect(useProjectStore.getState().playheadPosition).toBe(0);
    });
  });
});
