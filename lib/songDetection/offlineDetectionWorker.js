/* global importScripts */

importScripts('../vendor/onnxruntime/ort.min.js');

const DEFAULT_CHUNK_SEC = 20;
const DEFAULT_MIN_SEGMENT_DURATION_SEC = 90;
const AEGISUB_SPECTRUM_DERIVATION_SIZE = 9;
const AEGISUB_SPECTRUM_DERIVATION_DIST = 9;
const AEGISUB_SPECTRUM_DERIVATION_DIST_STANDARD = 10;
const SPECTROGRAM_FFT_SIZE = 2 << AEGISUB_SPECTRUM_DERIVATION_SIZE;
const SPECTROGRAM_BIN_COUNT = 1 << AEGISUB_SPECTRUM_DERIVATION_SIZE;
const DEFAULT_SPECTROGRAM_MAX_COLUMNS = 120000;
const HIGH_RES_SPECTROGRAM_MAX_COLUMNS = 240000;
const DEFAULT_WAVEFORM_PEAKS_PER_SEC = 250;
const HIGH_RES_WAVEFORM_PEAKS_PER_SEC = 1000;
const DEFAULT_WAVEFORM_MAX_PEAKS = 900000;
const HIGH_RES_WAVEFORM_MAX_PEAKS = 1800000;
const WAVEFORM_VALUE_SCALE = 32767;
const AEGISUB_MAX_FREQUENCY_HZ = 8000;
const AEGISUB_REFERENCE_FREQUENCY_HZ = 1000;
const AEGISUB_REFERENCE_POSITION = 0.42;
const AEGISUB_VALUE_SCALE = 255;

let modulesPromise = null;

function loadModules() {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import('./fireredAedDetector.js'),
      import('./globalSmoothing.js'),
      import('./boundaryDetector.js'),
    ]).then(([firered, smoothing, boundary]) => ({
      FireRedAedOfflineAnalyzer: firered.FireRedAedOfflineAnalyzer,
      smoothFireRedAnalyses: smoothing.smoothFireRedAnalyses,
      splitSongSegmentsByBoundaries: boundary.splitSongSegmentsByBoundaries,
    }));
  }
  return modulesPromise;
}

function post(jobId, type, payload = {}, transfer = []) {
  self.postMessage({ jobId, type, ...payload }, transfer);
}

function collectVisualTransferables(visual) {
  const transfer = [];
  for (const key of ['min', 'max', 'avgMin', 'avgMax', 'values']) {
    const buffer = visual?.[key]?.buffer;
    if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) transfer.push(buffer);
  }
  return transfer;
}

function collectResultTransferables(result) {
  return [
    ...collectVisualTransferables(result?.waveform),
    ...collectVisualTransferables(result?.spectrogram),
  ];
}

function createAudioBufferLike(audio) {
  const channels = (Array.isArray(audio?.channels) ? audio.channels : [])
    .map((channel) => channel instanceof Float32Array ? channel : new Float32Array(channel || 0));
  const length = Math.max(0, Math.floor(Number(audio?.length) || channels[0]?.length || 0));
  const sampleRate = Math.max(8000, Number(audio?.sampleRate) || 48000);

  return {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    getChannelData(channelIndex) {
      return channels[channelIndex] || new Float32Array(length);
    },
  };
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    stack: error?.stack || null,
  };
}

