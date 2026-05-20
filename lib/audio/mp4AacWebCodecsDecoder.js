const CONTAINER_BOX_TYPES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const METADATA_BOX_TYPES = new Set([
  'udta',
  'meta',
  'ilst',
  'keys',
  'data',
  'name',
  '©nam',
  '©ART',
  '©alb',
  '©day',
  '©gen',
  '©too',
  '©cmt',
  'desc',
  'ldes',
  'sonm',
  'soal',
  'soar',
  'soco',
  'sosn',
]);
const AAC_OBJECT_TYPE_BY_MPEG4_OBJECT = new Map([[0x40, 2]]);
const MAX_MP4_MOOV_BYTES = 128 * 1024 * 1024;
const FILE_SAMPLE_READ_GROUP_MAX_BYTES = 4 * 1024 * 1024;
const FILE_SAMPLE_READ_GROUP_MAX_GAP_BYTES = 256 * 1024;

function readType(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function readUint64(view, offset) {
  const high = view.getUint32(offset);
  const low = view.getUint32(offset + 4);
  return high * 2 ** 32 + low;
}

function parseBoxes(view, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = view.getUint32(offset);
    const type = readType(view, offset + 4);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (offset + 16 > end) break;
      size = readUint64(view, offset + 8);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      if (METADATA_BOX_TYPES.has(type)) break;
      break;
    }
    const box = { type, start: offset, headerSize, dataStart: offset + headerSize, end: offset + size };
    if (METADATA_BOX_TYPES.has(type)) {
      box.skipped = true;
    } else if (CONTAINER_BOX_TYPES.has(type)) {
      box.children = parseBoxes(view, box.dataStart, box.end);
    }
    boxes.push(box);
    offset += size;
  }
  return boxes;
}

function child(box, type) {
  return (box?.children || []).find((item) => item.type === type) || null;
}

function parseHandler(view, hdlrBox) {
  if (!hdlrBox || hdlrBox.dataStart + 12 > hdlrBox.end) return null;
  return readType(view, hdlrBox.dataStart + 8);
}

function parseMdhd(view, mdhdBox) {
  const version = view.getUint8(mdhdBox.dataStart);
  if (version === 1) {
    return {
      timescale: view.getUint32(mdhdBox.dataStart + 20),
      duration: readUint64(view, mdhdBox.dataStart + 24),
    };
  }
  return {
    timescale: view.getUint32(mdhdBox.dataStart + 12),
    duration: view.getUint32(mdhdBox.dataStart + 16),
  };
}

function parseDescriptorLength(bytes, offset, end) {
  let length = 0;
  let pos = offset;
  for (let i = 0; i < 4 && pos < end; i += 1) {
    const value = bytes[pos];
    pos += 1;
    length = (length << 7) | (value & 0x7f);
    if ((value & 0x80) === 0) break;
  }
  return { length, pos };
}

function parseEsds(view, esdsBox) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + esdsBox.dataStart + 4, esdsBox.end - esdsBox.dataStart - 4);
  let objectTypeIndication = 0;
  let description = null;

  function walk(start, end) {
    let pos = start;
    while (pos + 2 <= end) {
      const tag = bytes[pos];
      const lengthInfo = parseDescriptorLength(bytes, pos + 1, end);
      const dataStart = lengthInfo.pos;
      const dataEnd = Math.min(dataStart + lengthInfo.length, end);
      if (dataEnd <= dataStart || dataEnd > end) break;

      if (tag === 0x03) {
        let childStart = dataStart + 3;
        const flags = bytes[dataStart + 2] || 0;
        if (flags & 0x80) childStart += 2;
        if (flags & 0x40) childStart += 1 + (bytes[childStart] || 0);
        if (flags & 0x20) childStart += 2;
        walk(childStart, dataEnd);
      } else if (tag === 0x04) {
        objectTypeIndication = bytes[dataStart] || objectTypeIndication;
        walk(dataStart + 13, dataEnd);
      } else if (tag === 0x05) {
        description = bytes.slice(dataStart, dataEnd);
      }
      pos = dataEnd;
    }
  }

  walk(0, bytes.length);
  return { objectTypeIndication, description };
}

function parseAudioObjectType(description, objectTypeIndication) {
  if (description?.length) {
    const firstFiveBits = description[0] >> 3;
    if (firstFiveBits === 31 && description.length >= 2) {
      return 32 + (((description[0] & 0x07) << 3) | (description[1] >> 5));
    }
    return firstFiveBits;
  }
  return AAC_OBJECT_TYPE_BY_MPEG4_OBJECT.get(objectTypeIndication) || 2;
}

