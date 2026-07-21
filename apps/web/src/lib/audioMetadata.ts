export interface EncodedAudioMetadata {
  channels: number;
  durationSeconds: number;
  sampleRate: number;
}

const MAX_CONTAINER_ELEMENTS = 10_000;
const MAX_CODEC_HEADER_BYTES = 64 * 1024;

function fail(message: string): never {
  throw new Error(`Unsupported or malformed audio container: ${message}`);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) {
    fail('truncated text field');
  }
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function validateMetadata(metadata: EncodedAudioMetadata): EncodedAudioMetadata {
  if (
    !Number.isSafeInteger(metadata.channels) ||
    metadata.channels <= 0 ||
    metadata.channels > 32
  ) {
    fail('invalid channel count');
  }
  if (
    !Number.isFinite(metadata.sampleRate) ||
    metadata.sampleRate < 1_000 ||
    metadata.sampleRate > 768_000
  ) {
    fail('invalid sample rate');
  }
  if (!Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0) {
    fail('invalid duration');
  }
  return metadata;
}

function parseWave(bytes: Uint8Array, view: DataView): EncodedAudioMetadata {
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let dataBytes = -1;

  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + chunkSize;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) {
      fail('truncated WAVE chunk');
    }

    if (chunkType === 'fmt ') {
      if (chunkSize < 16) {
        fail('truncated WAVE format chunk');
      }
      const format = view.getUint16(dataOffset, true);
      channels = view.getUint16(dataOffset + 2, true);
      sampleRate = view.getUint32(dataOffset + 4, true);
      blockAlign = view.getUint16(dataOffset + 12, true);
      let supportedFormat = format === 1 || format === 3;
      if (format === 0xfffe && chunkSize >= 40) {
        const subFormat = view.getUint16(dataOffset + 24, true);
        supportedFormat = subFormat === 1 || subFormat === 3;
      }
      if (!supportedFormat) {
        fail('compressed WAVE audio is not supported for auto-sync');
      }
    } else if (chunkType === 'data') {
      dataBytes = chunkSize;
    }

    offset = chunkEnd + (chunkSize & 1);
  }

  if (!channels || !sampleRate || !blockAlign || dataBytes < 0 || dataBytes % blockAlign !== 0) {
    fail('incomplete WAVE metadata');
  }
  return validateMetadata({
    channels,
    durationSeconds: dataBytes / blockAlign / sampleRate,
    sampleRate,
  });
}

function parseFlac(bytes: Uint8Array, view: DataView): EncodedAudioMetadata {
  const blockLength = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  if (bytes.byteLength < 42 || (bytes[4] & 0x7f) !== 0 || blockLength !== 34) {
    fail('missing FLAC STREAMINFO block');
  }
  const streamInfo = 8;
  const packed = view.getUint32(streamInfo + 10);
  const sampleRate = packed >>> 12;
  const channels = ((packed >>> 9) & 0x07) + 1;
  const totalSamples = (packed & 0x0f) * 0x1_0000_0000 + view.getUint32(streamInfo + 14);
  return validateMetadata({
    channels,
    durationSeconds: totalSamples / sampleRate,
    sampleRate,
  });
}

function readUint64LE(view: DataView, offset: number): number | null {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  if (low === 0xffffffff && high === 0xffffffff) {
    return null;
  }
  const value = high * 0x1_0000_0000 + low;
  return Number.isSafeInteger(value) ? value : fail('Ogg granule position is too large');
}