function normalizeMinSegmentDurationSec(value, fallback = DEFAULT_MIN_SEGMENT_DURATION_SEC) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(15, Math.min(600, Math.round(num)));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Aegisub reference: AudioWaveformRenderer draws peak min/max plus positive/negative averages per pixel.
// https://sources.debian.org/src/aegisub/3.4.2%2Bds-3/src/audio_renderer_waveform.cpp
function computeWaveformPeaks(audioBuffer, {
  startSec = 0,
  endSec = null,
  peaksPerSec = DEFAULT_WAVEFORM_PEAKS_PER_SEC,
  maxPeaks = DEFAULT_WAVEFORM_MAX_PEAKS,
} = {}) {
  const durationSec = Math.max(0, Number(endSec) - Number(startSec));
  const length = Math.max(0, Math.floor(Number(audioBuffer?.length) || 0));
  const channels = Math.max(1, Math.floor(Number(audioBuffer?.numberOfChannels) || 1));
  if (!length || !durationSec) return null;

  const peakCount = Math.max(1, Math.min(length, Math.floor(clamp(Math.ceil(durationSec * peaksPerSec), 1, maxPeaks))));
  const samplesPerPeak = Math.max(1, Math.ceil(length / peakCount));
  const sampleStride = Math.max(1, Math.floor(samplesPerPeak / 2048));
  const minPeaks = new Int16Array(peakCount);
  const maxPeakValues = new Int16Array(peakCount);
  const avgMinPeaks = new Int16Array(peakCount);
  const avgMaxPeaks = new Int16Array(peakCount);

  for (let peakIndex = 0; peakIndex < peakCount; peakIndex += 1) {
    const from = peakIndex * samplesPerPeak;
    const to = Math.min(length, from + samplesPerPeak);
    let minValue = 0;
    let maxValue = 0;
    let avgMinAccum = 0;
    let avgMaxAccum = 0;
    let sampleCount = 0;

    for (let frame = from; frame < to; frame += sampleStride) {
      let mono = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        mono += audioBuffer.getChannelData(channel)[frame] || 0;
      }
      mono /= channels;
      if (sampleCount === 0 || mono < minValue) minValue = mono;
      if (sampleCount === 0 || mono > maxValue) maxValue = mono;
      if (mono > 0) avgMaxAccum += mono;
      else avgMinAccum += mono;
      sampleCount += 1;
    }

    minPeaks[peakIndex] = Math.round(clamp(minValue, -1, 1) * WAVEFORM_VALUE_SCALE);
    maxPeakValues[peakIndex] = Math.round(clamp(maxValue, -1, 1) * WAVEFORM_VALUE_SCALE);
    avgMinPeaks[peakIndex] = Math.round(clamp(sampleCount ? avgMinAccum / sampleCount : 0, -1, 0) * WAVEFORM_VALUE_SCALE);
    avgMaxPeaks[peakIndex] = Math.round(clamp(sampleCount ? avgMaxAccum / sampleCount : 0, 0, 1) * WAVEFORM_VALUE_SCALE);
  }

  return {
    startSec,
    endSec,
    durationSec,
    peakCount,
    samplesPerPeak,
    sampleStride,
    min: minPeaks,
    max: maxPeakValues,
    avgMin: avgMinPeaks,
    avgMax: avgMaxPeaks,
    valueScale: WAVEFORM_VALUE_SCALE,
    renderer: 'aegisub-waveform-like-v1',
  };
}

function reverseBits(value, bitCount) {
  let output = 0;
  for (let bit = 0; bit < bitCount; bit += 1) {
    output = (output << 1) | (value & 1);
    value >>= 1;
  }
  return output;
}

function fftPowerSpectrum(real) {
  const size = real.length;
  const levels = Math.log2(size);
  const imag = new Float32Array(size);
  const outputReal = new Float32Array(size);

  for (let index = 0; index < size; index += 1) {
    outputReal[reverseBits(index, levels)] = real[index];
  }

  for (let blockSize = 2; blockSize <= size; blockSize <<= 1) {
    const halfSize = blockSize >> 1;
    const phaseStep = (-2 * Math.PI) / blockSize;
    for (let blockStart = 0; blockStart < size; blockStart += blockSize) {
      for (let offset = 0; offset < halfSize; offset += 1) {
        const angle = phaseStep * offset;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const evenIndex = blockStart + offset;
        const oddIndex = evenIndex + halfSize;
        const oddReal = outputReal[oddIndex];
        const oddImag = imag[oddIndex];
        const tr = (oddReal * cos) - (oddImag * sin);
        const ti = (oddReal * sin) + (oddImag * cos);
        outputReal[oddIndex] = outputReal[evenIndex] - tr;
        imag[oddIndex] = imag[evenIndex] - ti;
        outputReal[evenIndex] += tr;
        imag[evenIndex] += ti;
      }
    }
  }

  const binCount = (size >> 1) + 1;
  const power = new Float32Array(binCount);
  for (let index = 0; index < binCount; index += 1) {
    power[index] = (outputReal[index] * outputReal[index]) + (imag[index] * imag[index]);
  }
  return power;
}

