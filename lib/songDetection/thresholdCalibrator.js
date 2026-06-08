import { normalizeAnalysisFrames } from './analysisFrame.js';
import { clamp, roundNumber } from './common.js';

export const THRESHOLD_CALIBRATOR_VERSION = 'threshold-calibrator-v1';

export const THRESHOLD_CALIBRATOR_PROFILES = Object.freeze({
  'offline-final': Object.freeze({
    key: 'offline-final',
    stem: 'threshold_calibrator_offline_final',
  }),
  'live-pcm30': Object.freeze({
    key: 'live-pcm30',
    stem: 'threshold_calibrator_live_pcm30',
  }),
  'live-realtime-aed60': Object.freeze({
    key: 'live-realtime-aed60',
    stem: 'threshold_calibrator_live_aed60',
  }),
});

export const THRESHOLD_CALIBRATOR_BOUNDS = Object.freeze({
  temporalHeadThresholdDelta: Object.freeze({ min: -0.1, max: 0.12 }),
  segmentKeepThresholdDelta: Object.freeze({ min: -0.12, max: 0.18 }),
  trimConfidenceThresholdDelta: Object.freeze({ min: -0.1, max: 0.12 }),
});

export const THRESHOLD_CALIBRATOR_FEATURE_NAMES = Object.freeze([
  'duration_sec',
  'frame_count',
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
  'audio_rms_p50',
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
  'discontinuity_ratio',
  'music_only_like_ratio',
  'vocal_like_ratio',
  'speech_like_ratio',
  'music_minus_singing',
  'music_minus_speech',
  'temporal_minus_baseline',
  'singing_minus_baseline',
  'music_minus_baseline',
  'speech_minus_baseline',
  'rms_minus_baseline',
  'repetition_score',
  'repetition_music_only_window_ratio',
  'repetition_vocal_window_ratio',
  'source_offline_final',
  'source_live_pcm30',
  'source_live_aed60',
]);

