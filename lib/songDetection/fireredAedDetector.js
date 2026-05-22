import { clamp, DETECTOR_MODES, roundNumber } from './common.js';
import { StreamingFrameBuilder, STREAMING_TARGET_SAMPLE_RATE } from './streamingFrameBuilder.js';

export const FIRERED_AED_DETECTOR_VERSION = 'firered-aed-onnx-v1';

const TARGET_SAMPLE_RATE = STREAMING_TARGET_SAMPLE_RATE;
const FRAME_LENGTH = 400; // 25 ms at 16 kHz
const FRAME_SHIFT = 160; // 10 ms at 16 kHz
const FFT_LENGTH = 512;
const SPECTRUM_BIN_COUNT = (FFT_LENGTH / 2) + 1;
const FEATURE_DIM = 80;
const MEL_MIN_HZ = 20;
const MEL_MAX_HZ = 7600;
const LOG_FLOOR = 1e-10;
const SPECTRAL_LOW_MAX_HZ = 250;
const SPECTRAL_MID_MAX_HZ = 4000;
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
const OFFLINE_FEATURE_YIELD_FRAMES = 300;
const TEMPORAL_MATRIX_YIELD_ROWS = 512;
const PROVIDER_WEBGPU = 'webgpu';
const PROVIDER_WASM = 'wasm';

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

  return {
    numThreads: 1,
    forcedSingleThread: true,
    crossOriginIsolated,
    sharedArrayBufferAvailable,
    hardwareConcurrency: coreCount,
  };
}

function resolveWebGpuInfo() {
  const gpuAvailable = Boolean(globalThis.navigator?.gpu);
  return {
    available: gpuAvailable,
    reason: gpuAvailable ? null : 'navigator.gpu unavailable',
  };
}

function serializeRuntimeError(error) {
  return {
    name: error?.name || null,
    message: error?.message || String(error || ''),
  };
}

function configureOrtRuntime(ort, wasmThreadConfig) {
  if (ort.env?.wasm) {
    ort.env.wasm.wasmPaths = resolveExtensionUrl('lib/vendor/onnxruntime/');
    ort.env.wasm.numThreads = wasmThreadConfig.numThreads;
    ort.env.wasm.simd = true;
  }
}

async function createOrtSessionWithFallback(ort, modelUrl, {
  label = 'ONNX model',
  graphOptimizationLevel = 'all',
} = {}) {
  const webGpuInfo = resolveWebGpuInfo();
  const attempts = [];

  if (webGpuInfo.available) {
    try {
      const session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: [PROVIDER_WEBGPU],
        graphOptimizationLevel,
      });
      return {
        session,
        executionProvider: PROVIDER_WEBGPU,
        attempts,
        webGpuInfo,
      };
    } catch (error) {
      const serialized = serializeRuntimeError(error);
      attempts.push({ provider: PROVIDER_WEBGPU, error: serialized });
      console.warn(`${label} WebGPU backend unavailable; falling back to WASM.`, error);
    }
  } else {
    attempts.push({
      provider: PROVIDER_WEBGPU,
      skipped: true,
      reason: webGpuInfo.reason,
    });
  }

  const session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: [PROVIDER_WASM],
    graphOptimizationLevel,
  });
  return {
    session,
    executionProvider: PROVIDER_WASM,
    attempts,
    webGpuInfo,
  };
}

async function createWasmOrtSession(ort, modelUrl, {
  graphOptimizationLevel = 'all',
} = {}) {
  return ort.InferenceSession.create(modelUrl, {
    executionProviders: [PROVIDER_WASM],
    graphOptimizationLevel,
  });
}

async function releaseOrtSession(session) {
  if (!session || typeof session.release !== 'function') return;
  try {
    await session.release();
  } catch (error) {
    console.warn('Failed to release ONNX session.', error);
  }
}

function isSessionBusyError(error) {
  return String(error?.message || error || '').toLowerCase().includes('session already started');
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function retrySessionRunWhenBusy(runOnce, runtime, label) {
  const maxRetries = 6;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await runOnce();
    } catch (error) {
      if (!isSessionBusyError(error) || attempt >= maxRetries) {
        throw error;
      }
      runtime.runtimeInfo = {
        ...(runtime.runtimeInfo || runtime.wasmThreadConfig || {}),
        sessionBusyRetries: Number(runtime.runtimeInfo?.sessionBusyRetries || 0) + 1,
        lastSessionBusyLabel: label,
      };
      await delayMs(20 + (attempt * 15));
    }
  }
  throw new Error(`${label} session stayed busy after retries.`);
}