function buildAegisubFrequencyRows(sampleRate, fftSize, rowCount) {
  const binCount = fftSize >> 1;
  const minBand = 1;
  const maxBand = Math.max(
    minBand + 1,
    Math.min(Math.round((binCount * AEGISUB_MAX_FREQUENCY_HZ) / (sampleRate * 0.5)), binCount)
  );
  const scaleLog = Math.log(maxBand / minBand);
  const referenceBin = clamp(
    (binCount * AEGISUB_REFERENCE_FREQUENCY_HZ) / (sampleRate * 0.5),
    minBand,
    maxBand - 1
  );
  const referenceLinear = minBand + ((maxBand - minBand) * AEGISUB_REFERENCE_POSITION);
  const referenceLog = minBand * Math.exp(AEGISUB_REFERENCE_POSITION * scaleLog);
  const denominator = referenceLog - referenceLinear;
  const logMix = Math.abs(denominator) > 1e-6
    ? clamp((referenceBin - referenceLinear) / denominator, 0, 1)
    : 0;
  const rows = [];
  let previousBin = minBand;
  let currentBin = minBand;

  for (let row = 0; row < rowCount; row += 1) {
    let nextBin = maxBand;
    if (row + 1 < rowCount) {
      const position = (row + 1) / rowCount;
      const linearBin = minBand + (position * (maxBand - minBand));
      const logBin = minBand * Math.exp(position * scaleLog);
      nextBin = linearBin + (logMix * (logBin - linearBin));
    }

    rows.push({
      previousBin,
      currentBin,
      nextBin,
      centerHz: Math.round((currentBin * sampleRate) / fftSize),
    });
    previousBin = currentBin;
    currentBin = nextBin;
  }

  return {
    rows,
    binCount,
    minHz: Math.round((minBand * sampleRate) / fftSize),
    maxHz: Math.round((maxBand * sampleRate) / fftSize),
    minBand,
    maxBand,
    logMix,
  };
}

