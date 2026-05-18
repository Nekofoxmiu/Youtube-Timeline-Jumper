import { clamp, DETECTOR_MODES, roundNumber } from './common.js';

export const FIRERED_AED_DETECTOR_VERSION = 'firered-aed-onnx-v1';

const TARGET_SAMPLE_RATE = 16000;
const FRAME_LENGTH = 400; // 25 ms at 16 kHz
const FRAME_SHIFT = 160; // 10 ms at 16 kHz
const FFT_LENGTH = 512;
const SPECTRUM_BIN_COUNT = (FFT_LENGTH / 2) + 1;
const FEATURE_DIM = 80;
const MEL_MIN_HZ = 20;
const MEL_MAX_HZ = 7600;
const LOG_FLOOR = 1e-10;
const DEFAULT_ANALYSIS_WINDOW_SEC = 12;
const DEFAULT_EVIDENCE_WINDOW_SEC = 4;
const DEFAULT_MIN_AUDIO_SEC = 1.2;
const MAX_BUFFER_SEC = 45;
const MODEL_BASE_PATH = 'models/fireredvad/aed';
const DEFAULT_LABELS = ['speech', 'singing', 'music'];
const TEMPORAL_HEAD_META_PATH = `${MODEL_BASE_PATH}/firered_song_head.meta.json`;
const TEMPORAL_HEAD_MODEL_PATH = `${MODEL_BASE_PATH}/firered_song_head.onnx`;
const TEMPORAL_HEAD_HOP_SEC = 0.5;
const TEMPORAL_HEAD_HISTORY_SEC = 120;
const MAX_WASM_THREAD_COUNT = 4;
const OFFLINE_FEATURE_YIELD_FRAMES = 300;
const TEMPORAL_MATRIX_YIELD_ROWS = 512;

let runtimePromise = null;

function resolveExtensionUrl(path) {
  if (globalThis.chrome?.runtime?.getURL) {
    return globalThis.chrome.runtime.getURL(path);
  }
  return new URL(`../../${path}`, import.meta.url).href;
}

function resolveWasmThreadConfig() {
  const crossOriginIsolated = globalThis.crossOriginIsolated === true;
  const sharedArrayBufferAvailable = typeof globalThis.SharedArrayBuffer === 'function';
  const hardwareConcurrency = Number(globalThis.navigator?.hardwareConcurrency);
  const coreCount = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
    ? Math.floor(hardwareConcurrency)
    : 1;

  if (!crossOriginIsolated || !sharedArrayBufferAvailable || coreCount < 2) {
    return {
      numThreads: 1,
      crossOriginIsolated,
      sharedArrayBufferAvailable,
      hardwareConcurrency: coreCount,
    };
  }

  return {
    numThreads: Math.max(1, Math.min(MAX_WASM_THREAD_COUNT, Math.ceil(coreCount / 2))),
    crossOriginIsolated,
    sharedArrayBufferAvailable,
    hardwareConcurrency: coreCount,
  };
}

class FloatRingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.buffer = new Float32Array(this.capacity);
    this.size = 0;
    this.writeIndex = 0;
  }

  clear() {
    this.size = 0;
    this.writeIndex = 0;
  }

  push(samples) {
    if (!samples || !samples.length) return;
    for (let i = 0; i < samples.length; i += 1) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      if (this.size < this.capacity) this.size += 1;
    }
  }

  getLatest(sampleCount) {
    const count = Math.min(this.size, Math.max(0, Math.floor(sampleCount)));
    if (!count) return new Float32Array(0);

    const output = new Float32Array(count);
    let start = this.writeIndex - count;
    if (start < 0) start += this.capacity;

    for (let i = 0; i < count; i += 1) {
      output[i] = this.buffer[(start + i) % this.capacity];
    }
    return output;
  }
}

class FftEngine {
  constructor(size) {
    this.size = size;
    this.bitReverse = new Uint16Array(size);
    this.real = new Float32Array(size);
    this.imag = new Float32Array(size);
    this.#buildBitReverseTable();
  }

  computePowerSpectrum(realInput) {
    const n = this.size;
    const re = this.real;
    const im = this.imag;

    for (let i = 0; i < n; i += 1) {
      const srcIndex = this.bitReverse[i];
      re[i] = srcIndex < realInput.length ? realInput[srcIndex] : 0;
      im[i] = 0;
    }

    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const angleStep = (-2 * Math.PI) / len;
      for (let base = 0; base < n; base += len) {
        for (let i = 0; i < halfLen; i += 1) {
          const angle = i * angleStep;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const evenIndex = base + i;
          const oddIndex = evenIndex + halfLen;
          const oddRe = re[oddIndex];
          const oddIm = im[oddIndex];
          const tRe = (oddRe * cos) - (oddIm * sin);
          const tIm = (oddRe * sin) + (oddIm * cos);
          re[oddIndex] = re[evenIndex] - tRe;
          im[oddIndex] = im[evenIndex] - tIm;
          re[evenIndex] += tRe;
          im[evenIndex] += tIm;
        }
      }
    }

    const power = new Float32Array(SPECTRUM_BIN_COUNT);
    for (let i = 0; i < SPECTRUM_BIN_COUNT; i += 1) {
      power[i] = (re[i] * re[i]) + (im[i] * im[i]);
    }
    return power;
  }

  #buildBitReverseTable() {
    const bits = Math.round(Math.log2(this.size));
    for (let i = 0; i < this.size; i += 1) {
      let x = i;
      let y = 0;
      for (let b = 0; b < bits; b += 1) {
        y = (y << 1) | (x & 1);
        x >>= 1;
      }
      this.bitReverse[i] = y;
    }
  }
}

