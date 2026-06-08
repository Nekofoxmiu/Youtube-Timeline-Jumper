import { normalizeAnalysisFrames } from './analysisFrame.js';
import { clamp, roundNumber } from './common.js';

export const THRESHOLD_WINDOW_ADVISOR_VERSION = 'threshold-window-advisor-v1';

export const THRESHOLD_WINDOW_ADVISOR_PROFILES = Object.freeze({
  'offline-final': Object.freeze({ key: 'offline-final', stem: 'threshold_window_advisor_offline_final' }),
  'live-pcm30': Object.freeze({ key: 'live-pcm30', stem: 'threshold_window_advisor_live_pcm30' }),
  'live-realtime-aed60': Object.freeze({ key: 'live-realtime-aed60', stem: 'threshold_window_advisor_live_aed60' }),
});

export const THRESHOLD_WINDOW_ADVISOR_FEATURE_NAMES = Object.freeze([
  'window_duration_sec',
  'window_frame_count',
  'relative_center',
  'temporal_mean',
  'temporal_p10',
  'temporal_p50',
  'temporal_p90',
  'temporal_std',
  'temporal_above_threshold_ratio',
  'singing_mean',
  'singing_p50',
  'singing_p90',
  'singing_ratio_mean',
  'singing_ratio_p90',
  'music_mean',
  'music_p50',
  'music_p90',
  'music_ratio_mean',
  'music_ratio_p90',
  'speech_mean',
  'speech_p50',
  'speech_p90',
  'speech_ratio_mean',
  'speech_ratio_p90',
  'audio_rms_mean',
  'audio_rms_p90',
  'audio_peak_mean',
  'audio_peak_p90',
  'spectral_flatness_mean',
  'spectral_flatness_p90',
  'spectral_flux_mean',
  'spectral_flux_p90',
  'low_energy_ratio_mean',
  'mid_energy_ratio_mean',
  'high_energy_ratio_mean',
  'strict_silence_ratio',
  'low_energy_frame_ratio',
  'music_only_like_ratio',
  'vocal_like_ratio',
  'speech_like_ratio',
  'music_minus_singing',
  'music_minus_speech',
  'temporal_minus_context',
  'singing_minus_context',
  'music_minus_context',
  'speech_minus_context',
  'rms_minus_context',
  'prev_temporal_mean',
  'next_temporal_mean',
  'prev_singing_mean',
  'next_singing_mean',
  'prev_music_only_like_ratio',
  'next_music_only_like_ratio',
  'source_offline_final',
  'source_live_pcm30',
  'source_live_aed60',
]);

const PROFILE_ALIASES = Object.freeze({
  'pcm-rollover-30min': 'live-pcm30',
  'aed-cache-60s': 'live-realtime-aed60',
});

const DEFAULT_OPTIONS = Object.freeze({
  windowSec: 30,
  hopSec: 5,
  contextSec: 120,
  minFrames: 20,
  minConfidence: 0.35,
  deltaMin: -0.08,
  deltaMax: 0.10,
  smoothingPasses: 2,
});