// Aegisub reference: AudioSpectrumRenderer caches FFT magnitudes as
// log10(magnitude * scale + 1), then maps display rows with a linear/log frequency blend.
// https://sources.debian.org/src/aegisub/3.4.2%2Bds-3/src/audio_renderer_spectrum.cpp
function computeSpectrogram(audioBuffer, {
  startSec = 0,
  endSec = null,
  derivationDist = AEGISUB_SPECTRUM_DERIVATION_DIST_STANDARD,
  maxColumns = DEFAULT_SPECTROGRAM_MAX_COLUMNS,
} = {}) {
  const durationSec = Math.max(0, Number(endSec) - Number(startSec));
  const length = Math.max(0, Math.floor(Number(audioBuffer?.length) || 0));
  const channels = Math.max(1, Math.floor(Number(audioBuffer?.numberOfChannels) || 1));
  const sampleRate = Math.max(8000, Number(audioBuffer?.sampleRate) || 48000);
  if (!length || !durationSec) return null;

  const sampleStep = 1 << Math.max(1, Math.floor(Number(derivationDist) || AEGISUB_SPECTRUM_DERIVATION_DIST_STANDARD));
  const columnCount = Math.max(1, Math.floor(clamp(Math.ceil(length / sampleStep), 1, maxColumns)));
  const columnFrameStep = length / columnCount;
  const frequencyMap = buildAegisubFrequencyRows(sampleRate, SPECTROGRAM_FFT_SIZE, SPECTROGRAM_BIN_COUNT);
  const window = new Float32Array(SPECTROGRAM_FFT_SIZE);
  const values = new Uint8Array(columnCount * SPECTROGRAM_BIN_COUNT);
  const scaleFactor = 9 / Math.sqrt(2 * SPECTROGRAM_FFT_SIZE);
  let maxPower = 0;

  for (let column = 0; column < columnCount; column += 1) {
    const centerFrame = Math.floor(column * columnFrameStep);
    const frameStart = centerFrame - Math.floor(SPECTROGRAM_FFT_SIZE / 2);
    for (let frame = 0; frame < SPECTROGRAM_FFT_SIZE; frame += 1) {
      const sourceFrame = frameStart + frame;
      let mono = 0;
      if (sourceFrame >= 0 && sourceFrame < length) {
        for (let channel = 0; channel < channels; channel += 1) {
          mono += audioBuffer.getChannelData(channel)[sourceFrame] || 0;
        }
        mono /= channels;
      }
      window[frame] = mono;
    }

    const power = fftPowerSpectrum(window);
    for (let bin = 0; bin < SPECTROGRAM_BIN_COUNT; bin += 1) {
      const magnitude = Math.sqrt(power[bin] || 0);
      const rowPower = Math.log10((magnitude * scaleFactor) + 1);
      if (rowPower > maxPower) maxPower = rowPower;
      values[(column * SPECTROGRAM_BIN_COUNT) + bin] = Math.round(clamp(rowPower, 0, 1) * AEGISUB_VALUE_SCALE);
    }
  }

  return {
    startSec,
    endSec,
    durationSec,
    columnCount,
    bandCount: SPECTROGRAM_BIN_COUNT,
    fftSize: SPECTROGRAM_FFT_SIZE,
    binCount: SPECTROGRAM_BIN_COUNT,
    minHz: frequencyMap.minHz,
    maxHz: frequencyMap.maxHz,
    sampleRate,
    maxFrequencyHz: AEGISUB_MAX_FREQUENCY_HZ,
    minBand: 1,
    maxBand: frequencyMap.maxBand,
    logRatio: frequencyMap.logMix,
    derivationSize: AEGISUB_SPECTRUM_DERIVATION_SIZE,
    derivationDist,
    sampleStep,
    columnFrameStep,
    referenceFrequencyHz: AEGISUB_REFERENCE_FREQUENCY_HZ,
    referencePosition: AEGISUB_REFERENCE_POSITION,
    frequencyScale: 'aegisub-mixed-linear-log-bin-cache',
    valueScale: AEGISUB_VALUE_SCALE,
    maxPower,
    renderer: 'aegisub-spectrum-bin-cache-v1',
    values,
  };
}

function formatRuntimeInfo(runtimeInfo) {
  if (!runtimeInfo || typeof runtimeInfo !== 'object') return '';
  const provider = String(runtimeInfo.executionProvider || 'wasm').toUpperCase();
  if (provider === 'WEBGPU') {
    const headProvider = runtimeInfo.temporalHeadExecutionProvider
      ? `, head ${String(runtimeInfo.temporalHeadExecutionProvider).toUpperCase()}`
      : '';
    return `WebGPU${headProvider}`;
  }
  const threads = Number.isFinite(Number(runtimeInfo.numThreads))
    ? Math.max(1, Math.floor(Number(runtimeInfo.numThreads)))
    : 1;
  const fallback = runtimeInfo.providerAttempts?.length ? ', WebGPU fallback' : '';
  return `WASM ${threads} thread${threads === 1 ? '' : 's'}${fallback}`;
}

