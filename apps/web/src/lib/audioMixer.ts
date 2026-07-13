const DEFAULT_SAMPLE_RATE = 44_100;

function createAudioContext() {
  return new AudioContext({ sampleRate: DEFAULT_SAMPLE_RATE });
}

function createSilentBuffer(context: AudioContext, totalDuration: number) {
  const duration = Math.max(totalDuration, 0.5);
  return context.createBuffer(2, Math.ceil(duration * context.sampleRate), context.sampleRate);
}

export async function mixAudioTracks(
  tracks: Array<{ url: string; offset: number; volume: number; muted: boolean }>,
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

        return {
          ...track,
          buffer,
        };
      }),
    );

    const duration = Math.max(
      totalDuration,
      ...decodedTracks.map((track) => Math.max(track.offset, 0) + track.buffer.duration),
    );
    const output = context.createBuffer(2, Math.ceil(duration * context.sampleRate), context.sampleRate);

    decodedTracks.forEach((track) => {
      const startFrame = Math.round(Math.max(track.offset, 0) * output.sampleRate);

      for (let channelIndex = 0; channelIndex < output.numberOfChannels; channelIndex += 1) {
        const target = output.getChannelData(channelIndex);
        const source = track.buffer.getChannelData(Math.min(channelIndex, track.buffer.numberOfChannels - 1));

        for (let sampleIndex = 0; sampleIndex < source.length; sampleIndex += 1) {
          const outputIndex = startFrame + sampleIndex;

          if (outputIndex >= target.length) {
            break;
          }

          target[outputIndex] += source[sampleIndex] * track.volume;
        }
      }
    });

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
