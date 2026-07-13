import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore, calculateProjectDuration } from '../useProjectStore';
import type { AudioFile, Recording, VideoFile, Stem, TimelineTrack } from '../useProjectStore';

function createAudioFile(overrides: Partial<AudioFile> = {}): AudioFile {
  return {
    id: 'audio-1',
    name: 'test.mp3',
    blob: new Blob(['audio'], { type: 'audio/mp3' }),
    url: 'blob:http://localhost/audio-1',
    duration: 10,
    ...overrides,
  };
}

function createRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: 'rec-1',
    name: 'Recording 1',
    blob: new Blob(['recording'], { type: 'audio/wav' }),
    url: 'blob:http://localhost/rec-1',
    duration: 5,
    createdAt: Date.now(),
    ...overrides,
  };
}

function createVideo(overrides: Partial<VideoFile> = {}): VideoFile {
  return {
    id: 'video-1',
    name: 'clip.mp4',
    blob: new Blob(['video'], { type: 'video/mp4' }),
    url: 'blob:http://localhost/video-1',
    duration: 15,
    width: 1080,
    height: 1920,
    ...overrides,
  };
}

describe('useProjectStore', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
  });

  describe('setOriginalAudio', () => {
    it('sets audio and adds a timeline track', () => {
      const audio = createAudioFile();
      useProjectStore.getState().setOriginalAudio(audio);

      const state = useProjectStore.getState();
      expect(state.originalAudio).toEqual(audio);
      expect(state.tracks).toHaveLength(1);
      expect(state.tracks[0].id).toBe('audio-original');
      expect(state.tracks[0].type).toBe('audio');
      expect(state.tracks[0].duration).toBe(10);
    });
  });

  describe('addRecording', () => {
    it('adds a recording and a timeline track', () => {
      const recording = createRecording();
      useProjectStore.getState().addRecording(recording);

      const state = useProjectStore.getState();
      expect(state.recordings).toHaveLength(1);
      expect(state.recordings[0].id).toBe('rec-1');
      expect(state.tracks).toHaveLength(1);
      expect(state.tracks[0].id).toBe('recording-rec-1');
      expect(state.tracks[0].type).toBe('recording');
      expect(state.tracks[0].duration).toBe(5);
    });
  });

  describe('setVideo', () => {
    it('sets video and adds a timeline track', () => {
      const video = createVideo();
      useProjectStore.getState().setVideo(video);

      const state = useProjectStore.getState();
      expect(state.video).toEqual(video);
      expect(state.tracks).toHaveLength(1);
      expect(state.tracks[0].id).toBe('video-track');
      expect(state.tracks[0].type).toBe('video');
      expect(state.tracks[0].duration).toBe(15);
      expect(state.tracks[0].muted).toBe(true);
    });
  });

  describe('toggleStemMute', () => {
    it('toggles the muted state of a stem', () => {
      const stems: Stem[] = [
        {
          id: 'vocal',
          name: 'vocals',
          label: '보컬',
          blob: new Blob(),
          url: 'blob:http://localhost/vocal',
          muted: false,
          volume: 1,
          solo: false,
        },
      ];
      useProjectStore.getState().setStems(stems);

      useProjectStore.getState().toggleStemMute('vocal');
      expect(useProjectStore.getState().stems[0].muted).toBe(true);

      useProjectStore.getState().toggleStemMute('vocal');
      expect(useProjectStore.getState().stems[0].muted).toBe(false);
    });
  });

  describe('toggleStemSolo', () => {
    it('toggles the solo state of a stem', () => {
      const stems: Stem[] = [
        {
          id: 'drums',
          name: 'drums',
          label: '드럼',
          blob: new Blob(),
          url: 'blob:http://localhost/drums',
          muted: false,
          volume: 1,
          solo: false,
        },
      ];
      useProjectStore.getState().setStems(stems);

      useProjectStore.getState().toggleStemSolo('drums');
      expect(useProjectStore.getState().stems[0].solo).toBe(true);

      useProjectStore.getState().toggleStemSolo('drums');
      expect(useProjectStore.getState().stems[0].solo).toBe(false);
    });
  });

  describe('setStemVolume', () => {
    it('sets the volume of a stem clamped to [0, 1]', () => {
      const stems: Stem[] = [
        {
          id: 'bass',
          name: 'bass',
          label: '베이스',
          blob: new Blob(),
          url: 'blob:http://localhost/bass',
          muted: false,
          volume: 1,
          solo: false,
        },
      ];
      useProjectStore.getState().setStems(stems);

      useProjectStore.getState().setStemVolume('bass', 0.5);
      expect(useProjectStore.getState().stems[0].volume).toBe(0.5);

      useProjectStore.getState().setStemVolume('bass', 2);
      expect(useProjectStore.getState().stems[0].volume).toBe(1);

      useProjectStore.getState().setStemVolume('bass', -1);
      expect(useProjectStore.getState().stems[0].volume).toBe(0);
    });
  });

  describe('removeTrack', () => {
    it('removes a track by id', () => {
      const audio = createAudioFile();
      useProjectStore.getState().setOriginalAudio(audio);
      expect(useProjectStore.getState().tracks).toHaveLength(1);

      useProjectStore.getState().removeTrack('audio-original');
      expect(useProjectStore.getState().tracks).toHaveLength(0);
    });
  });

  describe('updateTrackOffset', () => {
    it('updates the start offset of a track (clamped to >= 0)', () => {
      const audio = createAudioFile();
      useProjectStore.getState().setOriginalAudio(audio);

      useProjectStore.getState().updateTrackOffset('audio-original', 3);
      expect(useProjectStore.getState().tracks[0].startOffset).toBe(3);

      useProjectStore.getState().updateTrackOffset('audio-original', -5);
      expect(useProjectStore.getState().tracks[0].startOffset).toBe(0);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      useProjectStore.getState().setOriginalAudio(createAudioFile());
      useProjectStore.getState().addRecording(createRecording());
      useProjectStore.getState().setVideo(createVideo());

      useProjectStore.getState().reset();
      const state = useProjectStore.getState();

      expect(state.originalAudio).toBeNull();
      expect(state.stems).toEqual([]);
      expect(state.recordings).toEqual([]);
      expect(state.video).toBeNull();
      expect(state.tracks).toEqual([]);
      expect(state.playheadPosition).toBe(0);
      expect(state.isPlaying).toBe(false);
    });
  });

  describe('calculateProjectDuration', () => {
    it('returns 0 for empty tracks and no video', () => {
      expect(calculateProjectDuration([], null)).toBe(0);
    });

    it('returns track end time (offset + duration)', () => {
      const tracks: TimelineTrack[] = [
        { id: 't1', name: 'T1', type: 'audio', sourceUrl: '', startOffset: 2, duration: 5, muted: false, volume: 1 },
      ];
      expect(calculateProjectDuration(tracks, null)).toBe(7);
    });

    it('returns video duration when longer than tracks', () => {
      const tracks: TimelineTrack[] = [
        { id: 't1', name: 'T1', type: 'audio', sourceUrl: '', startOffset: 0, duration: 3, muted: false, volume: 1 },
      ];
      const video = createVideo({ duration: 20 });
      expect(calculateProjectDuration(tracks, video)).toBe(20);
    });

    it('returns max across multiple tracks', () => {
      const tracks: TimelineTrack[] = [
        { id: 't1', name: 'T1', type: 'audio', sourceUrl: '', startOffset: 0, duration: 5, muted: false, volume: 1 },
        { id: 't2', name: 'T2', type: 'recording', sourceUrl: '', startOffset: 4, duration: 8, muted: false, volume: 1 },
      ];
      expect(calculateProjectDuration(tracks, null)).toBe(12);
    });
  });
});