async function enqueueRuntimeRun(runtime, label, runOnce) {
  const queueTarget = runtime?.ort || runtime;
  const previous = queueTarget.__ytjOrtRunQueue || Promise.resolve();
  const queued = previous.catch(() => {}).then(() => retrySessionRunWhenBusy(runOnce, runtime, label));
  queueTarget.__ytjOrtRunQueue = queued.catch(() => {});
  runtime.runQueue = queueTarget.__ytjOrtRunQueue;
  return queued;
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

function summarizeSpectrum(power) {
  let total = 0;
  let weightedHz = 0;
  let logTotal = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  const normalized = new Float32Array(power.length);

  for (let index = 1; index < power.length; index += 1) {
    const value = Math.max(LOG_FLOOR, power[index] || 0);
    const hz = (index * TARGET_SAMPLE_RATE) / FFT_LENGTH;
    total += value;
    weightedHz += value * hz;
    logTotal += Math.log(value);
    if (hz < SPECTRAL_LOW_MAX_HZ) low += value;
    else if (hz < SPECTRAL_MID_MAX_HZ) mid += value;
    else high += value;
  }

  const safeTotal = Math.max(LOG_FLOOR, total);
  for (let index = 0; index < power.length; index += 1) {
    normalized[index] = (power[index] || 0) / safeTotal;
  }

  const usableBins = Math.max(1, power.length - 1);
  const geometricMean = Math.exp(logTotal / usableBins);
  const arithmeticMean = safeTotal / usableBins;
  return {
    centroid: clamp((weightedHz / safeTotal) / (TARGET_SAMPLE_RATE / 2), 0, 1),
    flatness: clamp(geometricMean / Math.max(LOG_FLOOR, arithmeticMean), 0, 1),
    lowRatio: clamp(low / safeTotal, 0, 1),
    midRatio: clamp(mid / safeTotal, 0, 1),
    highRatio: clamp(high / safeTotal, 0, 1),
    normalized,
  };
}

function computeSpectralFlux(current, previous) {
  if (!current || !previous || current.length !== previous.length) return 0;
  let flux = 0;
  for (let index = 0; index < current.length; index += 1) {
    const diff = current[index] - previous[index];
    if (diff > 0) flux += diff;
  }
  return clamp(flux * 2, 0, 1);
}

function summarizeAudioSpectrum(samples, runtime, sampleCount = samples?.length || 0, previousSpectrum = null) {
  if (!samples || !samples.length || sampleCount <= 0 || !runtime?.fft) {
    return {
      spectralCentroid: 0,
      spectralFlatness: 0,
      spectralFlux: 0,
      lowEnergyRatio: 0,
      midEnergyRatio: 0,
      highEnergyRatio: 0,
      normalizedSpectrum: null,
    };
  }

  const count = Math.min(samples.length, Math.max(1, Math.floor(sampleCount)));
  const start = Math.max(0, samples.length - count);
  const frameCount = Math.max(1, Math.min(8, Math.floor((count - FFT_LENGTH) / Math.max(1, FFT_LENGTH)) + 1));
  const frameStep = frameCount <= 1 ? 0 : Math.max(1, Math.floor((count - FFT_LENGTH) / (frameCount - 1)));
  const window = runtime.spectrumWindow || runtime.window;
  const frame = new Float32Array(FFT_LENGTH);
  const combined = new Float32Array(SPECTRUM_BIN_COUNT);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const offset = start + Math.min(Math.max(0, count - FFT_LENGTH), frameIndex * frameStep);
    let meanValue = 0;
    for (let index = 0; index < FFT_LENGTH; index += 1) {
      meanValue += samples[offset + index] || 0;
    }
    meanValue /= FFT_LENGTH;
    for (let index = 0; index < FFT_LENGTH; index += 1) {
      frame[index] = ((samples[offset + index] || 0) - meanValue) * (window?.[index] || 1);
    }
    const power = runtime.fft.computePowerSpectrum(frame);
    for (let bin = 0; bin < SPECTRUM_BIN_COUNT; bin += 1) {
      combined[bin] += power[bin] / frameCount;
    }
  }

  const summary = summarizeSpectrum(combined);
  return {
    spectralCentroid: summary.centroid,
    spectralFlatness: summary.flatness,
    spectralFlux: computeSpectralFlux(summary.normalized, previousSpectrum),
    lowEnergyRatio: summary.lowRatio,
    midEnergyRatio: summary.midRatio,
    highEnergyRatio: summary.highRatio,
    normalizedSpectrum: summary.normalized,
  };
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

  const modelUrl = resolveExtensionUrl(TEMPORAL_HEAD_MODEL_PATH);
  // The temporal head is tiny. Keeping it on WASM avoids WebGPU session-mismatch
  // churn when multiple tab sessions share the same offscreen ORT runtime.
  const session = await createWasmOrtSession(ort, modelUrl);
  const webGpuInfo = resolveWebGpuInfo();
  const providerAttempts = [{
    provider: PROVIDER_WEBGPU,
    skipped: true,
    reason: 'temporal head uses WASM for multi-tab stability',
    webGpuAvailable: webGpuInfo.available,
  }];

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
    modelUrl,
    executionProvider: PROVIDER_WASM,
    providerAttempts,
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
    configureOrtRuntime(ort, wasmThreadConfig);

    const [meta, rawCmvn] = await Promise.all([
      fetchJson(`${MODEL_BASE_PATH}/model.meta.json`, 'FireRed AED metadata'),
      fetchJson(`${MODEL_BASE_PATH}/cmvn.json`, 'FireRed AED CMVN'),
    ]);

    const labels = Array.isArray(meta?.labels) && meta.labels.length >= 3
      ? meta.labels.map((label) => String(label).toLowerCase())
      : DEFAULT_LABELS;

    const modelUrl = resolveExtensionUrl(`${MODEL_BASE_PATH}/model.onnx`);
    const sessionResult = await createOrtSessionWithFallback(ort, modelUrl, {
      label: 'FireRed AED',
    });
    const { session } = sessionResult;
    let temporalHead = null;
    try {
      temporalHead = await loadTemporalHeadRuntime(ort);
    } catch (error) {
      console.warn('FireRed temporal song head unavailable; using base AED rules.', error);
    }

    const baseDetectorVersion = String(meta?.detectorVersion || FIRERED_AED_DETECTOR_VERSION);
    const runtimeInfo = {
      ...wasmThreadConfig,
      executionProvider: sessionResult.executionProvider,
      webGpuAvailable: sessionResult.webGpuInfo.available,
      webGpuUnavailableReason: sessionResult.webGpuInfo.reason,
      providerAttempts: sessionResult.attempts,
      temporalHeadExecutionProvider: temporalHead?.executionProvider || null,
      temporalHeadProviderAttempts: temporalHead?.providerAttempts || [],
    };

    return {
      ort,
      session,
      modelUrl,
      executionProvider: sessionResult.executionProvider,
      inputName: meta?.inputName || session.inputNames[0],
      outputName: meta?.outputName || session.outputNames[0],
      labels,
      speechIndex: indexOfLabel(labels, 'speech', 0),
      singingIndex: indexOfLabel(labels, 'singing', 1),
      musicIndex: indexOfLabel(labels, 'music', 2),
      cmvn: normalizeCmvn(rawCmvn),
      fft: new FftEngine(FFT_LENGTH),
      window: buildPoveyWindow(FRAME_LENGTH),
      spectrumWindow: buildPoveyWindow(FFT_LENGTH),
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
      runtimeInfo,
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

function int16ToFloat32(samples) {
  const output = new Float32Array(samples?.length || 0);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = (Number(samples[index]) || 0) / 32768;
  }
  return output;
}

async function analyzeSamples16kToFrames(runtime, samples16k, {
  timeOffsetSec = 0,
  onProgress = null,
  progressPhase = 'aed',
  internalChunkSec = 60,
} = {}) {
  if (!samples16k || !samples16k.length) return [];

  const sourceChunkSamples = Math.max(TARGET_SAMPLE_RATE, Math.floor(TARGET_SAMPLE_RATE * internalChunkSec));
  const probabilityChunks = [];
  let pending16k = new Float32Array(0);
  const totalSamples = Math.max(1, samples16k.length);
  const energyState = {
    pending: new Float32Array(0),
    previousSpectrum: null,
    rms: [],
    peak: [],
    spectralCentroid: [],
    spectralFlatness: [],
    spectralFlux: [],
    lowEnergyRatio: [],
    midEnergyRatio: [],
    highEnergyRatio: [],
  };

  for (let offset = 0; offset < samples16k.length; offset += sourceChunkSamples) {
    const chunk = samples16k.subarray(offset, Math.min(samples16k.length, offset + sourceChunkSamples));
    appendAudioFeatureWindows(energyState, chunk, runtime);
    const combined = concatFloat32Arrays(pending16k, chunk);
    const featureFrameCount = Math.floor((combined.length - FRAME_LENGTH) / FRAME_SHIFT) + 1;

    if (featureFrameCount > 0) {
      const usableSamples = ((featureFrameCount - 1) * FRAME_SHIFT) + FRAME_LENGTH;
      const { data, frameCount: builtFrameCount } = await buildFireRedFbankFeaturesCooperative(
        combined.slice(0, usableSamples),
        runtime
      );
      probabilityChunks.push(await runAedFeatures(runtime, data, builtFrameCount));
      pending16k = combined.slice(featureFrameCount * FRAME_SHIFT);
    } else {
      pending16k = combined;
    }

    if (typeof onProgress === 'function') {
      onProgress({
        phase: progressPhase,
        ratio: Math.min(1, (offset + chunk.length) / totalSamples),
      });
    }
    await yieldToEventLoop();
  }

  if (!probabilityChunks.length) return [];
  const probabilities = concatProbabilityChunks(probabilityChunks);
  const stats = attachAudioFeatureStats(buildHalfSecondStatsFromProbabilities(probabilities, runtime), energyState);
  const temporalHeadResult = await runTemporalHeadBatch(runtime, stats, onProgress);
  return buildOfflineAnalysisFrames(stats, temporalHeadResult, runtime, timeOffsetSec);
}

async function switchAedRuntimeToWasm(runtime, error) {
  if (!runtime || runtime.executionProvider !== PROVIDER_WEBGPU) return false;
  console.warn('FireRed AED WebGPU run failed; switching AED session to WASM.', error);
  const fallbackSession = await createWasmOrtSession(runtime.ort, runtime.modelUrl);
  await releaseOrtSession(runtime.session);
  runtime.session = fallbackSession;
  runtime.executionProvider = PROVIDER_WASM;
  runtime.runtimeInfo = {
    ...(runtime.runtimeInfo || runtime.wasmThreadConfig || {}),
    executionProvider: PROVIDER_WASM,
    webGpuRunFallbackError: serializeRuntimeError(error),
  };
  return true;
}

async function runAedSession(runtime, feeds) {
  return enqueueRuntimeRun(runtime, 'aed', async () => {
    try {
      return await runtime.session.run(feeds);
    } catch (error) {
      if (isSessionBusyError(error)) throw error;
      const switched = await switchAedRuntimeToWasm(runtime, error);
      if (!switched) throw error;
      return runtime.session.run(feeds);
    }
  });
}

async function switchTemporalHeadToWasm(runtime, error) {
  const temporalHead = runtime?.temporalHead;
  if (!runtime || !temporalHead || temporalHead.executionProvider !== PROVIDER_WEBGPU) return false;
  console.warn('FireRed temporal head WebGPU run failed; switching temporal head to WASM.', error);
  const fallbackSession = await createWasmOrtSession(runtime.ort, temporalHead.modelUrl);
  await releaseOrtSession(temporalHead.session);
  temporalHead.session = fallbackSession;
  temporalHead.executionProvider = PROVIDER_WASM;
  temporalHead.providerAttempts = [
    ...(Array.isArray(temporalHead.providerAttempts) ? temporalHead.providerAttempts : []),
    { provider: PROVIDER_WEBGPU, runError: serializeRuntimeError(error) },
  ];
  runtime.runtimeInfo = {
    ...(runtime.runtimeInfo || runtime.wasmThreadConfig || {}),
    temporalHeadExecutionProvider: PROVIDER_WASM,
    temporalHeadWebGpuRunFallbackError: serializeRuntimeError(error),
  };
  return true;
}

async function runTemporalHeadSession(runtime, feeds) {
  const temporalHead = runtime.temporalHead;
  return enqueueRuntimeRun(runtime, 'temporal-head', async () => {
    try {
      return await temporalHead.session.run(feeds);
    } catch (error) {
      if (isSessionBusyError(error)) throw error;
      const switched = await switchTemporalHeadToWasm(runtime, error);
      if (!switched) throw error;
      return temporalHead.session.run(feeds);
    }
  });
}

async function runAedFeatures(runtime, features, frameCount) {
  if (!frameCount || !features.length) return new Float32Array(0);
  const feeds = {
    [runtime.inputName]: new runtime.ort.Tensor('float32', features, [1, frameCount, FEATURE_DIM]),
  };
  const outputs = await runAedSession(runtime, feeds);
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

function appendAudioFeatureWindows(state, samples16k, runtime) {
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
    const spectrum = summarizeAudioSpectrum(samples.slice(offset, offset + windowSamples), runtime, windowSamples, state.previousSpectrum);
    state.spectralCentroid.push(spectrum.spectralCentroid);
    state.spectralFlatness.push(spectrum.spectralFlatness);
    state.spectralFlux.push(spectrum.spectralFlux);
    state.lowEnergyRatio.push(spectrum.lowEnergyRatio);
    state.midEnergyRatio.push(spectrum.midEnergyRatio);
    state.highEnergyRatio.push(spectrum.highEnergyRatio);
    state.previousSpectrum = spectrum.normalizedSpectrum;
    offset += windowSamples;
  }

  state.pending = samples.slice(offset);
}

function attachAudioFeatureStats(stats, energyState) {
  const count = stats.timeSec.length;
  stats.audio_rms = new Float32Array(count);
  stats.audio_peak = new Float32Array(count);
  stats.spectral_centroid = new Float32Array(count);
  stats.spectral_flatness = new Float32Array(count);
  stats.spectral_flux = new Float32Array(count);
  stats.low_energy_ratio = new Float32Array(count);
  stats.mid_energy_ratio = new Float32Array(count);
  stats.high_energy_ratio = new Float32Array(count);

  const available = Math.min(count, energyState.rms.length, energyState.peak.length);
  for (let index = 0; index < available; index += 1) {
    stats.audio_rms[index] = energyState.rms[index] || 0;
    stats.audio_peak[index] = energyState.peak[index] || 0;
    stats.spectral_centroid[index] = energyState.spectralCentroid[index] || 0;
    stats.spectral_flatness[index] = energyState.spectralFlatness[index] || 0;
    stats.spectral_flux[index] = energyState.spectralFlux[index] || 0;
    stats.low_energy_ratio[index] = energyState.lowEnergyRatio[index] || 0;
    stats.mid_energy_ratio[index] = energyState.midEnergyRatio[index] || 0;
    stats.high_energy_ratio[index] = energyState.highEnergyRatio[index] || 0;
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
    const outputs = await runTemporalHeadSession(runtime, feeds);
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
      spectralCentroid: stats.spectral_centroid?.[index] || 0,
      spectralFlatness: stats.spectral_flatness?.[index] || 0,
      spectralFlux: stats.spectral_flux?.[index] || 0,
      lowEnergyRatio: stats.low_energy_ratio?.[index] || 0,
      midEnergyRatio: stats.mid_energy_ratio?.[index] || 0,
      highEnergyRatio: stats.high_energy_ratio?.[index] || 0,
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
    return this.runtime?.runtimeInfo || this.runtime?.wasmThreadConfig || null;
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
    const energyState = {
      pending: new Float32Array(0),
      previousSpectrum: null,
      rms: [],
      peak: [],
      spectralCentroid: [],
      spectralFlatness: [],
      spectralFlux: [],
      lowEnergyRatio: [],
      midEnergyRatio: [],
      highEnergyRatio: [],
    };

    for (let offset = boundedStartFrame; offset < boundedEndFrame; offset += sourceChunkFrames) {
      const frameCount = Math.min(sourceChunkFrames, boundedEndFrame - offset);
      const mono = mixAudioBufferChunkToMono(audioBuffer, offset, frameCount);
      const targetLength = Math.max(0, Math.round(mono.length * TARGET_SAMPLE_RATE / sourceSampleRate));
      const resampled = targetLength > 0 ? resampleLinear(mono, targetLength) : new Float32Array(0);
      appendAudioFeatureWindows(energyState, resampled, this.runtime);
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
    const stats = attachAudioFeatureStats(buildHalfSecondStatsFromProbabilities(probabilities, this.runtime), energyState);
    const temporalHeadResult = await runTemporalHeadBatch(this.runtime, stats, onProgress);
    return buildOfflineAnalysisFrames(stats, temporalHeadResult, this.runtime, timeOffsetSec);
  }
}

export class FireRedAedSongDetector {
  constructor({ sourceSampleRate, chunkSec = 30 * 60, overlapSec = 120 }) {
    this.detectorMode = DETECTOR_MODES.FIRERED_AED;
    this.detectorVersion = FIRERED_AED_DETECTOR_VERSION;
    this.sourceSampleRate = Math.max(8000, Number(sourceSampleRate) || 48000);
    this.audioBuffer = null;
    this.runtime = null;
    this.temporalHeadHistory = [];
    this.spectralState = { previousSpectrum: null };
    this.chunkSec = Math.max(60, Number(chunkSec) || (30 * 60));
    this.overlapSec = Math.max(0, Number(overlapSec) || 120);
    this.frameBuilder = null;
    this.pendingFrames = [];
  }

  async initialize() {
    this.runtime = await loadFireRedAedRuntime();
    this.detectorVersion = this.runtime.detectorVersion;
    this.frameBuilder = new StreamingFrameBuilder({
      sourceSampleRate: this.sourceSampleRate,
      chunkSec: this.chunkSec,
      overlapSec: this.overlapSec,
      analyzeInt16Chunk: async (pcm16, options = {}) => analyzeSamples16kToFrames(
        this.runtime,
        int16ToFloat32(pcm16),
        {
          timeOffsetSec: options.timeOffsetSec,
          onProgress: options.onProgress,
          progressPhase: 'live-aed',
          internalChunkSec: 60,
        }
      ),
    });
  }

  pushAudioChunk(samples) {
    if (!samples || !samples.length) return;
    if (this.frameBuilder) {
      this.frameBuilder.pushFloat32(samples);
    }
  }

  getDetectorVersion() {
    return this.detectorVersion;
  }

  getSongThreshold() {
    return this.runtime?.songThreshold || 0.56;
  }

  getRuntimeInfo() {
    const base = this.runtime?.runtimeInfo || this.runtime?.wasmThreadConfig || null;
    return {
      ...(base || {}),
      liveFrameBuilder: {
        mode: 'half-hour-pcm-rollover-aed-cache',
        sourceSampleRate: this.sourceSampleRate,
        targetSampleRate: TARGET_SAMPLE_RATE,
        chunkSec: this.chunkSec,
        overlapSec: this.overlapSec,
        bufferedPcm: this.getBufferedPcmSummary(),
      },
    };
  }

  resetAnalysisState() {
    if (this.audioBuffer) this.audioBuffer.clear();
    this.temporalHeadHistory = [];
    this.spectralState = { previousSpectrum: null };
    this.pendingFrames = [];
    if (this.frameBuilder) this.frameBuilder.reset();
  }

  setTimeOffsetSec(value) {
    if (this.frameBuilder) this.frameBuilder.setTimeOffsetSec(value);
  }

  getBufferedPcmSummary() {
    return {
      bufferedSec: this.frameBuilder ? roundNumber(this.frameBuilder.getBufferedPcmSec(), 3) : 0,
      bufferedBytes: this.frameBuilder ? this.frameBuilder.getBufferedPcmBytes() : 0,
      chunkSec: this.chunkSec,
      overlapSec: this.overlapSec,
    };
  }

  async flushPendingFrames({ onProgress = null } = {}) {
    if (!this.runtime || !this.frameBuilder) return [];
    const frames = await this.frameBuilder.flushReadyChunks({ force: true, onProgress });
    if (frames.length) this.pendingFrames.push(...frames);
    const output = this.pendingFrames;
    this.pendingFrames = [];
    return output;
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
    const outputs = await runTemporalHeadSession(this.runtime, feeds);
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
    if (!this.runtime || !this.frameBuilder) return { ready: false, songProbability: 0, frames: [] };
    const frames = await this.frameBuilder.flushReadyChunks({ force: false });
    if (frames.length) this.pendingFrames.push(...frames);
    if (!this.pendingFrames.length) {
      return {
        ready: false,
        songProbability: 0,
        frames: [],
        bufferedPcm: this.getBufferedPcmSummary(),
      };
    }
    const output = this.pendingFrames;
    this.pendingFrames = [];
    return {
      ready: true,
      songProbability: Number(output[output.length - 1]?.songProbability) || 0,
      frames: output,
      bufferedPcm: this.getBufferedPcmSummary(),
    };
  }
}