function hzToMel(hz) {
  return 1127 * Math.log(1 + (hz / 700));
}

function melToHz(mel) {
  return 700 * (Math.exp(mel / 1127) - 1);
}

function buildPoveyWindow(length) {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const hann = 0.5 - (0.5 * Math.cos((2 * Math.PI * i) / (length - 1)));
    window[i] = hann ** 0.85;
  }
  return window;
}

function buildMelFilterBank({ sampleRate, fftLength, melBins, minHz, maxHz }) {
  const binCount = (fftLength / 2) + 1;
  const filterBank = new Float32Array(melBins * binCount);
  const minMel = hzToMel(minHz);
  const maxMel = hzToMel(maxHz);
  const melPoints = new Float32Array(melBins + 2);

  for (let i = 0; i < melPoints.length; i += 1) {
    melPoints[i] = minMel + ((maxMel - minMel) * i / (melBins + 1));
  }

  for (let melIndex = 0; melIndex < melBins; melIndex += 1) {
    const leftMel = melPoints[melIndex];
    const centerMel = melPoints[melIndex + 1];
    const rightMel = melPoints[melIndex + 2];
    const leftWidth = Math.max(1e-6, centerMel - leftMel);
    const rightWidth = Math.max(1e-6, rightMel - centerMel);

    for (let bin = 0; bin < binCount; bin += 1) {
      const freq = (bin * sampleRate) / fftLength;
      const mel = hzToMel(freq);
      let weight = 0;
      if (mel > leftMel && mel <= centerMel) {
        weight = (mel - leftMel) / leftWidth;
      } else if (mel > centerMel && mel < rightMel) {
        weight = (rightMel - mel) / rightWidth;
      }
      filterBank[(melIndex * binCount) + bin] = weight;
    }
  }

  return filterBank;
}

function resampleLinear(input, outputLength) {
  if (!input.length || outputLength <= 0) return new Float32Array(0);
  if (input.length === outputLength) return input.slice();

  const output = new Float32Array(outputLength);
  const scale = (input.length - 1) / Math.max(1, outputLength - 1);
  for (let i = 0; i < outputLength; i += 1) {
    const pos = i * scale;
    const left = Math.floor(pos);
    const right = Math.min(input.length - 1, left + 1);
    const alpha = pos - left;
    output[i] = (input[left] * (1 - alpha)) + (input[right] * alpha);
  }
  return output;
}

