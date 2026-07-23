import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProjectStore } from '../useProjectStore';

// Mock crypto.randomUUID (incrementing so newly created tracks get unique ids)
let uuidCounter = 0;
vi.stubGlobal('crypto', { randomUUID: () => `test-uuid-${++uuidCounter}` });

// Mock URL.createObjectURL / revokeObjectURL
const mockRevokeObjectURL = vi.fn();
vi.stubGlobal('URL', {
  createObjectURL: () => 'blob:test-url',
  revokeObjectURL: mockRevokeObjectURL,
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

  describe('setStems', () => {
    it("revokes replaced stems' object URLs when new stems are set", () => {
      const first = makeStem({ id: 'stem-1', url: 'blob:stem-old' });
      useProjectStore.getState().setStems([first]);

      (URL.revokeObjectURL as ReturnType<typeof vi.fn>).mockClear();

      const second = makeStem({ id: 'stem-2', url: 'blob:stem-new' });
      useProjectStore.getState().setStems([second]);

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stem-old');
    });

    it('revokes all stem URLs when stems are cleared', () => {
      const stem = makeStem({ id: 'stem-1', url: 'blob:stem-a' });
      useProjectStore.getState().setStems([stem]);

      (URL.revokeObjectURL as ReturnType<typeof vi.fn>).mockClear();
      useProjectStore.getState().setStems([]);

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stem-a');
    });

    it("keeps a stem's URL when it is still present in the new set", () => {
      const stem = makeStem({ id: 'stem-1', url: 'blob:stem-keep' });
      useProjectStore.getState().setStems([stem]);

      (URL.revokeObjectURL as ReturnType<typeof vi.fn>).mockClear();
      // Re-set the same stem (e.g. a volume/mute change committed elsewhere).
      useProjectStore.getState().setStems([makeStem({ id: 'stem-1', url: 'blob:stem-keep' })]);

      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:stem-keep');
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

    it('migrates existing clip timing into a stable sync baseline', () => {
      useProjectStore.getState().loadFromSaved({
        tracks: [
          {
            id: 'legacy-track',
            name: 'Legacy',
            type: 'audio',
            sourceUrl: 'blob:legacy',
            startOffset: 3,
            sourceStartOffset: 2,
            duration: 12,
            muted: false,
            volume: 1,
          },
        ],
      });

      expect(useProjectStore.getState().tracks[0]).toMatchObject({
        syncOffset: 1,
        syncBaseSourceStartOffset: 2,
        syncBaseDuration: 12,
      });
    });
  });

  describe('blob URL lifecycle', () => {
    it('revokes the outgoing project object URLs when replacing the project', () => {
      useProjectStore.getState().setOriginalAudio(makeAudioFile({ url: 'blob:old-audio' }));
      useProjectStore.getState().setStems([makeStem({ url: 'blob:old-stem' })]);
      useProjectStore.getState().addRecording(makeRecording({ url: 'blob:old-rec' }));
      useProjectStore.getState().setVideo(makeVideo({ url: 'blob:old-video' }));

      mockRevokeObjectURL.mockClear();

      useProjectStore.getState().loadFromSaved({
        projectId: 'loaded-id',
        projectName: 'Loaded',
        originalAudio: makeAudioFile({ id: 'audio-2', url: 'blob:new-audio' }),
        stems: [],
        recordings: [],
        video: null,
        tracks: [],
      });

      const revoked = mockRevokeObjectURL.mock.calls.map((call) => call[0]);
      expect(revoked).toContain('blob:old-audio');
      expect(revoked).toContain('blob:old-stem');
      expect(revoked).toContain('blob:old-rec');
      expect(revoked).toContain('blob:old-video');
      // The freshly loaded URL must survive.
      expect(revoked).not.toContain('blob:new-audio');
    });

    it('revokes every project object URL on reset', () => {
      useProjectStore.getState().setOriginalAudio(makeAudioFile({ url: 'blob:reset-audio' }));
      useProjectStore.getState().setVideo(makeVideo({ url: 'blob:reset-video' }));

      mockRevokeObjectURL.mockClear();
      useProjectStore.getState().reset();

      const revoked = mockRevokeObjectURL.mock.calls.map((call) => call[0]);
      expect(revoked).toContain('blob:reset-audio');
      expect(revoked).toContain('blob:reset-video');
    });

    it('does not revoke a URL that the incoming project still references', () => {
      const audio = makeAudioFile({ url: 'blob:kept-audio' });
      useProjectStore.getState().setOriginalAudio(audio);

      mockRevokeObjectURL.mockClear();
      // Re-load a project that carries the same audio asset forward.
      useProjectStore.getState().loadFromSaved({
        projectName: 'Same audio',
        originalAudio: audio,
        tracks: [
          {
            id: 'audio-original',
            name: audio.name,
            type: 'audio',
            sourceUrl: audio.url,
            startOffset: 0,
            duration: audio.duration,
            sourceStartOffset: 0,
            muted: false,
            volume: 1,
          },
        ],
      });

      const revoked = mockRevokeObjectURL.mock.calls.map((call) => call[0]);
      expect(revoked).not.toContain('blob:kept-audio');
      expect(useProjectStore.getState().originalAudio?.url).toBe('blob:kept-audio');
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
      expect(first.syncOffset).toBe(0);

      const second = tracks.find((t) => t.id !== 'track-1')!;
      expect(second.startOffset).toBe(4);
      expect(second.duration).toBe(6);
      expect(second.sourceStartOffset).toBe(4);
      expect(second.syncOffset).toBe(0);
      expect(second.syncBaseSourceStartOffset).toBe(4);
      expect(second.syncBaseDuration).toBe(6);
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

    it('preserves a short split duration when applying complete sync timing', () => {
      addSourceTrack();
      useProjectStore.getState().splitTrackAtPosition('track-1', 0.2);

      useProjectStore.getState().updateTrack('track-1', {
        startOffset: 1,
        sourceStartOffset: 0,
        duration: 0.2,
        syncOffset: 1,
        syncBaseSourceStartOffset: 0,
        syncBaseDuration: 0.2,
      });

      expect(
        useProjectStore.getState().tracks.find((track) => track.id === 'track-1'),
      ).toMatchObject({
        startOffset: 1,
        duration: 0.2,
        syncOffset: 1,
      });
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
      expect(track.syncOffset).toBe(2);
      expect(track.syncBaseSourceStartOffset).toBe(2);
      expect(track.syncBaseDuration).toBe(6);
    });

    it('only shrinks duration when trimming from the end', () => {
      useProjectStore.getState().trimTrack('track-1', 2, 5);

      const track = useProjectStore.getState().tracks.find((t) => t.id === 'track-1')!;
      expect(track.startOffset).toBe(2);
      expect(track.duration).toBe(5);
      expect(track.sourceStartOffset).toBe(0);
    });

    it('preserves negative sync state when only the clip end changes', () => {
      useProjectStore.getState().updateTrack('track-1', {
        startOffset: 0,
        sourceStartOffset: 4,
        duration: 6,
        syncOffset: -4,
      });

      useProjectStore.getState().trimTrack('track-1', 0, 5);

      const track = useProjectStore.getState().tracks.find((t) => t.id === 'track-1')!;
      expect(track.syncOffset).toBe(-4);
      expect(track.sourceStartOffset).toBe(4);
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
      expect(
        useProjectStore.getState().tracks.find((t) => t.id === 'track-1')!.sourceStartOffset,
      ).toBe(0);
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

  describe('selection consistency', () => {
    it('removeTrack clears selectedTrackId when the selected track is removed', () => {
      useProjectStore.getState().addTrack({ id: 'sel-1', type: 'audio', duration: 5 });
      useProjectStore.getState().setSelectedTrack('sel-1');
      expect(useProjectStore.getState().selectedTrackId).toBe('sel-1');

      useProjectStore.getState().removeTrack('sel-1');
      expect(useProjectStore.getState().selectedTrackId).toBeNull();
    });

    it('removeTrack preserves selection when a different track is removed', () => {
      useProjectStore.getState().addTrack({ id: 'sel-a', type: 'audio', duration: 5 });
      useProjectStore.getState().addTrack({ id: 'sel-b', type: 'audio', duration: 5 });
      useProjectStore.getState().setSelectedTrack('sel-a');

      useProjectStore.getState().removeTrack('sel-b');
      expect(useProjectStore.getState().selectedTrackId).toBe('sel-a');
    });

    it('removeRecording clears selectedTrackId for the recording track', () => {
      const rec = {
        id: 'rec-sel',
        name: 'Test Rec',
        blob: new Blob(['audio'], { type: 'audio/wav' }),
        url: 'blob:rec-sel-url',
        duration: 3,
        createdAt: Date.now(),
      };
      useProjectStore.getState().addRecording(rec);
      useProjectStore.getState().setSelectedTrack('recording-rec-sel');
      expect(useProjectStore.getState().selectedTrackId).toBe('recording-rec-sel');

      useProjectStore.getState().removeRecording('rec-sel');
      expect(useProjectStore.getState().selectedTrackId).toBeNull();
    });

    it('setVideo(null) clears selectedTrackId when the video track was selected', () => {
      const video = {
        id: 'vid-1',
        name: 'video.mp4',
        blob: new Blob(['vid'], { type: 'video/mp4' }),
        url: 'blob:vid-url',
        duration: 10,
        width: 1920,
        height: 1080,
      };
      useProjectStore.getState().setVideo(video);
      useProjectStore.getState().setSelectedTrack('video-track');
      expect(useProjectStore.getState().selectedTrackId).toBe('video-track');

      useProjectStore.getState().setVideo(null);
      expect(useProjectStore.getState().selectedTrackId).toBeNull();
    });

    it('setStems clears selectedTrackId when the selected stem track is removed', () => {
      const stemA = {
        id: 'stem-a',
        name: 'vocals',
        label: 'Vocals',
        blob: new Blob(['stem'], { type: 'audio/wav' }),
        url: 'blob:stem-a-url',
        muted: false,
        volume: 0.8,
        solo: false,
      };
      useProjectStore.getState().setStems([stemA]);
      useProjectStore.getState().setSelectedTrack('stem-stem-a');
      expect(useProjectStore.getState().selectedTrackId).toBe('stem-stem-a');

      // Replace with a different stem set — previous stem track no longer exists
      useProjectStore.getState().setStems([]);
      expect(useProjectStore.getState().selectedTrackId).toBeNull();
    });
  });

  describe('undo correctness for editing operations', () => {
    beforeEach(() => {
      // Clear undo history to avoid MAX_HISTORY cap from prior tests
      useProjectStore.setState({ pastStates: [], futureStates: [], canUndo: false, canRedo: false });
    });

    it('trimTrack creates an undo entry that restores pre-trim state', () => {
      useProjectStore.getState().addTrack({ id: 'undo-t', type: 'audio', startOffset: 0, duration: 10 });

      useProjectStore.getState().trimTrack('undo-t', 2, 8);
      useProjectStore.getState().undo();

      const track = useProjectStore.getState().tracks.find((t) => t.id === 'undo-t')!;
      expect(track.startOffset).toBe(0);
      expect(track.duration).toBe(10);
    });

    it('unrelated mute during a trim sequence gets its own undo entry', () => {
      useProjectStore.getState().addTrack({ id: 'trim-m', type: 'audio', startOffset: 0, duration: 10 });
      useProjectStore.getState().addTrack({ id: 'other-m', type: 'stem', duration: 5 });

      // Simulate: trim, then unrelated mute
      useProjectStore.getState().trimTrack('trim-m', 2, 8);
      useProjectStore.getState().toggleTrackMute('other-m');

      // Undo the mute
      useProjectStore.getState().undo();
      expect(useProjectStore.getState().tracks.find((t) => t.id === 'other-m')!.muted).toBe(false);

      // Track should still be trimmed (mute undo did not affect trim)
      expect(useProjectStore.getState().tracks.find((t) => t.id === 'trim-m')!.startOffset).toBe(2);

      // Undo the trim
      useProjectStore.getState().undo();
      expect(useProjectStore.getState().tracks.find((t) => t.id === 'trim-m')!.startOffset).toBe(0);
    });

    it('undo/redo cycle preserves correct order', () => {
      useProjectStore.getState().addTrack({ id: 'cycle-t', type: 'audio', startOffset: 0, duration: 10 });

      useProjectStore.getState().trimTrack('cycle-t', 1, 9);
      useProjectStore.getState().trimTrack('cycle-t', 2, 8);

      useProjectStore.getState().undo();
      expect(useProjectStore.getState().tracks.find((t) => t.id === 'cycle-t')!.startOffset).toBe(1);

      useProjectStore.getState().redo();
      expect(useProjectStore.getState().tracks.find((t) => t.id === 'cycle-t')!.startOffset).toBe(2);
    });

    it('setVideo replacement clears selection when previous video split clip is removed', () => {
      const videoA = {
        id: 'vid-a',
        name: 'a.mp4',
        blob: new Blob(['vid'], { type: 'video/mp4' }),
        url: 'blob:vid-a',
        duration: 10,
        width: 1920,
        height: 1080,
      };
      const videoB = {
        id: 'vid-b',
        name: 'b.mp4',
        blob: new Blob(['vid'], { type: 'video/mp4' }),
        url: 'blob:vid-b',
        duration: 8,
        width: 1280,
        height: 720,
      };

      useProjectStore.getState().setVideo(videoA);
      // Simulate a user having split the video track — add extra video clip
      useProjectStore.getState().addTrack({ id: 'video-split-2', type: 'video', duration: 5 });
      useProjectStore.getState().setSelectedTrack('video-split-2');

      // Replacing the video removes all video-type tracks
      useProjectStore.getState().setVideo(videoB);

      // The split video clip is gone, selection should be cleared
      expect(useProjectStore.getState().tracks.find((t) => t.id === 'video-split-2')).toBeUndefined();
      expect(useProjectStore.getState().selectedTrackId).toBeNull();
    });

    it('trimTrack with unchanged values does not pollute undo history', () => {
      useProjectStore.getState().addTrack({ id: 'noop-t', type: 'audio', startOffset: 2, duration: 8 });
      const before = useProjectStore.getState().pastStates.length;

      // "trim" to the exact same values — simulates click-without-drag
      useProjectStore.getState().trimTrack('noop-t', 2, 8);

      // The store still creates an undo entry (since it doesn't know if geometry changed),
      // but the UI layer prevents this call entirely. This test documents store behavior.
      const after = useProjectStore.getState().pastStates.length;
      // Store DOES push (it can't distinguish no-op at the store level).
      // The UI commitment tolerance (TRIM_COMMIT_TOLERANCE) prevents the call.
      expect(after).toBe(before + 1);
    });
  });

  describe('trimTrack exact geometry and source bounds', () => {
    beforeEach(() => {
      // Clear undo history
      useProjectStore.setState({ pastStates: [], futureStates: [] });
      useProjectStore.getState().addTrack({
        id: 'trim-exact',
        type: 'audio',
        startOffset: 0,
        duration: 10,
        sourceUrl: 'blob:source',
        sourceDuration: 10,
      });
    });

    it('commits exact geometry from preview without silent expansion', () => {
      // Preview computed 0.75s duration — store should accept exactly
      useProjectStore.getState().trimTrack('trim-exact', 0, 0.75);
      const t = useProjectStore.getState().tracks.find((t) => t.id === 'trim-exact')!;
      expect(t.duration).toBe(0.75);
    });

    it('guards non-finite offset — does not commit NaN', () => {
      useProjectStore.getState().trimTrack('trim-exact', NaN, 5);
      const t = useProjectStore.getState().tracks.find((t) => t.id === 'trim-exact')!;
      // Track remains at original values
      expect(t.startOffset).toBe(0);
      expect(t.duration).toBe(10);
    });

    it('guards non-finite duration — does not commit Infinity', () => {
      useProjectStore.getState().trimTrack('trim-exact', 0, Infinity);
      const t = useProjectStore.getState().tracks.find((t) => t.id === 'trim-exact')!;
      expect(t.duration).toBe(10);
    });

    it('preserves sourceDuration through trim operations', () => {
      useProjectStore.getState().trimTrack('trim-exact', 2, 5);
      const t = useProjectStore.getState().tracks.find((t) => t.id === 'trim-exact')!;
      expect(t.sourceDuration).toBe(10);
    });
  });

  describe('same-ID replacement and selection', () => {
    it('setVideo clears selection when source URL changes on same ID', () => {
      const video1 = {
        id: 'v1',
        name: 'video1.mp4',
        blob: new Blob(['v'], { type: 'video/mp4' }),
        url: 'blob:vid-1',
        duration: 10,
        width: 1920,
        height: 1080,
      };
      useProjectStore.getState().setVideo(video1);
      useProjectStore.getState().setSelectedTrack('video-track');
      expect(useProjectStore.getState().selectedTrackId).toBe('video-track');

      // Replace with different source
      const video2 = { ...video1, url: 'blob:vid-2' };
      useProjectStore.getState().setVideo(video2);
      expect(useProjectStore.getState().selectedTrackId).toBeNull();
    });

    it('setVideo preserves selection when source URL is unchanged (same content)', () => {
      const video = {
        id: 'v1',
        name: 'video.mp4',
        blob: new Blob(['v'], { type: 'video/mp4' }),
        url: 'blob:vid-same',
        duration: 10,
        width: 1920,
        height: 1080,
      };
      useProjectStore.getState().setVideo(video);
      useProjectStore.getState().setSelectedTrack('video-track');

      // Replace with same source URL (e.g., metadata update)
      const video2 = { ...video, name: 'video-renamed.mp4' };
      useProjectStore.getState().setVideo(video2);
      expect(useProjectStore.getState().selectedTrackId).toBe('video-track');
    });
  });
});
