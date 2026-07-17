export interface StemResult {
  name: string;
  label: string;
  blob: Blob;
  url: string;
}

interface StemDefinition {
  name: string;
  label: string;
  connectGraph: (
    context: OfflineAudioContext,
    source: AudioBufferSourceNode,
    destination: AudioDestinationNode,
  ) => void;
}

function writeString(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function encodeAudioBufferToWavBlob(audioBuffer: AudioBuffer): Blob {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numberOfChannels * bytesPerSample;
  const dataLength = audioBuffer.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;

  for (let sampleIndex = 0; sampleIndex < audioBuffer.length; sampleIndex += 1) {
    for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex += 1) {
      const sample = audioBuffer.getChannelData(channelIndex)[sampleIndex] ?? 0;
      const clampedSample = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function renderStem(
  audioBuffer: AudioBuffer,
  definition: StemDefinition,
): Promise<StemResult> {
  const context = new OfflineAudioContext(
    audioBuffer.numberOfChannels,
    audioBuffer.length,
    audioBuffer.sampleRate,
  );
  const source = context.createBufferSource();
  source.buffer = audioBuffer;

  definition.connectGraph(context, source, context.destination);
  source.start(0);

  const renderedBuffer = await context.startRendering();
  const blob = encodeAudioBufferToWavBlob(renderedBuffer);

  return {
    name: definition.name,
    label: definition.label,
    blob,
    url: URL.createObjectURL(blob),
  };
}

const STEM_DEFINITIONS: StemDefinition[] = [
  {
    name: 'vocals',
    label: 'Vocals',
    connectGraph: (context, source, destination) => {
      const highpass = context.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 300;

      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 4000;

      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(destination);
    },
  },
  {
    name: 'drums',
    label: 'Drums',
    connectGraph: (context, source, destination) => {
      const sparkleHighpass = context.createBiquadFilter();
      sparkleHighpass.type = 'highpass';
      sparkleHighpass.frequency.value = 4000;

      const lowKickPass = context.createBiquadFilter();
      lowKickPass.type = 'lowpass';
      lowKickPass.frequency.value = 180;

      const sparkleGain = context.createGain();
      sparkleGain.gain.value = 0.8;

      const kickGain = context.createGain();
      kickGain.gain.value = 0.7;

      source.connect(sparkleHighpass);
      sparkleHighpass.connect(sparkleGain);
      sparkleGain.connect(destination);

      source.connect(lowKickPass);
      lowKickPass.connect(kickGain);
      kickGain.connect(destination);
    },
  },
  {
    name: 'bass',
    label: 'Bass',
    connectGraph: (context, source, destination) => {
      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 250;

      source.connect(lowpass);
      lowpass.connect(destination);
    },
  },
  {
    name: 'guitar',
    label: 'Guitar',
    connectGraph: (context, source, destination) => {
      const highpass = context.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 200;

      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 2000;

      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(destination);
    },
  },
];

export async function separateStems(
  audioBuffer: AudioBuffer,
  onProgress?: (progress: number) => void,
): Promise<StemResult[]> {
  const results: StemResult[] = [];

  onProgress?.(0);

  for (const [index, definition] of STEM_DEFINITIONS.entries()) {
    const progressStart = Math.round((index / STEM_DEFINITIONS.length) * 100);
    onProgress?.(progressStart);

    const stem = await renderStem(audioBuffer, definition);
    results.push(stem);

    const progressEnd = Math.round(((index + 1) / STEM_DEFINITIONS.length) * 100);
    onProgress?.(progressEnd);
  }

  return results;
}