function finite(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function probability(value, fallback = 0) {
  return clamp(finite(value, fallback), 0, 1);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function quantile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * clamp(ratio, 0, 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + ((next - sorted[base]) * rest);
}

function ratio(items, predicate) {
  if (!items.length) return 0;
  let count = 0;
  for (const item of items) {
    if (predicate(item)) count += 1;
  }
  return count / items.length;
}

function values(frames, getter) {
  return frames.map(getter).filter((value) => Number.isFinite(value));
}

function frameThreshold(frame) {
  return probability(frame?.temporalHeadThreshold, 0.75);
}

function frameProbability(frame, key, fallbackKey = null) {
  return probability(frame?.[key] ?? (fallbackKey ? frame?.[fallbackKey] : undefined), 0);
}

function framesInRange(frames, startSec, endSec) {
  return frames.filter((frame) => frame.timeSec >= startSec && frame.timeSec < endSec);
}

function summarizeFrames(frames) {
  const temporal = values(frames, (frame) => probability(frame.temporalHeadProbability ?? frame.songProbability));
  const thresholds = values(frames, frameThreshold);
  const singing = values(frames, (frame) => frameProbability(frame, 'singingProbability', 'singingMean'));
  const music = values(frames, (frame) => frameProbability(frame, 'musicProbability', 'musicMean'));
  const speech = values(frames, (frame) => frameProbability(frame, 'speechProbability', 'speechMean'));
  const singingRatio = values(frames, (frame) => probability(frame.singingRatio));
  const musicRatio = values(frames, (frame) => probability(frame.musicRatio));
  const speechRatio = values(frames, (frame) => probability(frame.speechRatio));
  const rms = values(frames, (frame) => Math.max(0, finite(frame.audioRms, 0)));
  const peak = values(frames, (frame) => Math.max(0, finite(frame.audioPeak, 0)));
  const flatness = values(frames, (frame) => probability(frame.spectralFlatness));
  const flux = values(frames, (frame) => probability(frame.spectralFlux));
  const lowEnergy = values(frames, (frame) => probability(frame.lowEnergyRatio));
  const midEnergy = values(frames, (frame) => probability(frame.midEnergyRatio));
  const highEnergy = values(frames, (frame) => probability(frame.highEnergyRatio));
  const thresholdMean = mean(thresholds) || 0.75;

  return {
    frameCount: frames.length,
    temporalMean: mean(temporal),
    temporalP10: quantile(temporal, 0.1),
    temporalP50: quantile(temporal, 0.5),
    temporalP90: quantile(temporal, 0.9),
    temporalStd: std(temporal),
    temporalAboveThresholdRatio: ratio(frames, (frame) => probability(frame.temporalHeadProbability ?? frame.songProbability) >= thresholdMean),
    singingMean: mean(singing),
    singingP50: quantile(singing, 0.5),
    singingP90: quantile(singing, 0.9),
    singingRatioMean: mean(singingRatio),
    singingRatioP90: quantile(singingRatio, 0.9),
    musicMean: mean(music),
    musicP50: quantile(music, 0.5),
    musicP90: quantile(music, 0.9),
    musicRatioMean: mean(musicRatio),
    musicRatioP90: quantile(musicRatio, 0.9),
    speechMean: mean(speech),
    speechP50: quantile(speech, 0.5),
    speechP90: quantile(speech, 0.9),
    speechRatioMean: mean(speechRatio),
    speechRatioP90: quantile(speechRatio, 0.9),
    audioRmsMean: mean(rms),
    audioRmsP90: quantile(rms, 0.9),
    audioPeakMean: mean(peak),
    audioPeakP90: quantile(peak, 0.9),
    spectralFlatnessMean: mean(flatness),
    spectralFlatnessP90: quantile(flatness, 0.9),
    spectralFluxMean: mean(flux),
    spectralFluxP90: quantile(flux, 0.9),
    lowEnergyRatioMean: mean(lowEnergy),
    midEnergyRatioMean: mean(midEnergy),
    highEnergyRatioMean: mean(highEnergy),
    strictSilenceRatio: ratio(frames, (frame) => finite(frame.audioRms, 1) <= 0.0045 && finite(frame.audioPeak, 1) <= 0.018),
    lowEnergyFrameRatio: ratio(frames, (frame) => finite(frame.audioRms, 1) <= 0.006 || finite(frame.audioPeak, 1) <= 0.025 || probability(frame.lowEnergyRatio) >= 0.72),
    musicOnlyLikeRatio: ratio(frames, (frame) => (
      frameProbability(frame, 'musicProbability', 'musicMean') >= 0.58
      && frameProbability(frame, 'singingProbability', 'singingMean') <= 0.28
      && frameProbability(frame, 'speechProbability', 'speechMean') <= 0.42
      && probability(frame.temporalHeadProbability ?? frame.songProbability) <= 0.52
    )),
    vocalLikeRatio: ratio(frames, (frame) => (
      frameProbability(frame, 'singingProbability', 'singingMean') >= 0.4
      || probability(frame.temporalHeadProbability ?? frame.songProbability) >= 0.55
    )),
    speechLikeRatio: ratio(frames, (frame) => (
      frameProbability(frame, 'speechProbability', 'speechMean') >= 0.58
      && frameProbability(frame, 'singingProbability', 'singingMean') <= 0.38
    )),
  };
}

function buildFeatureVectorForWindow(frames, centerSec, options) {
  const windowSec = finite(options.windowSec, DEFAULT_OPTIONS.windowSec);
  const contextSec = finite(options.contextSec, DEFAULT_OPTIONS.contextSec);
  const halfWindow = windowSec / 2;
  const halfContext = contextSec / 2;
  const firstSec = frames.length ? frames[0].timeSec : 0;
  const lastSec = frames.length ? frames[frames.length - 1].timeSec : firstSec;
  const duration = Math.max(0.001, lastSec - firstSec);
  const startSec = centerSec - halfWindow;
  const endSec = centerSec + halfWindow;
  const windowFrames = framesInRange(frames, startSec, endSec);
  const contextFrames = framesInRange(frames, centerSec - halfContext, centerSec + halfContext);
  const prevFrames = framesInRange(frames, centerSec - contextSec, startSec);
  const nextFrames = framesInRange(frames, endSec, centerSec + contextSec);
  const windowStats = summarizeFrames(windowFrames);
  const contextStats = summarizeFrames(contextFrames.length ? contextFrames : windowFrames);
  const prevStats = summarizeFrames(prevFrames);
  const nextStats = summarizeFrames(nextFrames);
  const profile = normalizeThresholdWindowAdvisorProfile(options.profile);

  return [
    windowSec,
    windowStats.frameCount,
    clamp((centerSec - firstSec) / duration, 0, 1),
    windowStats.temporalMean,
    windowStats.temporalP10,
    windowStats.temporalP50,
    windowStats.temporalP90,
    windowStats.temporalStd,
    windowStats.temporalAboveThresholdRatio,
    windowStats.singingMean,
    windowStats.singingP50,
    windowStats.singingP90,
    windowStats.singingRatioMean,
    windowStats.singingRatioP90,
    windowStats.musicMean,
    windowStats.musicP50,
    windowStats.musicP90,
    windowStats.musicRatioMean,
    windowStats.musicRatioP90,
    windowStats.speechMean,
    windowStats.speechP50,
    windowStats.speechP90,
    windowStats.speechRatioMean,
    windowStats.speechRatioP90,
    windowStats.audioRmsMean,
    windowStats.audioRmsP90,
    windowStats.audioPeakMean,
    windowStats.audioPeakP90,
    windowStats.spectralFlatnessMean,
    windowStats.spectralFlatnessP90,
    windowStats.spectralFluxMean,
    windowStats.spectralFluxP90,
    windowStats.lowEnergyRatioMean,
    windowStats.midEnergyRatioMean,
    windowStats.highEnergyRatioMean,
    windowStats.strictSilenceRatio,
    windowStats.lowEnergyFrameRatio,
    windowStats.musicOnlyLikeRatio,
    windowStats.vocalLikeRatio,
    windowStats.speechLikeRatio,
    windowStats.musicMean - windowStats.singingMean,
    windowStats.musicMean - windowStats.speechMean,
    windowStats.temporalMean - contextStats.temporalMean,
    windowStats.singingMean - contextStats.singingMean,
    windowStats.musicMean - contextStats.musicMean,
    windowStats.speechMean - contextStats.speechMean,
    windowStats.audioRmsMean - contextStats.audioRmsMean,
    prevStats.temporalMean,
    nextStats.temporalMean,
    prevStats.singingMean,
    nextStats.singingMean,
    prevStats.musicOnlyLikeRatio,
    nextStats.musicOnlyLikeRatio,
    profile === 'offline-final' ? 1 : 0,
    profile === 'live-pcm30' ? 1 : 0,
    profile === 'live-realtime-aed60' ? 1 : 0,
  ];
}

function smoothWindowOutputs(windows, passes = DEFAULT_OPTIONS.smoothingPasses) {
  let output = windows.map((window) => ({ ...window }));
  for (let pass = 0; pass < passes; pass += 1) {
    output = output.map((window, index) => {
      const prev = output[index - 1] || window;
      const next = output[index + 1] || window;
      return {
        ...window,
        delta: ((prev.delta * 0.25) + (window.delta * 0.5) + (next.delta * 0.25)),
        confidence: Math.max(window.confidence, prev.confidence * 0.8, next.confidence * 0.8),
      };
    });
  }
  return output;
}

function interpolateWindowDelta(windows, timeSec) {
  if (!windows.length) return null;
  if (timeSec <= windows[0].centerSec) return windows[0];
  const last = windows[windows.length - 1];
  if (timeSec >= last.centerSec) return last;
  for (let index = 1; index < windows.length; index += 1) {
    const right = windows[index];
    if (timeSec > right.centerSec) continue;
    const left = windows[index - 1];
    const span = Math.max(0.001, right.centerSec - left.centerSec);
    const ratio = clamp((timeSec - left.centerSec) / span, 0, 1);
    return {
      centerSec: timeSec,
      delta: (left.delta * (1 - ratio)) + (right.delta * ratio),
      confidence: Math.max(left.confidence * (1 - ratio), right.confidence * ratio),
      reasonCodes: [...new Set([...(left.reasonCodes || []), ...(right.reasonCodes || [])])],
    };
  }
  return last;
}

function extensionAssetUrl(fileName, basePath = 'models/fireredvad/aed') {
  const path = `${String(basePath || '').replace(/\/+$/, '')}/${fileName}`;
  return globalThis.chrome?.runtime?.getURL
    ? chrome.runtime.getURL(path)
    : path;
}

async function loadJsonOrNull(url) {
  return fetch(url)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
}

export function normalizeThresholdWindowAdvisorProfile(profile, fallback = 'offline-final') {
  const key = String(profile || '').trim().toLowerCase();
  const aliased = PROFILE_ALIASES[key] || key;
  if (Object.prototype.hasOwnProperty.call(THRESHOLD_WINDOW_ADVISOR_PROFILES, aliased)) return aliased;
  return Object.prototype.hasOwnProperty.call(THRESHOLD_WINDOW_ADVISOR_PROFILES, fallback)
    ? fallback
    : 'offline-final';
}

export function thresholdWindowAdvisorAssetNames(profile = 'offline-final') {
  const key = normalizeThresholdWindowAdvisorProfile(profile);
  const config = THRESHOLD_WINDOW_ADVISOR_PROFILES[key];
  return {
    profile: key,
    model: `${config.stem}.onnx`,
    meta: `${config.stem}.meta.json`,
  };
}

export function noThresholdWindowAdvice(reason = 'disabled', profile = 'offline-final') {
  return {
    version: THRESHOLD_WINDOW_ADVISOR_VERSION,
    enabled: false,
    applied: false,
    profile: normalizeThresholdWindowAdvisorProfile(profile),
    windowCount: 0,
    appliedWindowCount: 0,
    meanDelta: 0,
    maxAbsDelta: 0,
    reasonCodes: [reason],
  };
}

export function buildThresholdWindowFeatureVector(frames, centerSec, options = {}) {
  const normalized = normalizeAnalysisFrames(frames);
  return buildFeatureVectorForWindow(normalized, Number(centerSec) || 0, options);
}

export function buildThresholdWindowFeatureMatrix(frames, options = {}) {
  const normalized = normalizeAnalysisFrames(frames).filter((frame) => frame.ready);
  if (normalized.length < Math.max(1, finite(options.minFrames, DEFAULT_OPTIONS.minFrames))) return [];
  const hopSec = Math.max(0.5, finite(options.hopSec, DEFAULT_OPTIONS.hopSec));
  const firstSec = normalized[0].timeSec;
  const lastSec = normalized[normalized.length - 1].timeSec;
  const windows = [];
  for (let centerSec = firstSec; centerSec <= lastSec + 0.001; centerSec += hopSec) {
    const featureVector = buildFeatureVectorForWindow(normalized, centerSec, options);
    windows.push({
      centerSec: roundNumber(centerSec, 3),
      featureVector,
    });
  }
  return windows;
}

export function applyThresholdWindowAdviceToFrames(frames, advice, options = {}) {
  const normalized = normalizeAnalysisFrames(frames);
  const profile = normalizeThresholdWindowAdvisorProfile(options.profile || advice?.profile);
  const windows = Array.isArray(advice?.windows) ? advice.windows : [];
  if (!advice?.applied || !windows.length) {
    return {
      frames: normalized,
      advice: advice || noThresholdWindowAdvice('not-applied', profile),
    };
  }

  const minDelta = finite(options.deltaMin, DEFAULT_OPTIONS.deltaMin);
  const maxDelta = finite(options.deltaMax, DEFAULT_OPTIONS.deltaMax);
  const output = normalized.map((frame) => {
    const interpolated = interpolateWindowDelta(windows, frame.timeSec);
    const delta = clamp(finite(interpolated?.delta, 0), minDelta, maxDelta);
    const baseThreshold = probability(frame.temporalHeadThreshold, 0.75);
    return {
      ...frame,
      temporalHeadThreshold: roundNumber(clamp(baseThreshold + delta, 0.05, 0.95), 4),
      thresholdWindowAdvice: {
        version: THRESHOLD_WINDOW_ADVISOR_VERSION,
        baseTemporalHeadThreshold: roundNumber(baseThreshold, 4),
        temporalHeadThresholdDelta: roundNumber(delta, 4),
        confidence: roundNumber(finite(interpolated?.confidence, 0), 4),
        reasonCodes: interpolated?.reasonCodes || [],
      },
    };
  });
  return { frames: output, advice };
}

export async function loadThresholdWindowAdvisorModel({
  ort,
  assetProfile = 'offline-final',
  basePath = 'models/fireredvad/aed',
  modelUrl = null,
  metaUrl = null,
  executionProviders = ['wasm'],
  requireAssetProfile = false,
} = {}) {
  if (!ort?.InferenceSession) {
    throw new Error('ONNX Runtime is unavailable for threshold window advisor.');
  }
  const names = thresholdWindowAdvisorAssetNames(assetProfile);
  const resolvedModelUrl = modelUrl || extensionAssetUrl(names.model, basePath);
  const resolvedMetaUrl = metaUrl || extensionAssetUrl(names.meta, basePath);
  const [session, meta] = await Promise.all([
    ort.InferenceSession.create(resolvedModelUrl, { executionProviders }),
    loadJsonOrNull(resolvedMetaUrl),
  ]);
  if (requireAssetProfile && meta?.assetProfile && meta.assetProfile !== names.profile) {
    throw new Error(`threshold window advisor profile mismatch: expected ${names.profile}, got ${meta.assetProfile}`);
  }
  return {
    ort,
    session,
    meta: meta || {},
    assetProfile: meta?.assetProfile || names.profile,
  };
}

export async function runThresholdWindowAdvisorModel(runtime, frames, {
  profile = runtime?.assetProfile || 'offline-final',
  stage = 'smoothing',
} = {}) {
  const normalized = normalizeAnalysisFrames(frames).filter((frame) => frame.ready);
  const meta = runtime?.meta || {};
  const options = {
    profile,
    windowSec: finite(meta.windowSec, DEFAULT_OPTIONS.windowSec),
    hopSec: finite(meta.windowHopSec, DEFAULT_OPTIONS.hopSec),
    contextSec: finite(meta.contextSec, DEFAULT_OPTIONS.contextSec),
    minFrames: finite(meta.minFrames, DEFAULT_OPTIONS.minFrames),
    deltaMin: finite(meta.deltaMin, DEFAULT_OPTIONS.deltaMin),
    deltaMax: finite(meta.deltaMax, DEFAULT_OPTIONS.deltaMax),
    smoothingPasses: finite(meta.smoothingPasses, DEFAULT_OPTIONS.smoothingPasses),
  };
  const windows = buildThresholdWindowFeatureMatrix(normalized, options);
  if (!windows.length) {
    return {
      frames: normalized,
      advice: noThresholdWindowAdvice('too-few-frames', profile),
    };
  }
  const ort = runtime?.ort || globalThis.ort;
  const session = runtime?.session;
  if (!ort?.Tensor || !session?.run) {
    return {
      frames: normalized,
      advice: noThresholdWindowAdvice('runtime-unavailable', profile),
    };
  }

  const inputName = meta.inputName || session.inputNames?.[0] || 'threshold_window_features';
  const outputName = meta.outputName || session.outputNames?.[0] || 'threshold_window_outputs';
  const inputDim = Number(meta.inputDim) || THRESHOLD_WINDOW_ADVISOR_FEATURE_NAMES.length;
  const input = new Float32Array(windows.length * inputDim);
  for (let row = 0; row < windows.length; row += 1) {
    const vector = windows[row].featureVector;
    for (let col = 0; col < inputDim; col += 1) {
      input[(row * inputDim) + col] = Number(vector[col]) || 0;
    }
  }
  const result = await session.run({ [inputName]: new ort.Tensor('float32', input, [windows.length, inputDim]) });
  const tensor = result[outputName] || result[Object.keys(result)[0]];
  const data = tensor?.data || [];
  const minConfidence = finite(meta.minConfidence, DEFAULT_OPTIONS.minConfidence);
  const deltaMin = finite(meta.deltaMin, DEFAULT_OPTIONS.deltaMin);
  const deltaMax = finite(meta.deltaMax, DEFAULT_OPTIONS.deltaMax);
  const rawWindows = windows.map((window, index) => {
    const offset = index * 2;
    const confidence = clamp(finite(data[offset + 1], 0), 0, 1);
    const applied = confidence >= minConfidence;
    const delta = applied ? clamp(finite(data[offset], 0), deltaMin, deltaMax) : 0;
    return {
      centerSec: window.centerSec,
      delta,
      confidence,
      applied,
      reasonCodes: [`model:${stage}`],
    };
  });
  const smoothedWindows = smoothWindowOutputs(rawWindows, Math.max(0, Math.round(options.smoothingPasses)));
  const appliedWindowCount = smoothedWindows.filter((window) => Math.abs(window.delta) > 0.0001).length;
  const deltas = smoothedWindows.map((window) => window.delta);
  const advice = {
    version: THRESHOLD_WINDOW_ADVISOR_VERSION,
    enabled: true,
    applied: appliedWindowCount > 0,
    profile: normalizeThresholdWindowAdvisorProfile(profile),
    assetProfile: runtime.assetProfile,
    windowSec: options.windowSec,
    windowHopSec: options.hopSec,
    contextSec: options.contextSec,
    windowCount: smoothedWindows.length,
    appliedWindowCount,
    meanDelta: roundNumber(mean(deltas), 5),
    maxAbsDelta: roundNumber(Math.max(0, ...deltas.map((value) => Math.abs(value))), 5),
    reasonCodes: [`model:${stage}`],
    windows: smoothedWindows.map((window) => ({
      centerSec: roundNumber(window.centerSec, 3),
      delta: roundNumber(window.delta, 5),
      confidence: roundNumber(window.confidence, 4),
      applied: Boolean(window.applied),
      reasonCodes: window.reasonCodes,
    })),
  };
  return applyThresholdWindowAdviceToFrames(normalized, advice, options);
}

