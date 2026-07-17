const DEFAULT_SAMPLE_RATE = 44_100;

function createAudioContext() {
  return new AudioContext({ sampleRate: DEFAULT_SAMPLE_RATE });
}

function createSilentBuffer(context: AudioContext, totalDuration: number) {
  const duration = Math.max(totalDuration, 0.5);
  return context.createBuffer(2, Math.ceil(duration * context.sampleRate), context.sampleRate);
}

export interface MixTrackInput {
  url: string;
  /** Timeline position (seconds) where the clip starts. */
  offset: number;
  volume: number;
  muted: boolean;
  /** Seconds into the source media where the clip begins. Defaults to 0. */
  sourceStartOffset?: number;
  /** Clip duration on the timeline. Defaults to the rest of the source buffer. */
  duration?: number;
}

export async function mixAudioTracks(
  tracks: MixTrackInput[],
  totalDuration: number,
): Promise<AudioBuffer> {
  const context = createAudioContext();

  try {
    const activeTracks = tracks.filter((track) => !track.muted && track.url);

    if (activeTracks.length === 0) {
      return createSilentBuffer(context, totalDuration);
    }

    const decodedTracks = await Promise.all(
      activeTracks.map(async (track) => {
        const response = await fetch(track.url);

        if (!response.ok) {
          throw new Error(`Failed to fetch audio source: ${response.status}`);
        }

        const data = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(data.slice(0));
        const sourceStartOffset = Math.max(track.sourceStartOffset ?? 0, 0);
        const availableFromSource = Math.max(buffer.duration - sourceStartOffset, 0);
        const playDuration = Math.max(Math.min(track.duration ?? availableFromSource, availableFromSource), 0);

        return {
          ...track,
          buffer,
          sourceStartOffset,
          playDuration,
        };
      }),
    );

    const duration = Math.max(
      totalDuration,
      0.5,
      ...decodedTracks.map((track) => Math.max(track.offset, 0) + track.playDuration),
    );

    const offlineContext = new OfflineAudioContext(2, Math.ceil(duration * context.sampleRate), context.sampleRate);

    decodedTracks.forEach((track) => {
      if (track.playDuration <= 0) {
        return;
      }

      const source = offlineContext.createBufferSource();
      source.buffer = track.buffer;

      const gain = offlineContext.createGain();
      gain.gain.value = track.volume;

      source.connect(gain);
      gain.connect(offlineContext.destination);

      // (when, offset, duration): start at the timeline position, read from the
      // clip's source in-point, and stop at the clip's trimmed duration.
      source.start(Math.max(track.offset, 0), track.sourceStartOffset, track.playDuration);
    });

    const output = await offlineContext.startRendering();

    for (let channelIndex = 0; channelIndex < output.numberOfChannels; channelIndex += 1) {
      const channel = output.getChannelData(channelIndex);

      for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex += 1) {
        channel[sampleIndex] = Math.max(-1, Math.min(1, channel[sampleIndex]));
      }
    }

    return output;
  } finally {
    await context.close();
  }
}

export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const channelCount = buffer.numberOfChannels;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = buffer.length * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;

  for (let sampleIndex = 0; sampleIndex < buffer.length; sampleIndex += 1) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const sample = buffer.getChannelData(channelIndex)[sampleIndex];
      const normalized = Math.max(-1, Math.min(1, sample));
      const value = normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff;
      view.setInt16(offset, value, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