async function fetchJson(path, description) {
  const url = resolveExtensionUrl(path);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${description} not found (${path}, HTTP ${response.status}). Run tools/export_firered_aed_to_onnx.py first.`);
  }
  return response.json();
}

async function fetchOptionalJson(path) {
  const url = resolveExtensionUrl(path);
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

function normalizeCmvn(rawCmvn) {
  const means = Array.isArray(rawCmvn?.means) ? rawCmvn.means.map(Number) : [];
  const inverseStdVariances = Array.isArray(rawCmvn?.inverseStdVariances)
    ? rawCmvn.inverseStdVariances.map(Number)
    : [];
  if (means.length !== FEATURE_DIM || inverseStdVariances.length !== FEATURE_DIM) {
    throw new Error(`FireRed AED CMVN must contain ${FEATURE_DIM} means and inverseStdVariances.`);
  }
  return {
    means: Float32Array.from(means),
    inverseStdVariances: Float32Array.from(inverseStdVariances),
  };
}

function indexOfLabel(labels, label, fallback) {
  const index = labels.findIndex((item) => String(item).toLowerCase() === label);
  return index >= 0 ? index : fallback;
}

function summarizeEventWindow(data, frameCount, classCount, labelIndex, startFrame, endFrame) {
  const start = Math.max(0, Math.min(frameCount, startFrame));
  const end = Math.max(start, Math.min(frameCount, endFrame));
  if (end <= start) return { mean: 0, max: 0, ratio: 0 };

  let total = 0;
  let max = 0;
  let highCount = 0;
  const threshold = labelIndex === 1 ? 0.5 : 0.4;
  for (let frame = start; frame < end; frame += 1) {
    const value = clamp(Number(data[(frame * classCount) + labelIndex]) || 0, 0, 1);
    total += value;
    max = Math.max(max, value);
    if (value >= threshold) highCount += 1;
  }

  const count = end - start;
  return {
    mean: total / count,
    max,
    ratio: highCount / count,
  };
}

function summarizeTemporalHeadWindow(data, frameCount, classCount, runtime, startFrame, endFrame) {
  const start = Math.max(0, Math.min(frameCount, startFrame));
  const end = Math.max(start, Math.min(frameCount, endFrame));
  if (end <= start) {
    return {
      speech_max: 0,
      singing_max: 0,
      music_max: 0,
      speech_mean: 0,
      singing_mean: 0,
      music_mean: 0,
      speech_ratio: 0,
      singing_ratio: 0,
      music_ratio: 0,
    };
  }

  let speechTotal = 0;
  let singingTotal = 0;
  let musicTotal = 0;
  let speechMax = 0;
  let singingMax = 0;
  let musicMax = 0;
  let speechHigh = 0;
  let singingHigh = 0;
  let musicHigh = 0;

  for (let frame = start; frame < end; frame += 1) {
    const baseOffset = frame * classCount;
    const speech = clamp(Number(data[baseOffset + runtime.speechIndex]) || 0, 0, 1);
    const singing = clamp(Number(data[baseOffset + runtime.singingIndex]) || 0, 0, 1);
    const music = clamp(Number(data[baseOffset + runtime.musicIndex]) || 0, 0, 1);

    speechTotal += speech;
    singingTotal += singing;
    musicTotal += music;
    speechMax = Math.max(speechMax, speech);
    singingMax = Math.max(singingMax, singing);
    musicMax = Math.max(musicMax, music);
    if (speech >= 0.55) speechHigh += 1;
    if (singing >= 0.5) singingHigh += 1;
    if (music >= 0.45) musicHigh += 1;
  }

  const count = end - start;
  return {
    speech_max: speechMax,
    singing_max: singingMax,
    music_max: musicMax,
    speech_mean: speechTotal / count,
    singing_mean: singingTotal / count,
    music_mean: musicTotal / count,
    speech_ratio: speechHigh / count,
    singing_ratio: singingHigh / count,
    music_ratio: musicHigh / count,
  };
}

function meanFromHistory(history, key, steps) {
  const count = Math.min(history.length, Math.max(1, steps));
  if (!count) return 0;

  let total = 0;
  for (let i = history.length - count; i < history.length; i += 1) {
    total += Number(history[i]?.[key]) || 0;
  }
  return total / count;
}

function maxFromHistory(history, key, steps) {
  const count = Math.min(history.length, Math.max(1, steps));
  if (!count) return 0;

  let max = 0;
  for (let i = history.length - count; i < history.length; i += 1) {
    max = Math.max(max, Number(history[i]?.[key]) || 0);
  }
  return max;
}

function timeSinceThreshold(history, key, threshold) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if ((Number(history[i]?.[key]) || 0) >= threshold) {
      return Math.min(120, (history.length - 1 - i) * TEMPORAL_HEAD_HOP_SEC) / 120;
    }
  }
  return 1;
}

function buildTemporalHeadFeatures(history, inputDim) {
  const latest = history[history.length - 1] || {};
  const features = [];
  const add = (value) => features.push(clamp(Number(value) || 0, -1, 1));

  const baseKeys = [
    'speech_max',
    'singing_max',
    'music_max',
    'speech_mean',
    'singing_mean',
    'music_mean',
    'speech_ratio',
    'singing_ratio',
    'music_ratio',
  ];
  for (const key of baseKeys) add(latest[key]);

  for (const sec of [4, 10, 30]) {
    const steps = Math.round(sec / TEMPORAL_HEAD_HOP_SEC);
    for (const key of ['speech_max', 'singing_max', 'music_max', 'speech_mean', 'singing_mean', 'music_mean']) {
      add(meanFromHistory(history, key, steps));
    }
    add(maxFromHistory(history, 'singing_max', steps));
    add(maxFromHistory(history, 'speech_max', steps));
  }

  add(timeSinceThreshold(history, 'singing_max', 0.78));
  add(timeSinceThreshold(history, 'singing_max', 0.90));
  add(meanFromHistory(history, 'music_mean', 20) - meanFromHistory(history, 'speech_mean', 20));
  add(meanFromHistory(history, 'singing_mean', 20) - meanFromHistory(history, 'speech_mean', 20));

  if (features.length !== inputDim) {
    throw new Error(`FireRed temporal head feature mismatch: expected ${inputDim}, got ${features.length}.`);
  }
  return Float32Array.from(features);
}

async function loadTemporalHeadRuntime(ort) {
  const meta = await fetchOptionalJson(TEMPORAL_HEAD_META_PATH);
  if (!meta) return null;

  const session = await ort.InferenceSession.create(
    resolveExtensionUrl(TEMPORAL_HEAD_MODEL_PATH),
    {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }
  );

  const inputName = String(meta.inputName || session.inputNames[0] || 'temporal_features');
  const outputName = String(meta.outputName || session.outputNames[0] || 'song_probability');
  const inputDim = Math.max(1, Number(meta.inputDim) || 37);

  return {
    meta,
    session,
    inputName,
    outputName,
    inputDim,
    threshold: Number.isFinite(Number(meta.threshold)) ? Number(meta.threshold) : 0.75,
    detectorVersion: String(meta.detectorVersion || 'firered-song-head-csv-v1'),
  };
}

function createFireRedFbankFeatureState(samples16k, runtime) {
  if (samples16k.length < FRAME_LENGTH) {
    return null;
  }

  const frameCount = Math.floor((samples16k.length - FRAME_LENGTH) / FRAME_SHIFT) + 1;
  if (frameCount <= 0) return null;

  return {
    samples16k,
    frameCount,
    features: new Float32Array(frameCount * FEATURE_DIM),
    frameBuffer: new Float32Array(FFT_LENGTH),
    scaledFrame: new Float32Array(FRAME_LENGTH),
    fft: runtime.fft,
    melFilterBank: runtime.melFilterBank,
    window: runtime.window,
    cmvn: runtime.cmvn,
    sampleScale: runtime.sampleScale,
    preemphasis: runtime.preemphasis,
  };
}

function writeFireRedFbankFeatureFrame(state, frameIndex) {
  const {
    samples16k,
    features,
    frameBuffer,
    scaledFrame,
    fft,
    melFilterBank,
    window,
    cmvn,
    sampleScale,
    preemphasis,
  } = state;

  const start = frameIndex * FRAME_SHIFT;
  let mean = 0;
  for (let i = 0; i < FRAME_LENGTH; i += 1) {
    const sample = samples16k[start + i] * sampleScale;
    scaledFrame[i] = sample;
    mean += sample;
  }
  mean /= FRAME_LENGTH;

  for (let i = 0; i < FRAME_LENGTH; i += 1) {
    const centered = scaledFrame[i] - mean;
    const previous = i > 0 ? (scaledFrame[i - 1] - mean) : 0;
    frameBuffer[i] = (centered - (preemphasis * previous)) * window[i];
  }
  for (let i = FRAME_LENGTH; i < FFT_LENGTH; i += 1) {
    frameBuffer[i] = 0;
  }

  const power = fft.computePowerSpectrum(frameBuffer);
  for (let mel = 0; mel < FEATURE_DIM; mel += 1) {
    let energy = 0;
    const filterOffset = mel * SPECTRUM_BIN_COUNT;
    for (let bin = 0; bin < SPECTRUM_BIN_COUNT; bin += 1) {
      energy += power[bin] * melFilterBank[filterOffset + bin];
    }
    const logEnergy = Math.log(Math.max(LOG_FLOOR, energy));
    features[(frameIndex * FEATURE_DIM) + mel] = (logEnergy - cmvn.means[mel]) * cmvn.inverseStdVariances[mel];
  }
}

function buildFireRedFbankFeatures(samples16k, runtime) {
  const state = createFireRedFbankFeatureState(samples16k, runtime);
  if (!state) return { data: new Float32Array(0), frameCount: 0 };

  const { frameCount, features } = state;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    writeFireRedFbankFeatureFrame(state, frameIndex);
  }

  return { data: features, frameCount };
}

async function buildFireRedFbankFeaturesCooperative(samples16k, runtime, {
  yieldEveryFrames = OFFLINE_FEATURE_YIELD_FRAMES,
} = {}) {
  const state = createFireRedFbankFeatureState(samples16k, runtime);
  if (!state) return { data: new Float32Array(0), frameCount: 0 };

  const { frameCount, features } = state;
  const yieldInterval = Math.max(1, Math.floor(yieldEveryFrames));
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    writeFireRedFbankFeatureFrame(state, frameIndex);
    if ((frameIndex + 1) % yieldInterval === 0) {
      await yieldToEventLoop();
    }
  }

  return { data: features, frameCount };
}

async function loadFireRedAedRuntime() {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    const ort = globalThis.ort;
    if (!ort || !ort.InferenceSession) {
      throw new Error('ONNX Runtime Web not loaded in this extension context.');
    }

    const wasmThreadConfig = resolveWasmThreadConfig();
    if (ort.env && ort.env.wasm) {
      ort.env.wasm.wasmPaths = resolveExtensionUrl('lib/vendor/onnxruntime/');
      ort.env.wasm.numThreads = wasmThreadConfig.numThreads;
      ort.env.wasm.simd = true;
    }

    const [meta, rawCmvn] = await Promise.all([
      fetchJson(`${MODEL_BASE_PATH}/model.meta.json`, 'FireRed AED metadata'),
      fetchJson(`${MODEL_BASE_PATH}/cmvn.json`, 'FireRed AED CMVN'),
    ]);

    const labels = Array.isArray(meta?.labels) && meta.labels.length >= 3
      ? meta.labels.map((label) => String(label).toLowerCase())
      : DEFAULT_LABELS;

    const session = await ort.InferenceSession.create(
      resolveExtensionUrl(`${MODEL_BASE_PATH}/model.onnx`),
      {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      }
    );
    let temporalHead = null;
    try {
      temporalHead = await loadTemporalHeadRuntime(ort);
    } catch (error) {
      console.warn('FireRed temporal song head unavailable; using base AED rules.', error);
    }

    const baseDetectorVersion = String(meta?.detectorVersion || FIRERED_AED_DETECTOR_VERSION);

    return {
      ort,
      session,
      inputName: meta?.inputName || session.inputNames[0],
      outputName: meta?.outputName || session.outputNames[0],
      labels,
      speechIndex: indexOfLabel(labels, 'speech', 0),
      singingIndex: indexOfLabel(labels, 'singing', 1),
      musicIndex: indexOfLabel(labels, 'music', 2),
      cmvn: normalizeCmvn(rawCmvn),
      fft: new FftEngine(FFT_LENGTH),
      window: buildPoveyWindow(FRAME_LENGTH),
      melFilterBank: buildMelFilterBank({
        sampleRate: TARGET_SAMPLE_RATE,
        fftLength: FFT_LENGTH,
        melBins: FEATURE_DIM,
        minHz: Number(meta?.melMinHz) || MEL_MIN_HZ,
        maxHz: Number(meta?.melMaxHz) || MEL_MAX_HZ,
      }),
      sampleScale: Number.isFinite(Number(meta?.sampleScale)) ? Number(meta.sampleScale) : 32768,
      preemphasis: Number.isFinite(Number(meta?.preemphasis)) ? Number(meta.preemphasis) : 0.97,
      temporalHead,
      detectorVersion: temporalHead
        ? `${baseDetectorVersion}+${temporalHead.detectorVersion}`
        : baseDetectorVersion,
      songThreshold: temporalHead?.threshold ?? (Number.isFinite(Number(meta?.songThreshold)) ? Number(meta.songThreshold) : 0.56),
      analysisWindowSec: Number.isFinite(Number(meta?.analysisWindowSec))
        ? Number(meta.analysisWindowSec)
        : DEFAULT_ANALYSIS_WINDOW_SEC,
      evidenceWindowSec: Number.isFinite(Number(meta?.evidenceWindowSec))
        ? Number(meta.evidenceWindowSec)
        : DEFAULT_EVIDENCE_WINDOW_SEC,
      minAudioSec: Number.isFinite(Number(meta?.minAudioSec))
        ? Number(meta.minAudioSec)
        : DEFAULT_MIN_AUDIO_SEC,
      wasmThreadConfig,
    };
  })().catch((error) => {
    runtimePromise = null;
    throw error;
  });

  return runtimePromise;
}

function concatFloat32Arrays(left, right) {
  if (!left || !left.length) return right ? right.slice() : new Float32Array(0);
  if (!right || !right.length) return left.slice();
  const output = new Float32Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function isPageHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function yieldToEventLoop() {
  if (isPageHidden()) return Promise.resolve();
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mixAudioBufferChunkToMono(audioBuffer, startFrame, frameCount) {
  const channels = audioBuffer.numberOfChannels;
  const mono = new Float32Array(frameCount);
  if (channels <= 0) return mono;

  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i += 1) {
      mono[i] += data[startFrame + i] || 0;
    }
  }

  const scale = 1 / channels;
  for (let i = 0; i < mono.length; i += 1) mono[i] *= scale;
  return mono;
}

async function runAedFeatures(runtime, features, frameCount) {
  if (!frameCount || !features.length) return new Float32Array(0);
  const feeds = {
    [runtime.inputName]: new runtime.ort.Tensor('float32', features, [1, frameCount, FEATURE_DIM]),
  };
  const outputs = await runtime.session.run(feeds);
  const tensor = outputs[runtime.outputName];
  if (!tensor || !tensor.data || !tensor.data.length) {
    throw new Error('FireRed AED output missing.');
  }
  return Float32Array.from(tensor.data);
}

function concatProbabilityChunks(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function buildHalfSecondStatsFromProbabilities(data, runtime) {
  const classCount = runtime.labels.length;
  const outputFrameCount = Math.floor(data.length / classCount);
  const framesPerHop = Math.max(1, Math.round(TEMPORAL_HEAD_HOP_SEC / 0.01));
  const windowCount = Math.floor(outputFrameCount / framesPerHop);
  const stats = {
    timeSec: new Float32Array(windowCount),
    speech_max: new Float32Array(windowCount),
    singing_max: new Float32Array(windowCount),
    music_max: new Float32Array(windowCount),
    speech_mean: new Float32Array(windowCount),
    singing_mean: new Float32Array(windowCount),
    music_mean: new Float32Array(windowCount),
    speech_ratio: new Float32Array(windowCount),
    singing_ratio: new Float32Array(windowCount),
    music_ratio: new Float32Array(windowCount),
  };

  for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
    const startFrame = windowIndex * framesPerHop;
    const endFrame = startFrame + framesPerHop;
    const summary = summarizeTemporalHeadWindow(data, outputFrameCount, classCount, runtime, startFrame, endFrame);
    stats.timeSec[windowIndex] = windowIndex * TEMPORAL_HEAD_HOP_SEC;
    stats.speech_max[windowIndex] = summary.speech_max;
    stats.singing_max[windowIndex] = summary.singing_max;
    stats.music_max[windowIndex] = summary.music_max;
    stats.speech_mean[windowIndex] = summary.speech_mean;
    stats.singing_mean[windowIndex] = summary.singing_mean;
    stats.music_mean[windowIndex] = summary.music_mean;
    stats.speech_ratio[windowIndex] = summary.speech_ratio;
    stats.singing_ratio[windowIndex] = summary.singing_ratio;
    stats.music_ratio[windowIndex] = summary.music_ratio;
  }

  return stats;
}

function appendAudioEnergyWindows(state, samples16k) {
  if (!samples16k || !samples16k.length) return;
  const windowSamples = Math.max(1, Math.round(TARGET_SAMPLE_RATE * TEMPORAL_HEAD_HOP_SEC));
  const samples = concatFloat32Arrays(state.pending, samples16k);
  let offset = 0;

  while (offset + windowSamples <= samples.length) {
    let sumSquares = 0;
    let peak = 0;
    for (let index = 0; index < windowSamples; index += 1) {
      const sample = samples[offset + index] || 0;
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    state.rms.push(Math.sqrt(sumSquares / windowSamples));
    state.peak.push(peak);
    offset += windowSamples;
  }

  state.pending = samples.slice(offset);
}

function attachAudioEnergyStats(stats, energyState) {
  const count = stats.timeSec.length;
  stats.audio_rms = new Float32Array(count);
  stats.audio_peak = new Float32Array(count);

  const available = Math.min(count, energyState.rms.length, energyState.peak.length);
  for (let index = 0; index < available; index += 1) {
    stats.audio_rms[index] = energyState.rms[index] || 0;
    stats.audio_peak[index] = energyState.peak[index] || 0;
  }
  return stats;
}

function summarizeAudioEnergy(samples, sampleCount = samples?.length || 0) {
  if (!samples || !samples.length || sampleCount <= 0) return { rms: 0, peak: 0 };
  const count = Math.min(samples.length, Math.max(1, Math.floor(sampleCount)));
  const start = Math.max(0, samples.length - count);
  let sumSquares = 0;
  let peak = 0;

  for (let index = start; index < samples.length; index += 1) {
    const sample = samples[index] || 0;
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }

  return {
    rms: Math.sqrt(sumSquares / count),
    peak,
  };
}

function getTemporalStatsAt(stats, index) {
  return {
    speech_max: stats.speech_max[index] || 0,
    singing_max: stats.singing_max[index] || 0,
    music_max: stats.music_max[index] || 0,
    speech_mean: stats.speech_mean[index] || 0,
    singing_mean: stats.singing_mean[index] || 0,
    music_mean: stats.music_mean[index] || 0,
    speech_ratio: stats.speech_ratio[index] || 0,
    singing_ratio: stats.singing_ratio[index] || 0,
    music_ratio: stats.music_ratio[index] || 0,
  };
}

async function buildTemporalFeatureMatrix(stats, inputDim) {
  const count = stats.timeSec.length;
  const matrix = new Float32Array(count * inputDim);
  const history = [];
  const maxHistory = Math.max(1, Math.round(TEMPORAL_HEAD_HISTORY_SEC / TEMPORAL_HEAD_HOP_SEC));

  for (let index = 0; index < count; index += 1) {
    history.push(getTemporalStatsAt(stats, index));
    if (history.length > maxHistory) history.splice(0, history.length - maxHistory);
    matrix.set(buildTemporalHeadFeatures(history, inputDim), index * inputDim);
    if ((index + 1) % TEMPORAL_MATRIX_YIELD_ROWS === 0) {
      await yieldToEventLoop();
    }
  }

  return matrix;
}

async function runTemporalHeadBatch(runtime, stats, onProgress) {
  const temporalHead = runtime.temporalHead;
  if (!temporalHead || !stats.timeSec.length) return null;

  const matrix = await buildTemporalFeatureMatrix(stats, temporalHead.inputDim);
  const count = stats.timeSec.length;
  const output = new Float32Array(count);
  const batchSize = 4096;

  for (let start = 0; start < count; start += batchSize) {
    const batchCount = Math.min(batchSize, count - start);
    const batch = matrix.slice(start * temporalHead.inputDim, (start + batchCount) * temporalHead.inputDim);
    const feeds = {
      [temporalHead.inputName]: new runtime.ort.Tensor('float32', batch, [batchCount, temporalHead.inputDim]),
    };
    const outputs = await temporalHead.session.run(feeds);
    const tensor = outputs[temporalHead.outputName];
    if (!tensor || !tensor.data || !tensor.data.length) {
      throw new Error('FireRed temporal song head output missing.');
    }
    output.set(tensor.data, start);
    if (typeof onProgress === 'function') {
      onProgress({
        phase: 'temporal-head',
        ratio: (start + batchCount) / Math.max(1, count),
      });
    }
    await yieldToEventLoop();
  }

  return {
    probabilities: output,
    threshold: temporalHead.threshold,
    detectorVersion: temporalHead.detectorVersion,
  };
}

function computePreliminarySongProbabilityFromStats(stats, index) {
  const singingMax = stats.singing_max[index] || 0;
  const singingMean = stats.singing_mean[index] || 0;
  const singingRatio = stats.singing_ratio[index] || 0;
  const musicMean = stats.music_mean[index] || 0;
  const speechMean = stats.speech_mean[index] || 0;
  const speechRatio = stats.speech_ratio[index] || 0;
  const speechDominance = Math.max(speechMean, speechRatio * 0.8);
  return clamp(
    (singingMax * 0.42)
      + (singingMean * 0.28)
      + (singingRatio * 0.18)
      + (Math.min(musicMean, singingMax) * 0.12)
      - (speechDominance * 0.18),
    0,
    1
  );
}

function buildOfflineAnalysisFrames(stats, temporalHeadResult, runtime, timeOffsetSec) {
  const frames = [];
  for (let index = 0; index < stats.timeSec.length; index += 1) {
    const baseSongProbability = computePreliminarySongProbabilityFromStats(stats, index);
    const temporalHeadProbability = temporalHeadResult?.probabilities?.[index] ?? null;
    const songProbability = temporalHeadProbability ?? baseSongProbability;
    frames.push({
      ready: true,
      timeSec: roundNumber(timeOffsetSec + ((index + 1) * TEMPORAL_HEAD_HOP_SEC), 3),
      songProbability,
      baseSongProbability,
      temporalHeadReady: Boolean(temporalHeadResult),
      temporalHeadProbability,
      temporalHeadThreshold: temporalHeadResult?.threshold ?? null,
      temporalHeadHistoryWindows: Math.min(index + 1, Math.round(TEMPORAL_HEAD_HISTORY_SEC / TEMPORAL_HEAD_HOP_SEC)),
      speechProbability: stats.speech_max[index] || 0,
      singingProbability: stats.singing_max[index] || 0,
      musicProbability: stats.music_max[index] || 0,
      speechMean: stats.speech_mean[index] || 0,
      singingMean: stats.singing_mean[index] || 0,
      musicMean: stats.music_mean[index] || 0,
      speechRatio: stats.speech_ratio[index] || 0,
      singingRatio: stats.singing_ratio[index] || 0,
      musicRatio: stats.music_ratio[index] || 0,
      audioRms: stats.audio_rms?.[index] || 0,
      audioPeak: stats.audio_peak?.[index] || 0,
      analyzedAudioSec: roundNumber((index + 1) * TEMPORAL_HEAD_HOP_SEC, 3),
      detectorVersion: runtime.detectorVersion,
    });
  }
  return frames;
}

export class FireRedAedOfflineAnalyzer {
  constructor({ chunkSec = 60 } = {}) {
    this.detectorVersion = FIRERED_AED_DETECTOR_VERSION;
    this.chunkSec = Math.max(5, Number(chunkSec) || 60);
    this.runtime = null;
  }

  async initialize() {
    this.runtime = await loadFireRedAedRuntime();
    this.detectorVersion = this.runtime.detectorVersion;
  }

  getDetectorVersion() {
    return this.detectorVersion;
  }

  getSongThreshold() {
    return this.runtime?.songThreshold || 0.56;
  }

  getRuntimeInfo() {
    return this.runtime?.wasmThreadConfig || null;
  }

  async analyzeAudioBuffer(audioBuffer, {
    startFrame = 0,
    endFrame = audioBuffer?.length || 0,
    timeOffsetSec = 0,
    onProgress = null,
  } = {}) {
    if (!this.runtime) await this.initialize();
    if (!audioBuffer || !Number.isFinite(audioBuffer.sampleRate)) {
      throw new Error('AudioBuffer is required for offline analysis.');
    }

    const sourceSampleRate = Math.max(8000, Number(audioBuffer.sampleRate) || 48000);
    const boundedStartFrame = Math.max(0, Math.min(audioBuffer.length, Math.floor(startFrame)));
    const boundedEndFrame = Math.max(boundedStartFrame, Math.min(audioBuffer.length, Math.ceil(endFrame)));
    const sourceChunkFrames = Math.max(1, Math.floor(sourceSampleRate * this.chunkSec));
    const totalSourceFrames = Math.max(1, boundedEndFrame - boundedStartFrame);
    const probabilityChunks = [];
    let pending16k = new Float32Array(0);
    const energyState = { pending: new Float32Array(0), rms: [], peak: [] };

    for (let offset = boundedStartFrame; offset < boundedEndFrame; offset += sourceChunkFrames) {
      const frameCount = Math.min(sourceChunkFrames, boundedEndFrame - offset);
      const mono = mixAudioBufferChunkToMono(audioBuffer, offset, frameCount);
      const targetLength = Math.max(0, Math.round(mono.length * TARGET_SAMPLE_RATE / sourceSampleRate));
      const resampled = targetLength > 0 ? resampleLinear(mono, targetLength) : new Float32Array(0);
      appendAudioEnergyWindows(energyState, resampled);
      const samples16k = concatFloat32Arrays(pending16k, resampled);
      const featureFrameCount = Math.floor((samples16k.length - FRAME_LENGTH) / FRAME_SHIFT) + 1;

      if (featureFrameCount > 0) {
        const usableSamples = ((featureFrameCount - 1) * FRAME_SHIFT) + FRAME_LENGTH;
        const { data, frameCount: builtFrameCount } = await buildFireRedFbankFeaturesCooperative(
          samples16k.slice(0, usableSamples),
          this.runtime
        );
        probabilityChunks.push(await runAedFeatures(this.runtime, data, builtFrameCount));
        pending16k = samples16k.slice(featureFrameCount * FRAME_SHIFT);
      } else {
        pending16k = samples16k;
      }

      if (typeof onProgress === 'function') {
        onProgress({
          phase: 'aed',
          ratio: (offset + frameCount - boundedStartFrame) / totalSourceFrames,
        });
      }
      await yieldToEventLoop();
    }

    if (!probabilityChunks.length) return [];
    const probabilities = concatProbabilityChunks(probabilityChunks);
    const stats = attachAudioEnergyStats(buildHalfSecondStatsFromProbabilities(probabilities, this.runtime), energyState);
    const temporalHeadResult = await runTemporalHeadBatch(this.runtime, stats, onProgress);
    return buildOfflineAnalysisFrames(stats, temporalHeadResult, this.runtime, timeOffsetSec);
  }
}

export class FireRedAedSongDetector {
  constructor({ sourceSampleRate }) {
    this.detectorMode = DETECTOR_MODES.FIRERED_AED;
    this.detectorVersion = FIRERED_AED_DETECTOR_VERSION;
    this.sourceSampleRate = Math.max(8000, Number(sourceSampleRate) || 48000);
    this.audioBuffer = new FloatRingBuffer(Math.ceil(this.sourceSampleRate * MAX_BUFFER_SEC));
    this.runtime = null;
    this.temporalHeadHistory = [];
  }

  async initialize() {
    this.runtime = await loadFireRedAedRuntime();
    this.detectorVersion = this.runtime.detectorVersion;
  }

  pushAudioChunk(samples) {
    if (!samples || !samples.length) return;
    this.audioBuffer.push(samples);
  }

  getDetectorVersion() {
    return this.detectorVersion;
  }

  getSongThreshold() {
    return this.runtime?.songThreshold || 0.56;
  }

  getRuntimeInfo() {
    return this.runtime?.wasmThreadConfig || null;
  }

  resetAnalysisState() {
    this.audioBuffer.clear();
    this.temporalHeadHistory = [];
  }

  async #runTemporalHead(data, outputFrameCount, classCount) {
    const temporalHead = this.runtime?.temporalHead;
    if (!temporalHead) return null;

    const framesPerHop = Math.max(1, Math.round(TEMPORAL_HEAD_HOP_SEC / 0.01));
    const tailEnd = outputFrameCount;
    const tailStart = Math.max(0, tailEnd - framesPerHop);
    const stats = summarizeTemporalHeadWindow(data, outputFrameCount, classCount, this.runtime, tailStart, tailEnd);

    this.temporalHeadHistory.push(stats);
    const maxHistory = Math.max(1, Math.round(TEMPORAL_HEAD_HISTORY_SEC / TEMPORAL_HEAD_HOP_SEC));
    if (this.temporalHeadHistory.length > maxHistory) {
      this.temporalHeadHistory.splice(0, this.temporalHeadHistory.length - maxHistory);
    }

    const temporalFeatures = buildTemporalHeadFeatures(this.temporalHeadHistory, temporalHead.inputDim);
    const feeds = {
      [temporalHead.inputName]: new this.runtime.ort.Tensor('float32', temporalFeatures, [1, temporalHead.inputDim]),
    };
    const outputs = await temporalHead.session.run(feeds);
    const tensor = outputs[temporalHead.outputName];
    if (!tensor || !tensor.data || !tensor.data.length) return null;

    return {
      probability: clamp(Number(tensor.data[0]) || 0, 0, 1),
      stats,
      historyWindows: this.temporalHeadHistory.length,
      threshold: temporalHead.threshold,
      detectorVersion: temporalHead.detectorVersion,
    };
  }

  async analyze() {
    if (!this.runtime) return { ready: false, songProbability: 0 };

    const analysisWindowSec = this.runtime.analysisWindowSec || DEFAULT_ANALYSIS_WINDOW_SEC;
    const sourceSampleCount = Math.ceil(this.sourceSampleRate * analysisWindowSec);
    const sourceSamples = this.audioBuffer.getLatest(sourceSampleCount);
    const availableSec = sourceSamples.length / this.sourceSampleRate;
    if (availableSec < (this.runtime.minAudioSec || DEFAULT_MIN_AUDIO_SEC)) {
      return { ready: false, songProbability: 0 };
    }

    const targetLength = Math.max(FRAME_LENGTH, Math.round(sourceSamples.length * TARGET_SAMPLE_RATE / this.sourceSampleRate));
    const samples16k = resampleLinear(sourceSamples, targetLength);
    const { data: features, frameCount } = buildFireRedFbankFeatures(samples16k, this.runtime);
    if (!frameCount || !features.length) return { ready: false, songProbability: 0 };

    const feeds = {
      [this.runtime.inputName]: new this.runtime.ort.Tensor('float32', features, [1, frameCount, FEATURE_DIM]),
    };
    const outputs = await this.runtime.session.run(feeds);
    const tensor = outputs[this.runtime.outputName];
    if (!tensor || !tensor.data || !tensor.data.length) {
      throw new Error('FireRed AED output missing.');
    }

    const classCount = this.runtime.labels.length;
    const outputFrameCount = Math.max(1, Math.floor(tensor.data.length / classCount));
    const evidenceFrames = Math.max(1, Math.round((this.runtime.evidenceWindowSec || DEFAULT_EVIDENCE_WINDOW_SEC) / 0.01));
    const tailStart = Math.max(0, outputFrameCount - evidenceFrames);

    const speechTail = summarizeEventWindow(tensor.data, outputFrameCount, classCount, this.runtime.speechIndex, tailStart, outputFrameCount);
    const singingTail = summarizeEventWindow(tensor.data, outputFrameCount, classCount, this.runtime.singingIndex, tailStart, outputFrameCount);
    const musicTail = summarizeEventWindow(tensor.data, outputFrameCount, classCount, this.runtime.musicIndex, tailStart, outputFrameCount);
    const speechAll = summarizeEventWindow(tensor.data, outputFrameCount, classCount, this.runtime.speechIndex, 0, outputFrameCount);
    const singingAll = summarizeEventWindow(tensor.data, outputFrameCount, classCount, this.runtime.singingIndex, 0, outputFrameCount);
    const musicAll = summarizeEventWindow(tensor.data, outputFrameCount, classCount, this.runtime.musicIndex, 0, outputFrameCount);

    const speechDominance = Math.max(speechTail.mean, speechTail.ratio * 0.8);
    const preliminarySongProbability = clamp(
      (singingTail.max * 0.42)
        + (singingTail.mean * 0.28)
        + (singingAll.ratio * 0.18)
        + (Math.min(musicTail.mean, Math.max(singingTail.max, singingAll.max)) * 0.12)
        - (speechDominance * 0.18),
      0,
      1
    );
    const temporalHeadResult = await this.#runTemporalHead(tensor.data, outputFrameCount, classCount);
    const songProbability = temporalHeadResult?.probability ?? preliminarySongProbability;
    const energy = summarizeAudioEnergy(samples16k, Math.round(TARGET_SAMPLE_RATE * TEMPORAL_HEAD_HOP_SEC));

    return {
      ready: true,
      songProbability,
      baseSongProbability: preliminarySongProbability,
      temporalHeadReady: Boolean(temporalHeadResult),
      temporalHeadProbability: temporalHeadResult?.probability ?? null,
      temporalHeadThreshold: temporalHeadResult?.threshold ?? null,
      temporalHeadHistoryWindows: temporalHeadResult?.historyWindows ?? 0,
      speechProbability: speechTail.max,
      singingProbability: singingTail.max,
      musicProbability: musicTail.max,
      speechMean: speechTail.mean,
      singingMean: singingTail.mean,
      musicMean: musicTail.mean,
      speechRatio: speechTail.ratio,
      singingRatio: singingTail.ratio,
      musicRatio: musicTail.ratio,
      longSpeechRatio: speechAll.ratio,
      longSingingRatio: singingAll.ratio,
      longMusicRatio: musicAll.ratio,
      longSingingMean: singingAll.mean,
      longMusicMean: musicAll.mean,
      audioRms: energy.rms,
      audioPeak: energy.peak,
      frameCount: outputFrameCount,
      analyzedAudioSec: roundNumber(availableSec, 3),
    };
  }
}