const PROFILE_ALIASES = Object.freeze({
  'pcm-rollover-30min': 'live-pcm30',
  'aed-cache-60s': 'live-realtime-aed60',
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

function frameValue(frame, primary, fallback = 0) {
  return probability(frame?.[primary], fallback);
}

function frameTemporalThreshold(frame) {
  return probability(frame?.temporalHeadThreshold, 0.75);
}

function values(frames, getter) {
  return frames.map(getter).filter((value) => Number.isFinite(value));
}

function summarizeFrames(frames) {
  const temporal = values(frames, (frame) => probability(frame.temporalHeadProbability ?? frame.songProbability));
  const thresholds = values(frames, frameTemporalThreshold);
  const singing = values(frames, (frame) => frameValue(frame, 'singingProbability', frameValue(frame, 'singingMean')));
  const music = values(frames, (frame) => frameValue(frame, 'musicProbability', frameValue(frame, 'musicMean')));
  const speech = values(frames, (frame) => frameValue(frame, 'speechProbability', frameValue(frame, 'speechMean')));
  const singingRatio = values(frames, (frame) => frameValue(frame, 'singingRatio'));
  const musicRatio = values(frames, (frame) => frameValue(frame, 'musicRatio'));
  const speechRatio = values(frames, (frame) => frameValue(frame, 'speechRatio'));
  const rms = values(frames, (frame) => Math.max(0, finite(frame.audioRms, 0)));
  const peak = values(frames, (frame) => Math.max(0, finite(frame.audioPeak, 0)));
  const flatness = values(frames, (frame) => frameValue(frame, 'spectralFlatness'));
  const flux = values(frames, (frame) => frameValue(frame, 'spectralFlux'));
  const lowEnergy = values(frames, (frame) => frameValue(frame, 'lowEnergyRatio'));
  const midEnergy = values(frames, (frame) => frameValue(frame, 'midEnergyRatio'));
  const highEnergy = values(frames, (frame) => frameValue(frame, 'highEnergyRatio'));
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
    audioRmsP50: quantile(rms, 0.5),
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
    lowEnergyFrameRatio: ratio(frames, (frame) => finite(frame.audioRms, 1) <= 0.006 || finite(frame.audioPeak, 1) <= 0.025 || frameValue(frame, 'lowEnergyRatio') >= 0.72),
    discontinuityRatio: ratio(frames, (frame) => frame.discontinuityBefore || frame.discontinuityAfter),
    musicOnlyLikeRatio: ratio(frames, (frame) => (
      frameValue(frame, 'musicProbability', frameValue(frame, 'musicMean')) >= 0.58
      && frameValue(frame, 'singingProbability', frameValue(frame, 'singingMean')) <= 0.28
      && frameValue(frame, 'speechProbability', frameValue(frame, 'speechMean')) <= 0.42
      && probability(frame.temporalHeadProbability ?? frame.songProbability) <= 0.42
    )),
    vocalLikeRatio: ratio(frames, (frame) => (
      frameValue(frame, 'singingProbability', frameValue(frame, 'singingMean')) >= 0.4
      || probability(frame.temporalHeadProbability ?? frame.songProbability) >= 0.55
    )),
    speechLikeRatio: ratio(frames, (frame) => (
      frameValue(frame, 'speechProbability', frameValue(frame, 'speechMean')) >= 0.58
      && frameValue(frame, 'singingProbability', frameValue(frame, 'singingMean')) <= 0.38
    )),
  };
}

function middleBaselineFrames(frames) {
  if (!frames.length) return [];
  const first = finite(frames[0].timeSec, 0);
  const last = finite(frames[frames.length - 1].timeSec, first);
  const duration = Math.max(0, last - first);
  if (duration < 900) return frames;
  const center = first + (duration * 0.5);
  const halfWindow = Math.min(300, Math.max(150, duration * 0.08));
  return frames.filter((frame) => frame.timeSec >= center - halfWindow && frame.timeSec <= center + halfWindow);
}

export function normalizeThresholdCalibratorProfile(profile, fallback = 'offline-final') {
  const key = String(profile || '').trim().toLowerCase();
  const aliased = PROFILE_ALIASES[key] || key;
  if (Object.prototype.hasOwnProperty.call(THRESHOLD_CALIBRATOR_PROFILES, aliased)) return aliased;
  return Object.prototype.hasOwnProperty.call(THRESHOLD_CALIBRATOR_PROFILES, fallback)
    ? fallback
    : 'offline-final';
}

export function thresholdCalibratorAssetNames(profile = 'offline-final') {
  const key = normalizeThresholdCalibratorProfile(profile);
  const config = THRESHOLD_CALIBRATOR_PROFILES[key];
  return {
    profile: key,
    model: `${config.stem}.onnx`,
    meta: `${config.stem}.meta.json`,
  };
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

function clampDelta(name, value) {
  const bounds = THRESHOLD_CALIBRATOR_BOUNDS[name];
  return clamp(finite(value, 0), bounds.min, bounds.max);
}

function normalizeOutput(raw = {}, meta = {}) {
  const confidence = clamp(finite(raw.confidence, finite(meta.defaultConfidence, 1)), 0, 1);
  return {
    version: THRESHOLD_CALIBRATOR_VERSION,
    enabled: true,
    applied: confidence >= clamp(finite(meta.minConfidence, 0.35), 0, 1),
    confidence: roundNumber(confidence, 4),
    temporalHeadThresholdDelta: roundNumber(clampDelta('temporalHeadThresholdDelta', raw.temporalHeadThresholdDelta), 4),
    segmentKeepThresholdDelta: roundNumber(clampDelta('segmentKeepThresholdDelta', raw.segmentKeepThresholdDelta), 4),
    trimConfidenceThresholdDelta: roundNumber(clampDelta('trimConfidenceThresholdDelta', raw.trimConfidenceThresholdDelta), 4),
    reasonCodes: Array.isArray(raw.reasonCodes) ? raw.reasonCodes : [],
  };
}

export function noThresholdCalibration(reason = 'unavailable', profile = 'offline-final') {
  return {
    version: THRESHOLD_CALIBRATOR_VERSION,
    enabled: false,
    applied: false,
    profile: normalizeThresholdCalibratorProfile(profile),
    confidence: 0,
    temporalHeadThresholdDelta: 0,
    segmentKeepThresholdDelta: 0,
    trimConfidenceThresholdDelta: 0,
    reasonCodes: [reason],
  };
}

export function buildThresholdCalibratorFeatureVector(frames, {
  profile = 'offline-final',
  repetition = null,
} = {}) {
  const normalized = normalizeAnalysisFrames(frames);
  const sourceProfile = normalizeThresholdCalibratorProfile(profile);
  const firstSec = normalized.length ? finite(normalized[0].timeSec, 0) : 0;
  const lastSec = normalized.length ? finite(normalized[normalized.length - 1].timeSec, firstSec) : firstSec;
  const stats = summarizeFrames(normalized);
  const baseline = summarizeFrames(middleBaselineFrames(normalized));
  const repetitionStats = repetition || {};
  return [
    Math.max(0, lastSec - firstSec),
    stats.frameCount,
    stats.temporalMean,
    stats.temporalP10,
    stats.temporalP50,
    stats.temporalP90,
    stats.temporalStd,
    stats.temporalAboveThresholdRatio,
    stats.singingMean,
    stats.singingP50,
    stats.singingP90,
    stats.singingRatioMean,
    stats.singingRatioP90,
    stats.musicMean,
    stats.musicP50,
    stats.musicP90,
    stats.musicRatioMean,
    stats.musicRatioP90,
    stats.speechMean,
    stats.speechP50,
    stats.speechP90,
    stats.speechRatioMean,
    stats.speechRatioP90,
    stats.audioRmsMean,
    stats.audioRmsP50,
    stats.audioRmsP90,
    stats.audioPeakMean,
    stats.audioPeakP90,
    stats.spectralFlatnessMean,
    stats.spectralFlatnessP90,
    stats.spectralFluxMean,
    stats.spectralFluxP90,
    stats.lowEnergyRatioMean,
    stats.midEnergyRatioMean,
    stats.highEnergyRatioMean,
    stats.strictSilenceRatio,
    stats.lowEnergyFrameRatio,
    stats.discontinuityRatio,
    stats.musicOnlyLikeRatio,
    stats.vocalLikeRatio,
    stats.speechLikeRatio,
    stats.musicMean - stats.singingMean,
    stats.musicMean - stats.speechMean,
    stats.temporalMean - baseline.temporalMean,
    stats.singingMean - baseline.singingMean,
    stats.musicMean - baseline.musicMean,
    stats.speechMean - baseline.speechMean,
    stats.audioRmsMean - baseline.audioRmsMean,
    probability(repetitionStats.score),
    probability(repetitionStats.musicOnlyWindowRatio),
    probability(repetitionStats.vocalWindowRatio),
    sourceProfile === 'offline-final' ? 1 : 0,
    sourceProfile === 'live-pcm30' ? 1 : 0,
    sourceProfile === 'live-realtime-aed60' ? 1 : 0,
  ].map((value) => finite(value, 0));
}

export function buildThresholdCalibratorFeatureObject(frames, options = {}) {
  const vector = buildThresholdCalibratorFeatureVector(frames, options);
  return Object.fromEntries(THRESHOLD_CALIBRATOR_FEATURE_NAMES.map((name, index) => [name, roundNumber(vector[index] || 0, 6)]));
}

export function shouldSkipThresholdCalibration(frames, {
  minFrames = 120,
  maxDiscontinuityRatio = 0.08,
} = {}) {
  const normalized = normalizeAnalysisFrames(frames);
  if (normalized.length < minFrames) return 'not-enough-frames';
  const discontinuityRatio = ratio(normalized, (frame) => frame.discontinuityBefore || frame.discontinuityAfter);
  if (discontinuityRatio > maxDiscontinuityRatio) return 'too-many-discontinuities';
  return null;
}

export function applyThresholdCalibrationToFrames(frames, calibration) {
  const normalized = normalizeAnalysisFrames(frames);
  if (!calibration?.applied) {
    return {
      frames: normalized,
      calibration: calibration || noThresholdCalibration('not-applied'),
    };
  }
  const delta = clampDelta('temporalHeadThresholdDelta', calibration.temporalHeadThresholdDelta);
  return {
    frames: normalized.map((frame) => {
      const baseThreshold = frameTemporalThreshold(frame);
      return {
        ...frame,
        temporalHeadThreshold: roundNumber(clamp(baseThreshold + delta, 0.05, 0.95), 4),
        thresholdCalibration: {
          version: THRESHOLD_CALIBRATOR_VERSION,
          baseTemporalHeadThreshold: roundNumber(baseThreshold, 4),
          temporalHeadThresholdDelta: roundNumber(delta, 4),
        },
      };
    }),
    calibration,
  };
}

export function applyThresholdCalibrationToSegmentOptions(options = {}, calibration = null) {
  if (!calibration?.applied) return options;
  const keepDelta = clampDelta('segmentKeepThresholdDelta', calibration.segmentKeepThresholdDelta);
  const trimDelta = clampDelta('trimConfidenceThresholdDelta', calibration.trimConfidenceThresholdDelta);
  return {
    ...options,
    keepThreshold: clamp(finite(options.keepThreshold, 0.35) + keepDelta, 0.01, 0.99),
    trimConfidenceThreshold: clamp(finite(options.trimConfidenceThreshold, 0.55) + trimDelta, 0.01, 0.99),
    thresholdCalibration: calibration,
  };
}

export async function loadThresholdCalibratorModel({
  ort,
  assetProfile = 'offline-final',
  basePath = 'models/fireredvad/aed',
  modelUrl = null,
  metaUrl = null,
  executionProviders = ['wasm'],
  requireAssetProfile = false,
} = {}) {
  if (!ort?.InferenceSession) {
    throw new Error('ONNX Runtime is unavailable for threshold calibrator.');
  }
  const names = thresholdCalibratorAssetNames(assetProfile);
  const resolvedProfile = names.profile;
  const resolvedModelUrl = modelUrl || extensionAssetUrl(names.model, basePath);
  const resolvedMetaUrl = metaUrl || extensionAssetUrl(names.meta, basePath);
  const [session, meta] = await Promise.all([
    ort.InferenceSession.create(resolvedModelUrl, { executionProviders }),
    loadJsonOrNull(resolvedMetaUrl),
  ]);
  if (requireAssetProfile && meta?.assetProfile && meta.assetProfile !== resolvedProfile) {
    throw new Error(`threshold calibrator profile mismatch: expected ${resolvedProfile}, got ${meta.assetProfile}`);
  }
  return {
    ort,
    session,
    meta: meta || {},
    modelUrl: resolvedModelUrl,
    metaUrl: resolvedMetaUrl,
    assetProfile: resolvedProfile,
    requestedAssetProfile: assetProfile,
  };
}

export async function runThresholdCalibratorModel(runtime, frames, {
  profile = runtime?.assetProfile || 'offline-final',
  repetition = null,
  stage = 'final',
} = {}) {
  const skipReason = shouldSkipThresholdCalibration(frames, runtime?.meta || {});
  if (skipReason) return noThresholdCalibration(skipReason, profile);
  const ort = runtime?.ort || globalThis.ort;
  const session = runtime?.session;
  if (!ort?.Tensor || !session?.run) return noThresholdCalibration('runtime-unavailable', profile);
  const meta = runtime?.meta || {};
  const inputName = meta.inputName || session.inputNames?.[0] || 'threshold_features';
  const outputName = meta.outputName || session.outputNames?.[0] || 'threshold_deltas';
  const featureNames = Array.isArray(meta.featureNames) ? meta.featureNames : THRESHOLD_CALIBRATOR_FEATURE_NAMES;
  const fullVector = buildThresholdCalibratorFeatureVector(frames, { profile, repetition });
  const inputDim = Number(meta.inputDim) || featureNames.length || THRESHOLD_CALIBRATOR_FEATURE_NAMES.length;
  const input = new Float32Array(inputDim);
  for (let index = 0; index < inputDim; index += 1) input[index] = Number(fullVector[index]) || 0;
  const result = await session.run({ [inputName]: new ort.Tensor('float32', input, [1, inputDim]) });
  const tensor = result[outputName] || result[Object.keys(result)[0]];
  const data = tensor?.data || [];
  const calibration = normalizeOutput({
    temporalHeadThresholdDelta: data[0],
    segmentKeepThresholdDelta: data[1],
    trimConfidenceThresholdDelta: data[2],
    confidence: data[3] ?? 1,
    reasonCodes: [`model:${stage}`],
  }, meta);
  return {
    ...calibration,
    profile: normalizeThresholdCalibratorProfile(profile),
    assetProfile: runtime.assetProfile,
    featureSummary: buildThresholdCalibratorFeatureObject(frames, { profile, repetition }),
  };
}

export function createHeuristicThresholdCalibration(frames, {
  profile = 'offline-final',
  repetition = null,
  stage = 'final',
} = {}) {
  const skipReason = shouldSkipThresholdCalibration(frames);
  if (skipReason) return noThresholdCalibration(skipReason, profile);
  const featureObject = buildThresholdCalibratorFeatureObject(frames, { profile, repetition });
  const reasonCodes = [`heuristic:${stage}`];
  let temporal = 0;
  let keep = 0;
  let trim = 0;
  const musicOnly = featureObject.music_only_like_ratio || 0;
  const vocalLike = featureObject.vocal_like_ratio || 0;
  const repetitionScore = featureObject.repetition_score || 0;
  const speechLike = featureObject.speech_like_ratio || 0;
  if ((musicOnly >= 0.32 || repetitionScore >= 0.62) && vocalLike <= 0.38) {
    temporal += 0.04;
    keep += 0.06;
    trim += 0.02;
    reasonCodes.push('bgm-conservative');
  }
  if (vocalLike >= 0.52 && featureObject.temporal_above_threshold_ratio <= 0.38) {
    temporal -= 0.035;
    keep -= 0.025;
    reasonCodes.push('vocal-recall');
  }
  if (speechLike >= 0.22 && featureObject.singing_mean <= 0.28) {
    keep += 0.035;
    trim += 0.025;
    reasonCodes.push('speech-heavy');
  }
  const calibration = normalizeOutput({
    temporalHeadThresholdDelta: temporal,
    segmentKeepThresholdDelta: keep,
    trimConfidenceThresholdDelta: trim,
    confidence: reasonCodes.length > 1 ? 0.6 : 0.25,
    reasonCodes,
  });
  return {
    ...calibration,
    profile: normalizeThresholdCalibratorProfile(profile),
    featureSummary: featureObject,
  };
}