function parseStsd(view, stsdBox) {
  const entryCount = view.getUint32(stsdBox.dataStart + 4);
  let offset = stsdBox.dataStart + 8;
  for (let index = 0; index < entryCount && offset + 36 <= stsdBox.end; index += 1) {
    const entrySize = view.getUint32(offset);
    const entryType = readType(view, offset + 4);
    const entryEnd = offset + entrySize;
    if (entryType === 'mp4a') {
      const channelCount = view.getUint16(offset + 24) || 2;
      const sampleRate = view.getUint32(offset + 32) >>> 16;
      const childBoxes = parseBoxes(view, offset + 36, entryEnd);
      const esdsBox = childBoxes.find((box) => box.type === 'esds');
      if (!esdsBox) throw new Error('MP4 audio track is missing esds decoder config.');
      const esds = parseEsds(view, esdsBox);
      if (!esds.description?.length) throw new Error('MP4 audio track is missing AAC AudioSpecificConfig.');
      const audioObjectType = parseAudioObjectType(esds.description, esds.objectTypeIndication);
      return {
        channelCount,
        sampleRate,
        description: esds.description,
        codec: `mp4a.40.${audioObjectType}`,
      };
    }
    offset = entryEnd;
  }
  throw new Error('No supported mp4a audio sample entry found.');
}

function parseStts(view, sttsBox, sampleCount) {
  const durations = [];
  const entryCount = view.getUint32(sttsBox.dataStart + 4);
  let offset = sttsBox.dataStart + 8;
  for (let entry = 0; entry < entryCount; entry += 1) {
    const count = view.getUint32(offset);
    const duration = view.getUint32(offset + 4);
    for (let index = 0; index < count && durations.length < sampleCount; index += 1) durations.push(duration);
    offset += 8;
  }
  return durations;
}

function parseStsc(view, stscBox) {
  const entries = [];
  const entryCount = view.getUint32(stscBox.dataStart + 4);
  let offset = stscBox.dataStart + 8;
  for (let index = 0; index < entryCount; index += 1) {
    entries.push({
      firstChunk: view.getUint32(offset),
      samplesPerChunk: view.getUint32(offset + 4),
    });
    offset += 12;
  }
  return entries;
}

function parseStsz(view, stszBox) {
  const sampleSize = view.getUint32(stszBox.dataStart + 4);
  const sampleCount = view.getUint32(stszBox.dataStart + 8);
  if (sampleSize) return Array(sampleCount).fill(sampleSize);
  const sizes = [];
  let offset = stszBox.dataStart + 12;
  for (let index = 0; index < sampleCount; index += 1) {
    sizes.push(view.getUint32(offset));
    offset += 4;
  }
  return sizes;
}

function parseChunkOffsets(view, box) {
  const count = view.getUint32(box.dataStart + 4);
  const offsets = [];
  let offset = box.dataStart + 8;
  for (let index = 0; index < count; index += 1) {
    offsets.push(box.type === 'co64' ? readUint64(view, offset) : view.getUint32(offset));
    offset += box.type === 'co64' ? 8 : 4;
  }
  return offsets;
}

function buildSamples(sampleSizes, sampleDurations, chunkOffsets, stscEntries) {
  const samples = [];
  let sampleIndex = 0;
  let dts = 0;
  let stscIndex = 0;
  for (let chunkIndex = 1; chunkIndex <= chunkOffsets.length && sampleIndex < sampleSizes.length; chunkIndex += 1) {
    while (
      stscIndex + 1 < stscEntries.length
      && stscEntries[stscIndex + 1].firstChunk <= chunkIndex
    ) {
      stscIndex += 1;
    }
    const samplesPerChunk = stscEntries[stscIndex]?.samplesPerChunk || 0;
    let offset = chunkOffsets[chunkIndex - 1];
    for (let index = 0; index < samplesPerChunk && sampleIndex < sampleSizes.length; index += 1) {
      const size = sampleSizes[sampleIndex];
      const duration = sampleDurations[sampleIndex] || sampleDurations[sampleDurations.length - 1] || 1024;
      samples.push({ offset, size, dts, duration });
      offset += size;
      dts += duration;
      sampleIndex += 1;
    }
  }
  return samples;
}