function parseOgg(bytes: Uint8Array, view: DataView): EncodedAudioMetadata {
  const firstPacket: number[] = [];
  let packetComplete = false;
  let lastGranule: number | null = null;

  for (let offset = 0; offset < bytes.byteLength;) {
    if (offset + 27 > bytes.byteLength || ascii(bytes, offset, 4) !== 'OggS') {
      fail('invalid Ogg page');
    }
    const segmentCount = bytes[offset + 26];
    const tableOffset = offset + 27;
    const payloadOffset = tableOffset + segmentCount;
    if (payloadOffset > bytes.byteLength) {
      fail('truncated Ogg segment table');
    }
    let payloadBytes = 0;
    for (let i = 0; i < segmentCount; i++) {
      payloadBytes += bytes[tableOffset + i];
    }
    const pageEnd = payloadOffset + payloadBytes;
    if (pageEnd > bytes.byteLength) {
      fail('truncated Ogg page');
    }

    const granule = readUint64LE(view, offset + 6);
    if (granule !== null) {
      lastGranule = granule;
    }
    if (!packetComplete) {
      let payloadCursor = payloadOffset;
      for (let i = 0; i < segmentCount && !packetComplete; i++) {
        const lace = bytes[tableOffset + i];
        if (firstPacket.length + lace > MAX_CODEC_HEADER_BYTES) {
          fail('Ogg codec header is too large');
        }
        for (const byte of bytes.subarray(payloadCursor, payloadCursor + lace)) {
          firstPacket.push(byte);
        }
        payloadCursor += lace;
        packetComplete = lace < 255;
      }
    }
    offset = pageEnd;
  }

  const packet = Uint8Array.from(firstPacket);
  if (!packetComplete || lastGranule === null) {
    fail('incomplete Ogg metadata');
  }
  if (packet.byteLength >= 19 && ascii(packet, 0, 8) === 'OpusHead') {
    const packetView = new DataView(packet.buffer);
    const channels = packet[9];
    const preSkip = packetView.getUint16(10, true);
    const inputSampleRate = packetView.getUint32(12, true);
    return validateMetadata({
      channels,
      durationSeconds: Math.max(0, lastGranule - preSkip) / 48_000,
      sampleRate: inputSampleRate || 48_000,
    });
  }
  if (packet.byteLength >= 16 && packet[0] === 1 && ascii(packet, 1, 6) === 'vorbis') {
    const packetView = new DataView(packet.buffer);
    const channels = packet[11];
    const sampleRate = packetView.getUint32(12, true);
    return validateMetadata({
      channels,
      durationSeconds: lastGranule / sampleRate,
      sampleRate,
    });
  }
  fail('unsupported Ogg codec');
}

interface Mp3Frame {
  channels: number;
  frameBytes: number;
  sampleRate: number;
  samples: number;
}

function parseMp3Frame(view: DataView, offset: number): Mp3Frame | null {
  if (offset + 4 > view.byteLength) {
    return null;
  }
  const header = view.getUint32(offset);
  if ((header & 0xffe00000) !== 0xffe00000) {
    return null;
  }
  const versionBits = (header >>> 19) & 0x03;
  const layerBits = (header >>> 17) & 0x03;
  const bitrateIndex = (header >>> 12) & 0x0f;
  const sampleRateIndex = (header >>> 10) & 0x03;
  if (
    versionBits === 1 ||
    layerBits !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  ) {
    return null;
  }

  const mpeg1 = versionBits === 3;
  const bitrateTable = mpeg1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const rateDivisor = mpeg1 ? 1 : versionBits === 2 ? 2 : 4;
  const sampleRate = [44_100, 48_000, 32_000][sampleRateIndex] / rateDivisor;
  const bitrate = bitrateTable[bitrateIndex];
  const padding = (header >>> 9) & 1;
  const frameBytes = Math.floor(((mpeg1 ? 144_000 : 72_000) * bitrate) / sampleRate) + padding;
  return {
    channels: ((header >>> 6) & 0x03) === 3 ? 1 : 2,
    frameBytes,
    sampleRate,
    samples: mpeg1 ? 1152 : 576,
  };
}

function synchsafe(bytes: Uint8Array, offset: number): number {
  if (
    [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]].some((b) => b > 0x7f)
  ) {
    fail('invalid ID3 size');
  }
  return (
    bytes[offset] * 0x20_0000 +
    bytes[offset + 1] * 0x4000 +
    bytes[offset + 2] * 0x80 +
    bytes[offset + 3]
  );
}

