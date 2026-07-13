/**
 * Timeline — Core timeline model for the sori-cut editor.
 */
export interface Clip {
  id: string;
  type: 'audio' | 'video';
  startTime: number;
  duration: number;
  sourceUrl: string;
}

export interface Track {
  id: string;
  name: string;
  clips: Clip[];
  muted: boolean;
  volume: number;
}

export class Timeline {
  tracks: Track[] = [];
  duration = 0;

  addTrack(name: string): Track {
    const track: Track = {
      id: crypto.randomUUID(),
      name,
      clips: [],
      muted: false,
      volume: 1,
    };
    this.tracks.push(track);
    return track;
  }

  removeTrack(id: string): void {
    this.tracks = this.tracks.filter((t) => t.id !== id);
  }
}