function parseMp4Aac(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const root = { children: parseBoxes(view, 0, arrayBuffer.byteLength) };
  const moov = child(root, 'moov');
  if (!moov) throw new Error('MP4 moov box not found.');
  const tracks = (moov.children || []).filter((box) => box.type === 'trak');
  for (const trak of tracks) {
    const mdia = child(trak, 'mdia');
    if (parseHandler(view, child(mdia, 'hdlr')) !== 'soun') continue;
    const mdhd = parseMdhd(view, child(mdia, 'mdhd'));
    const stbl = child(child(mdia, 'minf'), 'stbl');
    if (!stbl) continue;
    const sampleEntry = parseStsd(view, child(stbl, 'stsd'));
    const sampleSizes = parseStsz(view, child(stbl, 'stsz'));
    const sampleDurations = parseStts(view, child(stbl, 'stts'), sampleSizes.length);
    const chunkOffsets = parseChunkOffsets(view, child(stbl, 'stco') || child(stbl, 'co64'));
    const stscEntries = parseStsc(view, child(stbl, 'stsc'));
    const samples = buildSamples(sampleSizes, sampleDurations, chunkOffsets, stscEntries);
    const durationTicks = mdhd.duration || samples.reduce((sum, sample) => sum + sample.duration, 0);
    return {
      ...sampleEntry,
      timescale: mdhd.timescale,
      durationSec: durationTicks / mdhd.timescale,
      samples,
    };
  }
  throw new Error('No supported AAC audio track found in MP4.');
}

async function readFileRange(file, start, end) {
  return file.slice(start, end).arrayBuffer();
}

async function readFileBoxHeader(file, offset) {
  const headerBuffer = await readFileRange(file, offset, Math.min(file.size, offset + 16));
  if (headerBuffer.byteLength < 8) return null;
  const view = new DataView(headerBuffer);
  const size32 = view.getUint32(0);
  const type = readType(view, 4);
  let size = size32;
  let headerSize = 8;
  if (size32 === 1) {
    if (headerBuffer.byteLength < 16) return null;
    size = readUint64(view, 8);
    headerSize = 16;
  } else if (size32 === 0) {
    size = file.size - offset;
  }
  if (size < headerSize || offset + size > file.size) return null;
  return { type, start: offset, headerSize, dataStart: offset + headerSize, end: offset + size, size };
}

async function readMp4MoovArrayBufferFromFile(file) {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const box = await readFileBoxHeader(file, offset);
    if (!box) break;
    if (box.type === 'moov') {
      if (box.size > MAX_MP4_MOOV_BYTES) {
        throw new Error(`MP4 moov box is too large (${Math.round(box.size / 1024 / 1024)} MB).`);
      }
      return readFileRange(file, box.start, box.end);
    }
    offset = box.end;
  }
  throw new Error('MP4 moov box not found.');
}

export async function loadM4aAudioSourceFromFile(file) {
  const moovBuffer = await readMp4MoovArrayBufferFromFile(file);
  return parseMp4Aac(moovBuffer);
}

export async function getM4aAudioInfoFromFile(file) {
  const parsed = await loadM4aAudioSourceFromFile(file);
  return {
    codec: parsed.codec,
    sampleRate: parsed.sampleRate,
    numberOfChannels: parsed.channelCount,
    durationSec: parsed.durationSec,
  };
}

function selectSamples(samples, timescale, startSec = 0, endSec = Infinity) {
  const startTicks = Math.max(0, startSec) * timescale;
  const endTicks = Number.isFinite(endSec) ? Math.max(startSec, endSec) * timescale : Infinity;
  return samples.filter((sample) => sample.dts + sample.duration > startTicks && sample.dts < endTicks);
}

function groupSamplesForFileReads(samples) {
  const groups = [];
  let current = null;
  for (const sample of samples) {
    const sampleStart = sample.offset;
    const sampleEnd = sample.offset + sample.size;
    if (
      !current
      || sampleStart < current.start
      || sampleStart - current.end > FILE_SAMPLE_READ_GROUP_MAX_GAP_BYTES
      || sampleEnd - current.start > FILE_SAMPLE_READ_GROUP_MAX_BYTES
    ) {
      current = { start: sampleStart, end: sampleEnd, samples: [] };
      groups.push(current);
    } else {
      current.end = Math.max(current.end, sampleEnd);
    }
    current.samples.push(sample);
  }
  return groups;
}

async function audioDataToAudioBuffer(audioContext, audioDataList) {
  if (!audioDataList.length) throw new Error('WebCodecs decoded no audio frames.');
  const sampleRate = audioDataList[0].sampleRate;
  const numberOfChannels = audioDataList[0].numberOfChannels;
  const totalFrames = audioDataList.reduce((sum, audioData) => sum + audioData.numberOfFrames, 0);
  const audioBuffer = audioContext.createBuffer(numberOfChannels, totalFrames, sampleRate);
  let writeOffset = 0;
  for (const audioData of audioDataList) {
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const plane = new Float32Array(audioData.numberOfFrames);
      await audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
      audioBuffer.copyToChannel(plane, channel, writeOffset);
    }
    writeOffset += audioData.numberOfFrames;
    audioData.close();
  }
  return audioBuffer;
}