function parseMp3(bytes: Uint8Array, view: DataView): EncodedAudioMetadata {
  let offset = 0;
  if (bytes.byteLength >= 10 && ascii(bytes, 0, 3) === 'ID3') {
    offset = 10 + synchsafe(bytes, 6) + (bytes[5] & 0x10 ? 10 : 0);
  }

  let channels = 0;
  let sampleRate = 0;
  let totalSamples = 0;
  let frames = 0;
  while (offset + 4 <= bytes.byteLength) {
    const frame = parseMp3Frame(view, offset);
    if (!frame || frame.frameBytes < 4 || offset + frame.frameBytes > bytes.byteLength) {
      if (
        frames > 0 &&
        (bytes.byteLength - offset === 128 || bytes.subarray(offset).every((b) => b === 0))
      ) {
        break;
      }
      fail(frames ? 'invalid MP3 frame sequence' : 'missing MP3 frame');
    }
    if (frames && (frame.channels !== channels || frame.sampleRate !== sampleRate)) {
      fail('MP3 stream changes channel count or sample rate');
    }
    channels = frame.channels;
    sampleRate = frame.sampleRate;
    totalSamples += frame.samples;
    frames++;
    offset += frame.frameBytes;
  }
  if (!frames) {
    fail('missing MP3 frames');
  }
  return validateMetadata({
    channels,
    durationSeconds: totalSamples / sampleRate,
    sampleRate,
  });
}

function parseAdts(bytes: Uint8Array): EncodedAudioMetadata {
  const sampleRates = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
    7_350,
  ];
  let offset = 0;
  let channels = 0;
  let sampleRate = 0;
  let totalSamples = 0;
  let frames = 0;
  while (offset + 7 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf6) !== 0xf0) {
      fail('invalid ADTS frame');
    }
    const rate = sampleRates[(bytes[offset + 2] >>> 2) & 0x0f];
    const frameChannels = ((bytes[offset + 2] & 1) << 2) | (bytes[offset + 3] >>> 6);
    const frameBytes =
      ((bytes[offset + 3] & 0x03) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >>> 5);
    if (!rate || !frameChannels || frameBytes < 7 || offset + frameBytes > bytes.byteLength) {
      fail('invalid ADTS metadata');
    }
    if (frames && (rate !== sampleRate || frameChannels !== channels)) {
      fail('ADTS stream changes channel count or sample rate');
    }
    sampleRate = rate;
    channels = frameChannels;
    totalSamples += 1024 * ((bytes[offset + 6] & 0x03) + 1);
    frames++;
    offset += frameBytes;
  }
  if (!frames || offset !== bytes.byteLength) {
    fail('truncated ADTS stream');
  }
  return validateMetadata({
    channels,
    durationSeconds: totalSamples / sampleRate,
    sampleRate,
  });
}

interface IsoAtom {
  dataStart: number;
  end: number;
  type: string;
}

function readIsoAtoms(bytes: Uint8Array, view: DataView, start: number, end: number): IsoAtom[] {
  const atoms: IsoAtom[] = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) {
      fail('truncated ISO media atom');
    }
    let size = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    let headerBytes = 8;
    if (size === 1) {
      if (offset + 16 > end) {
        fail('truncated large ISO media atom');
      }
      const high = view.getUint32(offset + 8);
      const low = view.getUint32(offset + 12);
      size = high * 0x1_0000_0000 + low;
      headerBytes = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    const atomEnd = offset + size;
    if (!Number.isSafeInteger(atomEnd) || size < headerBytes || atomEnd > end) {
      fail('invalid ISO media atom size');
    }
    atoms.push({ dataStart: offset + headerBytes, end: atomEnd, type });
    if (atoms.length > MAX_CONTAINER_ELEMENTS) {
      fail('too many ISO media atoms');
    }
    offset = atomEnd;
  }
  return atoms;
}

function childAtom(atoms: IsoAtom[], type: string): IsoAtom {
  return atoms.find((atom) => atom.type === type) ?? fail(`missing ${type} atom`);
}