async function analyzeOfflineAudio(jobId, payload) {
  const {
    FireRedAedOfflineAnalyzer,
    smoothFireRedAnalyses,
    splitSongSegmentsByBoundaries,
  } = await loadModules();

  const audioBuffer = createAudioBufferLike(payload.audio);
  const startSec = Math.max(0, Number(payload.startSec) || 0);
  const endSec = Math.max(startSec, Number(payload.endSec) || startSec + (audioBuffer.length / audioBuffer.sampleRate));
  const splitMedley = Boolean(payload.splitMedley);
  const highResolutionVisuals = Boolean(payload.highResolutionVisuals);
  const generateVisuals = payload.generateVisuals !== false;
  const minSegmentDurationSec = normalizeMinSegmentDurationSec(payload.minSegmentDurationSec);

  post(jobId, 'model-status', { message: 'Model: loading FireRed AED' });
  const detector = new FireRedAedOfflineAnalyzer({
    chunkSec: Math.max(5, Number(payload.chunkSec) || DEFAULT_CHUNK_SEC),
  });
  await detector.initialize();
  const runtimeLabel = formatRuntimeInfo(detector.getRuntimeInfo ? detector.getRuntimeInfo() : null);
  post(jobId, 'model-status', {
    message: `Model: FireRed AED ready${runtimeLabel ? ` (${runtimeLabel})` : ''}`,
  });
  post(jobId, 'status', { message: `Analyzing audio (${payload.rangeLabel || ''})...` });

  const analyses = await detector.analyzeAudioBuffer(audioBuffer, {
    startFrame: 0,
    endFrame: audioBuffer.length,
    timeOffsetSec: startSec,
    onProgress: ({ phase, ratio }) => {
      const clampedRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
      const phaseLabel = phase === 'temporal-head' ? 'Temporal head' : 'AED';
      const progressRatio = phase === 'temporal-head'
        ? 0.85 + (clampedRatio * 0.1)
        : clampedRatio * 0.85;
      post(jobId, 'progress', {
        phase,
        ratio: progressRatio,
        message: `${phaseLabel}... ${Math.round(clampedRatio * 100)}%`,
      });
    },
  });

  if (payload.analysisOnly) {
    let waveform = null;
    let spectrogram = null;
    let visualError = null;
    if (generateVisuals) {
      post(jobId, 'status', {
        message: highResolutionVisuals
          ? 'Rendering high-resolution spectrogram and waveform...'
          : 'Rendering spectrogram and waveform...',
      });
      try {
        waveform = computeWaveformPeaks(audioBuffer, {
          startSec,
          endSec,
          peaksPerSec: highResolutionVisuals ? HIGH_RES_WAVEFORM_PEAKS_PER_SEC : DEFAULT_WAVEFORM_PEAKS_PER_SEC,
          maxPeaks: highResolutionVisuals ? HIGH_RES_WAVEFORM_MAX_PEAKS : DEFAULT_WAVEFORM_MAX_PEAKS,
        });
        spectrogram = computeSpectrogram(audioBuffer, {
          startSec,
          endSec,
          derivationDist: highResolutionVisuals ? AEGISUB_SPECTRUM_DERIVATION_DIST : AEGISUB_SPECTRUM_DERIVATION_DIST_STANDARD,
          maxColumns: highResolutionVisuals ? HIGH_RES_SPECTROGRAM_MAX_COLUMNS : DEFAULT_SPECTROGRAM_MAX_COLUMNS,
        });
      } catch (error) {
        visualError = serializeError(error);
      }
    }
    post(jobId, 'progress', { ratio: 1, message: 'Done.' });
    const result = {
      analyses,
      analysesLength: analyses.length,
      minSegmentDurationSec,
      runtimeInfo: detector.getRuntimeInfo ? detector.getRuntimeInfo() : null,
      detectorVersion: detector.getDetectorVersion ? detector.getDetectorVersion() : null,
      waveform,
      spectrogram,
      visualError,
      highResolutionVisuals,
    };
    post(jobId, 'complete', { result }, collectResultTransferables(result));
    return;
  }

  post(jobId, 'status', { message: `Smoothing ${analyses.length} analysis windows...` });
  let smoothing = smoothFireRedAnalyses(analyses, endSec, { startSec, minSegmentDurationSec });
  const baseSegments = smoothing.segments;
  let segments = baseSegments;
  let boundarySplit = null;

  if (splitMedley) {
    post(jobId, 'status', { message: `Splitting medley candidates in ${segments.length} segment(s)...` });
    boundarySplit = splitSongSegmentsByBoundaries(segments, analyses);
    segments = boundarySplit.segments;
  }

  let waveform = null;
  let spectrogram = null;
  let visualError = null;
  if (generateVisuals) {
    post(jobId, 'status', {
      message: highResolutionVisuals
        ? 'Rendering high-resolution spectrogram and waveform...'
        : 'Rendering spectrogram and waveform...',
    });
    try {
      waveform = computeWaveformPeaks(audioBuffer, {
        startSec,
        endSec,
        peaksPerSec: highResolutionVisuals ? HIGH_RES_WAVEFORM_PEAKS_PER_SEC : DEFAULT_WAVEFORM_PEAKS_PER_SEC,
        maxPeaks: highResolutionVisuals ? HIGH_RES_WAVEFORM_MAX_PEAKS : DEFAULT_WAVEFORM_MAX_PEAKS,
      });
      spectrogram = computeSpectrogram(audioBuffer, {
        startSec,
        endSec,
        derivationDist: highResolutionVisuals ? AEGISUB_SPECTRUM_DERIVATION_DIST : AEGISUB_SPECTRUM_DERIVATION_DIST_STANDARD,
        maxColumns: highResolutionVisuals ? HIGH_RES_SPECTROGRAM_MAX_COLUMNS : DEFAULT_SPECTROGRAM_MAX_COLUMNS,
      });
    } catch (error) {
      visualError = serializeError(error);
      waveform = null;
      spectrogram = null;
    }
  }

  post(jobId, 'progress', { ratio: 1, message: 'Done.' });
  const result = {
    segments,
    baseSegments,
    boundarySplit,
    smoothingMethod: smoothing.method || null,
    smoothingVersion: smoothing.smoothingVersion || null,
    excludedMusicOnlySpans: smoothing.excludedMusicOnlySpans || [],
    droppedMusicOnlySegments: smoothing.droppedMusicOnlySegments || [],
    waveform,
    spectrogram,
    visualError,
    highResolutionVisuals,
    analyses,
    analysesLength: analyses.length,
    minSegmentDurationSec,
    runtimeInfo: detector.getRuntimeInfo ? detector.getRuntimeInfo() : null,
    detectorVersion: detector.getDetectorVersion ? detector.getDetectorVersion() : null,
  };
  post(jobId, 'complete', { result }, collectResultTransferables(result));

  smoothing = null;
}