async function decodeSelectedAacSamples(parsed, selectedSamples, {
  audioContext,
  decoderName,
  decodedRequestedRange = true,
  sampleDataProvider,
}) {
  if (!globalThis.AudioDecoder || !globalThis.EncodedAudioChunk) {
    throw new Error('WebCodecs AudioDecoder is not available in this browser context.');
  }
  if (!selectedSamples.length) throw new Error('No AAC samples found in this file.');
  const decodedStartSec = selectedSamples[0].dts / parsed.timescale;
  const config = {
    codec: parsed.codec,
    sampleRate: parsed.sampleRate,
    numberOfChannels: parsed.channelCount,
    description: parsed.description,
  };
  const support = await AudioDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`WebCodecs does not support ${parsed.codec}.`);

  const audioDataList = [];
  let decodeError = null;
  const decoder = new AudioDecoder({
    output: (audioData) => audioDataList.push(audioData),
    error: (error) => { decodeError = error; },
  });
  decoder.configure(support.config);
  for (const sample of selectedSamples) {
    const data = await sampleDataProvider(sample);
    decoder.decode(new EncodedAudioChunk({
      type: 'key',
      timestamp: Math.round((sample.dts / parsed.timescale) * 1_000_000),
      duration: Math.round((sample.duration / parsed.timescale) * 1_000_000),
      data,
    }));
  }
  await decoder.flush();
  decoder.close();
  if (decodeError) throw decodeError;

  return {
    audioBuffer: await audioDataToAudioBuffer(audioContext, audioDataList),
    decodedStartSec,
    sourceDurationSec: parsed.durationSec,
    decoderName: `${decoderName || `WebCodecs ${parsed.codec}`}${decodedRequestedRange ? '' : ' full-file fallback'}`,
  };
}

export async function decodeM4aWithWebCodecs(arrayBuffer, {
  audioContext,
  startSec = 0,
  endSec = null,
  allowFullFileFallback = true,
} = {}) {
  const parsed = parseMp4Aac(arrayBuffer);
  let selectedSamples = selectSamples(parsed.samples, parsed.timescale, startSec, endSec ?? parsed.durationSec);
  let decodedRequestedRange = true;
  if (!selectedSamples.length && allowFullFileFallback && parsed.samples.length) {
    selectedSamples = parsed.samples;
    decodedRequestedRange = false;
  }
  return decodeSelectedAacSamples(parsed, selectedSamples, {
    audioContext,
    decodedRequestedRange,
    decoderName: `WebCodecs ${parsed.codec}`,
    sampleDataProvider: async (sample) => new Uint8Array(arrayBuffer, sample.offset, sample.size),
  });
}

export async function decodeM4aFileWithWebCodecs(file, audioSource, {
  audioContext,
  startSec = 0,
  endSec = null,
  allowFullFileFallback = false,
} = {}) {
  const parsed = audioSource || await loadM4aAudioSourceFromFile(file);
  let selectedSamples = selectSamples(parsed.samples, parsed.timescale, startSec, endSec ?? parsed.durationSec);
  let decodedRequestedRange = true;
  if (!selectedSamples.length && allowFullFileFallback && parsed.samples.length) {
    selectedSamples = parsed.samples;
    decodedRequestedRange = false;
  }
  const groups = groupSamplesForFileReads(selectedSamples);
  const sampleBuffers = new Map();
  for (const group of groups) {
    const groupBuffer = await readFileRange(file, group.start, group.end);
    for (const sample of group.samples) {
      sampleBuffers.set(sample, new Uint8Array(groupBuffer, sample.offset - group.start, sample.size));
    }
  }
  return decodeSelectedAacSamples(parsed, selectedSamples, {
    audioContext,
    decodedRequestedRange,
    decoderName: `WebCodecs ${parsed.codec} file-range`,
    sampleDataProvider: async (sample) => sampleBuffers.get(sample),
  });
}

export function getM4aAudioInfo(arrayBuffer) {
  const parsed = parseMp4Aac(arrayBuffer);
  return {
    codec: parsed.codec,
    sampleRate: parsed.sampleRate,
    numberOfChannels: parsed.channelCount,
    durationSec: parsed.durationSec,
  };
}

export const __test__ = { parseMp4Aac };