function parseIsoMedia(bytes: Uint8Array, view: DataView): EncodedAudioMetadata {
  const moov = childAtom(readIsoAtoms(bytes, view, 0, bytes.byteLength), 'moov');
  for (const trak of readIsoAtoms(bytes, view, moov.dataStart, moov.end).filter(
    (atom) => atom.type === 'trak',
  )) {
    const mdia = childAtom(readIsoAtoms(bytes, view, trak.dataStart, trak.end), 'mdia');
    const mediaAtoms = readIsoAtoms(bytes, view, mdia.dataStart, mdia.end);
    const hdlr = childAtom(mediaAtoms, 'hdlr');
    if (hdlr.dataStart + 12 > hdlr.end || ascii(bytes, hdlr.dataStart + 8, 4) !== 'soun') {
      continue;
    }

    const mdhd = childAtom(mediaAtoms, 'mdhd');
    const version = bytes[mdhd.dataStart];
    const timeOffset = mdhd.dataStart + (version === 1 ? 20 : 12);
    const durationOffset = mdhd.dataStart + (version === 1 ? 24 : 16);
    if (version > 1 || durationOffset + (version === 1 ? 8 : 4) > mdhd.end) {
      fail('invalid media duration atom');
    }
    const timeScale = view.getUint32(timeOffset);
    const duration =
      version === 1
        ? view.getUint32(durationOffset) * 0x1_0000_0000 + view.getUint32(durationOffset + 4)
        : view.getUint32(durationOffset);

    const minf = childAtom(mediaAtoms, 'minf');
    const stbl = childAtom(readIsoAtoms(bytes, view, minf.dataStart, minf.end), 'stbl');
    const stsd = childAtom(readIsoAtoms(bytes, view, stbl.dataStart, stbl.end), 'stsd');
    const entryOffset = stsd.dataStart + 8;
    if (entryOffset + 36 > stsd.end || view.getUint32(stsd.dataStart + 4) < 1) {
      fail('invalid audio sample description');
    }
    const entryBytes = view.getUint32(entryOffset);
    if (entryBytes < 36 || entryOffset + entryBytes > stsd.end) {
      fail('truncated audio sample description');
    }
    const channels = view.getUint16(entryOffset + 24);
    const sampleRate = view.getUint32(entryOffset + 32) / 65_536;
    return validateMetadata({
      channels,
      durationSeconds: duration / timeScale,
      sampleRate,
    });
  }
  fail('ISO media file has no supported audio track');
}

interface EbmlVint {
  length: number;
  unknown: boolean;
  value: number;
}

function readEbmlVint(bytes: Uint8Array, offset: number, keepMarker: boolean): EbmlVint {
  if (offset >= bytes.byteLength || bytes[offset] === 0) {
    fail('invalid EBML variable integer');
  }
  let mask = 0x80;
  let length = 1;
  while (!(bytes[offset] & mask) && length <= 8) {
    mask >>>= 1;
    length++;
  }
  if (length > 8 || offset + length > bytes.byteLength) {
    fail('truncated EBML variable integer');
  }
  let value = keepMarker ? bytes[offset] : bytes[offset] & (mask - 1);
  let unknown = !keepMarker && (bytes[offset] & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[offset + i];
    unknown &&= bytes[offset + i] === 0xff;
  }
  if (!Number.isSafeInteger(value)) {
    fail('EBML integer is too large');
  }
  return { length, unknown, value };
}

interface EbmlElement {
  dataStart: number;
  end: number;
  id: number;
}

function readEbmlElements(bytes: Uint8Array, start: number, end: number): EbmlElement[] {
  const elements: EbmlElement[] = [];
  for (let offset = start; offset < end;) {
    const id = readEbmlVint(bytes, offset, true);
    const size = readEbmlVint(bytes, offset + id.length, false);
    const dataStart = offset + id.length + size.length;
    const elementEnd = size.unknown ? end : dataStart + size.value;
    if (!Number.isSafeInteger(elementEnd) || elementEnd > end || elementEnd < dataStart) {
      fail('invalid EBML element size');
    }
    elements.push({ dataStart, end: elementEnd, id: id.value });
    if (elements.length > MAX_CONTAINER_ELEMENTS) {
      fail('too many EBML elements');
    }
    offset = elementEnd;
  }
  return elements;
}