async function renderOfflineVisuals(jobId, payload) {
  const audioBuffer = createAudioBufferLike(payload.audio);
  const startSec = Math.max(0, Number(payload.startSec) || 0);
  const endSec = Math.max(startSec, Number(payload.endSec) || startSec + (audioBuffer.length / audioBuffer.sampleRate));
  const highResolutionVisuals = Boolean(payload.highResolutionVisuals);
  let waveform = null;
  let spectrogram = null;
  let visualError = null;

  post(jobId, 'status', {
    message: highResolutionVisuals
      ? 'Rendering high-resolution spectrogram and waveform...'
      : 'Rendering spectrogram and waveform...',
  });

  try {
    waveform = computeWaveformPeaks(audioBuffer, {
      startSec,
      endSec,
      peaksPerSec: highResolutionVisuals ? HIGH_RES_WAVEFORM_PEAKS_PER_SEC : DEFAULT_WAVEFORM_PEAKS_PER_SEC,
      maxPeaks: highResolutionVisuals ? HIGH_RES_WAVEFORM_MAX_PEAKS : DEFAULT_WAVEFORM_MAX_PEAKS,
    });
    spectrogram = computeSpectrogram(audioBuffer, {
      startSec,
      endSec,
      derivationDist: highResolutionVisuals ? AEGISUB_SPECTRUM_DERIVATION_DIST : AEGISUB_SPECTRUM_DERIVATION_DIST_STANDARD,
      maxColumns: highResolutionVisuals ? HIGH_RES_SPECTROGRAM_MAX_COLUMNS : DEFAULT_SPECTROGRAM_MAX_COLUMNS,
    });
  } catch (error) {
    visualError = serializeError(error);
  }

  const result = {
    waveform,
    spectrogram,
    highResolutionVisuals,
    visualError,
  };
  post(jobId, 'complete', { result }, collectResultTransferables(result));
}

self.onmessage = (event) => {
  const message = event.data || {};
  const jobId = message.jobId || `offline-${Date.now()}`;
  if (message.type === 'analyze-offline-audio') {
    analyzeOfflineAudio(jobId, message.payload || {}).catch((error) => {
      post(jobId, 'error', { error: serializeError(error) });
    });
    return;
  }
  if (message.type === 'render-offline-visuals') {
    renderOfflineVisuals(jobId, message.payload || {}).catch((error) => {
      post(jobId, 'error', { error: serializeError(error) });
    });
  }
};