function readEbmlInteger(bytes: Uint8Array, element: EbmlElement): number {
  const length = element.end - element.dataStart;
  if (length < 1 || length > 6) {
    fail('invalid EBML integer width');
  }
  let value = 0;
  for (let i = element.dataStart; i < element.end; i++) {
    value = value * 256 + bytes[i];
  }
  return value;
}

function readEbmlFloat(view: DataView, element: EbmlElement): number {
  const length = element.end - element.dataStart;
  if (length === 4) {
    return view.getFloat32(element.dataStart);
  }
  if (length === 8) {
    return view.getFloat64(element.dataStart);
  }
  fail('invalid EBML float width');
}

function parseWebm(bytes: Uint8Array, view: DataView): EncodedAudioMetadata {
  const topLevel = readEbmlElements(bytes, 0, bytes.byteLength);
  const segment = topLevel.find((element) => element.id === 0x18538067);
  if (!segment) {
    fail('missing WebM segment');
  }
  const segmentChildren = readEbmlElements(bytes, segment.dataStart, segment.end);
  const info = segmentChildren.find((element) => element.id === 0x1549a966);
  const tracks = segmentChildren.find((element) => element.id === 0x1654ae6b);
  if (!info || !tracks) {
    fail('missing WebM info or tracks');
  }

  const infoChildren = readEbmlElements(bytes, info.dataStart, info.end);
  const scaleElement = infoChildren.find((element) => element.id === 0x2ad7b1);
  const durationElement = infoChildren.find((element) => element.id === 0x4489);
  if (!durationElement) {
    fail('missing WebM duration');
  }
  const timecodeScale = scaleElement ? readEbmlInteger(bytes, scaleElement) : 1_000_000;
  const durationSeconds = (readEbmlFloat(view, durationElement) * timecodeScale) / 1e9;

  for (const entry of readEbmlElements(bytes, tracks.dataStart, tracks.end).filter(
    (element) => element.id === 0xae,
  )) {
    const entryChildren = readEbmlElements(bytes, entry.dataStart, entry.end);
    const trackType = entryChildren.find((element) => element.id === 0x83);
    const audio = entryChildren.find((element) => element.id === 0xe1);
    if (!trackType || readEbmlInteger(bytes, trackType) !== 2 || !audio) {
      continue;
    }
    const audioChildren = readEbmlElements(bytes, audio.dataStart, audio.end);
    const rate = audioChildren.find((element) => element.id === 0xb5);
    const channelCount = audioChildren.find((element) => element.id === 0x9f);
    if (!rate || !channelCount) {
      fail('incomplete WebM audio metadata');
    }
    return validateMetadata({
      channels: readEbmlInteger(bytes, channelCount),
      durationSeconds,
      sampleRate: readEbmlFloat(view, rate),
    });
  }
  fail('WebM file has no audio track');
}

export function parseEncodedAudioMetadata(encoded: ArrayBuffer): EncodedAudioMetadata {
  const bytes = new Uint8Array(encoded);
  const view = new DataView(encoded);
  if (bytes.byteLength < 4) {
    fail('file is too short');
  }
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return parseWave(bytes, view);
  }
  if (ascii(bytes, 0, 4) === 'fLaC') {
    return parseFlac(bytes, view);
  }
  if (ascii(bytes, 0, 4) === 'OggS') {
    return parseOgg(bytes, view);
  }
  if (
    ascii(bytes, 0, 3) === 'ID3' ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0xf6) !== 0xf0)
  ) {
    return parseMp3(bytes, view);
  }
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return parseAdts(bytes);
  }
  if (view.getUint32(0) === 0x1a45dfa3) {
    return parseWebm(bytes, view);
  }
  if (
    bytes.byteLength >= 8 &&
    ['ftyp', 'moov', 'wide', 'free', 'mdat'].includes(ascii(bytes, 4, 4))
  ) {
    return parseIsoMedia(bytes, view);
  }
  fail('format cannot be safely inspected before decoding');
}
