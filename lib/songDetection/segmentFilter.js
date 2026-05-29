import { normalizeAnalysisFrames as normalizeCanonicalAnalysisFrames } from './analysisFrame.js';

const SEGMENT_FILTER_VERSION = 'segment-filter-v2';

export const SEGMENT_FILTER_ASSET_PROFILES = Object.freeze({
  default: {
    key: 'default',
    suffix: '',
    segmentFilterStem: 'segment_filter',
    edgeTrimAdvisorStem: 'edge_trim_advisor',
  },
  'offline-final': {
    key: 'offline-final',
    suffix: 'offline_final',
    segmentFilterStem: 'segment_filter_offline_final',
    edgeTrimAdvisorStem: 'edge_trim_advisor_offline_final',
  },
  'live-pcm30': {
    key: 'live-pcm30',
    suffix: 'live_pcm30',
    segmentFilterStem: 'segment_filter_live_pcm30',
    edgeTrimAdvisorStem: 'edge_trim_advisor_live_pcm30',
  },
  'live-realtime-aed60': {
    key: 'live-realtime-aed60',
    suffix: 'live_aed60',
    segmentFilterStem: 'segment_filter_live_aed60',
    edgeTrimAdvisorStem: 'edge_trim_advisor_live_aed60',
  },
});

export const SEGMENT_FILTER_FEATURE_NAMES = Object.freeze([
  'duration_sec',
  'confidence',
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
  'spectral_flatness_p50',
  'spectral_flatness_p90',
  'spectral_flux_mean',
  'spectral_flux_p50',
  'spectral_flux_p90',
  'mid_energy_ratio_mean',
  'mid_energy_ratio_p50',
  'mid_energy_ratio_p90',
  'low_energy_ratio_mean',
  'low_energy_ratio_p90',
  'start_reset_ratio',
  'start_speech_reset_ratio',
  'start_low_energy_ratio',
  'start_music_mean',
  'start_singing_mean',
  'start_speech_mean',
  'end_reset_ratio',
  'end_speech_reset_ratio',
  'end_low_energy_ratio',
  'end_music_mean',
  'end_singing_mean',
  'end_speech_mean',
  'model_only_fallback',
  'tracker_segment',
  'fallback_segment',
  'selected_model_fallback_segment',
  'music_only_extra_score',
  'frame_count',
  'relative_start',
  'relative_end',
  'baseline_frame_count',
  'baseline_temporal_mean',
  'baseline_temporal_p90',
  'baseline_singing_mean',
  'baseline_singing_p90',
  'baseline_music_mean',
  'baseline_music_p90',
  'baseline_speech_mean',
  'baseline_speech_p90',
  'baseline_audio_rms_mean',
  'baseline_audio_rms_p90',
  'baseline_spectral_flatness_mean',
  'baseline_spectral_flux_mean',
  'segment_temporal_vs_baseline',
  'segment_singing_vs_baseline',
  'segment_music_vs_baseline',
  'segment_speech_vs_baseline',
  'segment_rms_vs_baseline',
]);

export const DEFAULT_SEGMENT_FILTER_OPTIONS = Object.freeze({
  keepThreshold: 0.35,
  trimConfidenceThreshold: 0.55,
  trimClampSec: 60,
  trimScale: 0.75,
  minSegmentDurationSec: 90,
  edgeWindowSec: 20,
  lowEnergyRmsThreshold: 0.006,
  lowEnergyPeakThreshold: 0.025,
  lowEnergyRatioThreshold: 0.72,
  speechResetThreshold: 0.58,
  speechResetSingingCeiling: 0.38,
  speechResetMusicCeiling: 0.72,
  hardTrimMinSilenceSec: 1.0,
  hardTrimSpeechMeanThreshold: 0.58,
  hardTrimSpeechP90Threshold: 0.72,
  hardTrimSpeechSingingCeiling: 0.38,
  hardTrimMusicChangeThreshold: 0.28,
  hardTrimMusicChangeMinSongMean: 0.55,
  hardTrimMusicChangeMaxEdgeSongMean: 0.48,
  startTrimInstrumentalIntroMinSec: 20,
  startTrimInstrumentalIntroMaxSec: 45,
  baselineMinDurationSec: 600,
  baselineShortWindowSec: 300,
  baselineLongWindowSec: 600,
  baselineMinFrames: 120,
});

export const DEFAULT_LIVE_SPEECH_RESET_END_REFINEMENT_OPTIONS = Object.freeze({
  enabled: true,
  maxTrimSec: 75,
  minTrimSec: 25,
  minTailSec: 8,
  scanStepSec: 0.5,
  preWindowSec: 45,
  minPreFrames: 20,
  minTailFrames: 12,
  maxTailTemporalMean: 0.56,
  maxTailTemporalP50: 0.58,
  maxTailTemporalP90: 0.85,
  maxTailSingingMean: 0.58,
  minTailSpeechMean: 0.46,
  minPreTemporalMean: 0.62,
  minPreMusicMean: 0.82,
});

const DEFAULT_BASELINE_STATS = Object.freeze({
  frameCount: 0,
  temporalMean: 0.5,
  temporalP90: 0.5,
  singingMean: 0.2,
  singingP90: 0.2,
  musicMean: 0.5,
  musicP90: 0.5,
  speechMean: 0.2,
  speechP90: 0.2,
  audioRmsMean: 0.02,
  audioRmsP90: 0.04,
  spectralFlatnessMean: 0.08,
  spectralFluxMean: 0.35,
});

export { SEGMENT_FILTER_VERSION };

export function normalizeSegmentFilterAssetProfile(profile = 'default') {
  const key = String(profile || 'default').trim().toLowerCase();
  return SEGMENT_FILTER_ASSET_PROFILES[key] || SEGMENT_FILTER_ASSET_PROFILES.default;
}

export function segmentFilterAssetNames(profile = 'default') {
  const normalized = normalizeSegmentFilterAssetProfile(profile);
  return {
    profile: normalized.key,
    suffix: normalized.suffix,
    segmentFilterModel: `${normalized.segmentFilterStem}.onnx`,
    segmentFilterMeta: `${normalized.segmentFilterStem}.meta.json`,
    edgeTrimAdvisorModel: `${normalized.edgeTrimAdvisorStem}.onnx`,
    edgeTrimAdvisorMeta: `${normalized.edgeTrimAdvisorStem}.meta.json`,
  };
}

function extensionAssetUrl(fileName, basePath = 'models/fireredvad/aed') {
  const path = `${String(basePath || '').replace(/\/+$/, '')}/${fileName}`;
  return globalThis.chrome?.runtime?.getURL
    ? chrome.runtime.getURL(path)
    : path;
}

function assetCandidates(kind, assetProfile, basePath, { allowProfileFallback = true } = {}) {
  const requested = normalizeSegmentFilterAssetProfile(assetProfile);
  const profiles = requested.key === 'default' || !allowProfileFallback
    ? [requested]
    : [requested, SEGMENT_FILTER_ASSET_PROFILES.default];
  return profiles.map((profile) => {
    const names = segmentFilterAssetNames(profile.key);
    const modelName = kind === 'edge'
      ? names.edgeTrimAdvisorModel
      : names.segmentFilterModel;
    const metaName = kind === 'edge'
      ? names.edgeTrimAdvisorMeta
      : names.segmentFilterMeta;
    return {
      assetProfile: profile.key,
      modelUrl: extensionAssetUrl(modelName, basePath),
      metaUrl: extensionAssetUrl(metaName, basePath),
    };
  });
}

async function loadJsonOrNull(url) {
  return fetch(url)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
}

async function createProfiledSession({
  ort,
  candidates,
  executionProviders,
  requestedAssetProfile,
}) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const [session, meta] = await Promise.all([
        ort.InferenceSession.create(candidate.modelUrl, { executionProviders }),
        loadJsonOrNull(candidate.metaUrl),
      ]);
      return {
        ort,
        session,
        meta: meta || {},
        modelUrl: candidate.modelUrl,
        metaUrl: candidate.metaUrl,
        requestedAssetProfile,
        assetProfile: candidate.assetProfile,
        assetProfileFallbackUsed: candidate.assetProfile !== requestedAssetProfile,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Unable to load segment filter asset profile "${requestedAssetProfile}".`);
}

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function roundNumber(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function finite(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeFrames(frames) {
  return normalizeCanonicalAnalysisFrames(frames)
    .map((frame) => ({
      ...frame,
      songProbability: clamp(frame.temporalHeadProbability ?? frame.songProbability, 0, 1),
      temporalHeadThreshold: clamp(frame.temporalHeadThreshold, 0.05, 0.95),
    }));
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values) {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(Math.max(0, variance));
}

function values(frames, key) {
  return frames.map((frame) => finite(frame[key], 0));
}

function ratio(frames, predicate) {
  if (!frames.length) return 0;
  let count = 0;
  for (const frame of frames) {
    if (predicate(frame)) count += 1;
  }
  return count / frames.length;
}

function framesInRange(frames, startSec, endSec) {
  return frames.filter((frame) => frame.timeSec >= startSec && frame.timeSec <= endSec);
}

function strictSilent(frame, options) {
  return frame.audioRms <= options.lowEnergyRmsThreshold
    && frame.audioPeak <= options.lowEnergyPeakThreshold;
}

function lowEnergy(frame, options) {
  return frame.audioRms <= options.lowEnergyRmsThreshold
    || frame.audioPeak <= options.lowEnergyPeakThreshold
    || frame.lowEnergyRatio >= options.lowEnergyRatioThreshold;
}

function speechReset(frame, options) {
  return frame.speechProbability >= options.speechResetThreshold
    && frame.singingProbability <= options.speechResetSingingCeiling
    && frame.musicProbability <= options.speechResetMusicCeiling;
}

function maxRunDurationSec(frames, predicate, hopSec = 0.5) {
  let currentSec = 0;
  let maxSec = 0;
  for (const frame of frames) {
    if (predicate(frame)) {
      currentSec += hopSec;
      maxSec = Math.max(maxSec, currentSec);
    } else {
      currentSec = 0;
    }
  }
  return maxSec;
}

function findFirstRun(frames, predicate, minDurationSec, hopSec = 0.5) {
  let startSec = null;
  let durationSec = 0;
  for (const frame of frames) {
    if (predicate(frame)) {
      if (startSec === null) startSec = finite(frame.timeSec, 0);
      durationSec += hopSec;
      if (durationSec >= minDurationSec) {
        return {
          startSec,
          endSec: finite(frame.timeSec, startSec) + hopSec,
          durationSec,
        };
      }
    } else {
      startSec = null;
      durationSec = 0;
    }
  }
  return null;
}

function hardTrimEvidence(edgeFrames, songSideFrames, options) {
  const speechMean = mean(values(edgeFrames, 'speechProbability'));
  const speechP90 = quantile(values(edgeFrames, 'speechProbability'), 0.9);
  const singingMean = mean(values(edgeFrames, 'singingProbability'));
  const musicMean = mean(values(edgeFrames, 'musicProbability'));
  const temporalMean = mean(values(edgeFrames, 'songProbability'));
  const silenceRunSec = maxRunDurationSec(edgeFrames, (frame) => strictSilent(frame, options));
  const clearSpeech = (
    (speechMean >= options.hardTrimSpeechMeanThreshold || speechP90 >= options.hardTrimSpeechP90Threshold)
    && singingMean <= options.hardTrimSpeechSingingCeiling
  );
  const sustainedSilence = silenceRunSec >= options.hardTrimMinSilenceSec;

  const songMusicMean = mean(values(songSideFrames, 'musicProbability'));
  const songTemporalMean = mean(values(songSideFrames, 'songProbability'));
  const songSingingMean = mean(values(songSideFrames, 'singingProbability'));
  const songRmsMean = mean(values(songSideFrames, 'audioRms'));
  const edgeRmsMean = mean(values(edgeFrames, 'audioRms'));
  const songFluxMean = mean(values(songSideFrames, 'spectralFlux'));
  const edgeFluxMean = mean(values(edgeFrames, 'spectralFlux'));
  const songFlatnessMean = mean(values(songSideFrames, 'spectralFlatness'));
  const edgeFlatnessMean = mean(values(edgeFrames, 'spectralFlatness'));
  const songSideStrong = (
    songMusicMean >= options.hardTrimMusicChangeMinSongMean
    || songTemporalMean >= options.hardTrimMusicChangeMinSongMean
    || songSingingMean >= options.hardTrimMusicChangeMinSongMean
  );
  const probabilityChange = Math.max(
    Math.abs(songMusicMean - musicMean),
    Math.abs(songTemporalMean - temporalMean),
    Math.abs(songSingingMean - singingMean)
  );
  const spectralChange = Math.max(
    Math.abs(songFluxMean - edgeFluxMean),
    Math.abs(songFlatnessMean - edgeFlatnessMean)
  );
  const energyChange = Math.abs(songRmsMean - edgeRmsMean) / Math.max(0.01, songRmsMean, edgeRmsMean);
  const edgeLooksWeak = musicMean <= options.hardTrimMusicChangeMaxEdgeSongMean
    && temporalMean <= options.hardTrimMusicChangeMaxEdgeSongMean;
  const musicChange = songSideStrong
    && edgeLooksWeak
    && Math.max(probabilityChange, spectralChange, energyChange * 0.5) >= options.hardTrimMusicChangeThreshold;
  let reason = 'ambiguous-edge';
  if (clearSpeech) reason = 'clear-speech';
  else if (sustainedSilence) reason = 'sustained-silence';
  else if (musicChange) reason = 'music-property-change';

  return {
    pass: clearSpeech || sustainedSilence || musicChange,
    reason,
    clearSpeech,
    sustainedSilence,
    musicChange,
    frameCount: edgeFrames.length,
    songSideFrameCount: songSideFrames.length,
    silenceRunSec: roundNumber(silenceRunSec, 3),
    speechMean: roundNumber(speechMean, 4),
    speechP90: roundNumber(speechP90, 4),
    singingMean: roundNumber(singingMean, 4),
    musicMean: roundNumber(musicMean, 4),
    temporalMean: roundNumber(temporalMean, 4),
    songMusicMean: roundNumber(songMusicMean, 4),
    songTemporalMean: roundNumber(songTemporalMean, 4),
    songSingingMean: roundNumber(songSingingMean, 4),
    probabilityChange: roundNumber(probabilityChange, 4),
    spectralChange: roundNumber(spectralChange, 4),
    energyChange: roundNumber(energyChange, 4),
  };
}

function edgeStats(frames, edgeSec, options) {
  const edgeFrames = framesInRange(frames, edgeSec - options.edgeWindowSec, edgeSec + options.edgeWindowSec);
  return {
    resetRatio: ratio(edgeFrames, (frame) => lowEnergy(frame, options) || speechReset(frame, options)),
    speechResetRatio: ratio(edgeFrames, (frame) => speechReset(frame, options)),
    lowEnergyRatio: ratio(edgeFrames, (frame) => lowEnergy(frame, options)),
    musicMean: mean(values(edgeFrames, 'musicProbability')),
    singingMean: mean(values(edgeFrames, 'singingProbability')),
    speechMean: mean(values(edgeFrames, 'speechProbability')),
  };
}

function middleBaselineStats(frames, endSec, options) {
  if (endSec < options.baselineMinDurationSec) return { ...DEFAULT_BASELINE_STATS };
  const windowSec = endSec >= options.baselineLongWindowSec * 2
    ? options.baselineLongWindowSec
    : options.baselineShortWindowSec;
  const midpoint = endSec / 2;
  const startSec = Math.max(0, midpoint - (windowSec / 2));
  const stopSec = Math.min(endSec, startSec + windowSec);
  const baselineFrames = framesInRange(frames, startSec, stopSec);
  if (baselineFrames.length < options.baselineMinFrames) return { ...DEFAULT_BASELINE_STATS };
  const temporal = values(baselineFrames, 'songProbability');
  const singing = values(baselineFrames, 'singingProbability');
  const music = values(baselineFrames, 'musicProbability');
  const speech = values(baselineFrames, 'speechProbability');
  const audioRms = values(baselineFrames, 'audioRms');
  const flatness = values(baselineFrames, 'spectralFlatness');
  const flux = values(baselineFrames, 'spectralFlux');
  return {
    frameCount: baselineFrames.length,
    temporalMean: mean(temporal),
    temporalP90: quantile(temporal, 0.9),
    singingMean: mean(singing),
    singingP90: quantile(singing, 0.9),
    musicMean: mean(music),
    musicP90: quantile(music, 0.9),
    speechMean: mean(speech),
    speechP90: quantile(speech, 0.9),
    audioRmsMean: mean(audioRms),
    audioRmsP90: quantile(audioRms, 0.9),
    spectralFlatnessMean: mean(flatness),
    spectralFluxMean: mean(flux),
  };
}

function overlapSeconds(left, right) {
  return Math.max(0, Math.min(finite(left?.endSec), finite(right?.endSec)) - Math.max(finite(left?.startSec), finite(right?.startSec)));
}

function bestOverlapRatio(segment, candidates) {
  const duration = Math.max(0.001, finite(segment.endSec) - finite(segment.startSec));
  let best = 0;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    best = Math.max(best, overlapSeconds(segment, candidate) / duration);
  }
  return best;
}

function contextFlags(segment, context = {}) {
  const trackerRatio = bestOverlapRatio(segment, context.trackerSegments);
  const selectedFallbackRatio = bestOverlapRatio(segment, context.selectedModelFallbackSegments);
  const fallbackRatio = bestOverlapRatio(segment, context.fallbackSegments);
  const modelRunRatio = bestOverlapRatio(segment, context.modelRunSegments);
  return {
    trackerSegment: trackerRatio >= 0.2 ? 1 : 0,
    selectedModelFallbackSegment: selectedFallbackRatio >= 0.2 ? 1 : 0,
    fallbackSegment: fallbackRatio >= 0.2 ? 1 : 0,
    modelOnlyFallback: (selectedFallbackRatio >= 0.2 || (modelRunRatio >= 0.45 && trackerRatio < 0.15)) ? 1 : 0,
  };
}

export function buildSegmentFilterFeatureVector(segment, frames, context = {}, options = {}) {
  const opts = { ...DEFAULT_SEGMENT_FILTER_OPTIONS, ...options };
  const normalizedFrames = normalizeFrames(frames);
  const startSec = Math.max(0, finite(segment?.startSec, 0));
  const endSec = Math.max(startSec, finite(segment?.endSec, startSec));
  const durationSec = Math.max(0, endSec - startSec);
  const segmentFrames = framesInRange(normalizedFrames, startSec, endSec);
  const safeFrames = segmentFrames.length ? segmentFrames : framesInRange(normalizedFrames, startSec - 1, endSec + 1);
  const temporal = values(safeFrames, 'songProbability');
  const singing = values(safeFrames, 'singingProbability');
  const music = values(safeFrames, 'musicProbability');
  const speech = values(safeFrames, 'speechProbability');
  const singingRatio = values(safeFrames, 'singingRatio');
  const musicRatio = values(safeFrames, 'musicRatio');
  const speechRatio = values(safeFrames, 'speechRatio');
  const audioRms = values(safeFrames, 'audioRms');
  const audioPeak = values(safeFrames, 'audioPeak');
  const spectralFlatness = values(safeFrames, 'spectralFlatness');
  const spectralFlux = values(safeFrames, 'spectralFlux');
  const midEnergy = values(safeFrames, 'midEnergyRatio');
  const lowEnergyValues = values(safeFrames, 'lowEnergyRatio');
  const threshold = mean(values(safeFrames, 'temporalHeadThreshold')) || finite(context.temporalHeadThreshold, 0.75);
  const startEdge = edgeStats(normalizedFrames, startSec, opts);
  const endEdge = edgeStats(normalizedFrames, endSec, opts);
  const flags = contextFlags(segment, context);
  const endBoundary = Math.max(endSec, finite(context.endSec, normalizedFrames.at(-1)?.timeSec ?? endSec));
  const baseline = middleBaselineStats(normalizedFrames, endBoundary, opts);
  const musicMean = mean(music);
  const singingMean = mean(singing);
  const speechMean = mean(speech);
  const temporalMean = mean(temporal);
  const rmsMean = mean(audioRms);
  const musicOnlyExtraScore = clamp((musicMean - (singingMean * 1.7) - (speechMean * 1.15) + (durationSec >= 180 ? 0.12 : 0)) / 0.75, 0, 1);

  return [
    durationSec,
    clamp(segment?.confidence, 0, 1),
    temporalMean,
    quantile(temporal, 0.1),
    quantile(temporal, 0.5),
    quantile(temporal, 0.9),
    std(temporal),
    ratio(safeFrames, (frame) => frame.songProbability >= threshold),
    singingMean,
    quantile(singing, 0.5),
    quantile(singing, 0.9),
    mean(singingRatio),
    quantile(singingRatio, 0.9),
    musicMean,
    quantile(music, 0.5),
    quantile(music, 0.9),
    mean(musicRatio),
    quantile(musicRatio, 0.9),
    speechMean,
    quantile(speech, 0.5),
    quantile(speech, 0.9),
    mean(speechRatio),
    quantile(speechRatio, 0.9),
    rmsMean,
    quantile(audioRms, 0.5),
    quantile(audioRms, 0.9),
    mean(audioPeak),
    quantile(audioPeak, 0.9),
    mean(spectralFlatness),
    quantile(spectralFlatness, 0.5),
    quantile(spectralFlatness, 0.9),
    mean(spectralFlux),
    quantile(spectralFlux, 0.5),
    quantile(spectralFlux, 0.9),
    mean(midEnergy),
    quantile(midEnergy, 0.5),
    quantile(midEnergy, 0.9),
    mean(lowEnergyValues),
    quantile(lowEnergyValues, 0.9),
    startEdge.resetRatio,
    startEdge.speechResetRatio,
    startEdge.lowEnergyRatio,
    startEdge.musicMean,
    startEdge.singingMean,
    startEdge.speechMean,
    endEdge.resetRatio,
    endEdge.speechResetRatio,
    endEdge.lowEnergyRatio,
    endEdge.musicMean,
    endEdge.singingMean,
    endEdge.speechMean,
    flags.modelOnlyFallback,
    flags.trackerSegment,
    flags.fallbackSegment,
    flags.selectedModelFallbackSegment,
    musicOnlyExtraScore,
    safeFrames.length,
    endBoundary > 0 ? startSec / endBoundary : 0,
    endBoundary > 0 ? endSec / endBoundary : 0,
    baseline.frameCount,
    baseline.temporalMean,
    baseline.temporalP90,
    baseline.singingMean,
    baseline.singingP90,
    baseline.musicMean,
    baseline.musicP90,
    baseline.speechMean,
    baseline.speechP90,
    baseline.audioRmsMean,
    baseline.audioRmsP90,
    baseline.spectralFlatnessMean,
    baseline.spectralFluxMean,
    temporalMean - baseline.temporalMean,
    singingMean - baseline.singingMean,
    musicMean - baseline.musicMean,
    speechMean - baseline.speechMean,
    rmsMean - baseline.audioRmsMean,
  ];
}

export function buildSegmentFilterFeatureMatrix(segments, frames, context = {}, options = {}) {
  return (Array.isArray(segments) ? segments : []).map((segment) => (
    buildSegmentFilterFeatureVector(segment, frames, context, options)
  ));
}

function normalizeSegment(segment) {
  const startSec = Math.max(0, finite(segment?.startSec, 0));
  const endSec = Math.max(startSec, finite(segment?.endSec, startSec));
  return {
    ...segment,
    startSec: roundNumber(startSec, 3),
    endSec: roundNumber(endSec, 3),
    confidence: roundNumber(clamp(segment?.confidence, 0, 1), 3),
    provisional: false,
  };
}

function summarizeStartTrimEvidence(frames, proposedStartSec, originalStartSec, options = {}) {
  const extensionFrames = framesInRange(frames, proposedStartSec, originalStartSec);
  const minFrames = Math.max(1, Math.round(finite(options.startTrimEvidenceMinFrames, 3)));
  if (extensionFrames.length < minFrames) {
    return { pass: true, reason: 'insufficient-frames', frameCount: extensionFrames.length };
  }

  const musicMean = mean(values(extensionFrames, 'musicProbability'));
  const musicP90 = quantile(values(extensionFrames, 'musicProbability'), 0.9);
  const singingMean = mean(values(extensionFrames, 'singingProbability'));
  const speechMean = mean(values(extensionFrames, 'speechProbability'));
  const temporalMean = mean(values(extensionFrames, 'songProbability'));
  const temporalP90 = quantile(values(extensionFrames, 'songProbability'), 0.9);
  const lowEnergyMean = mean(values(extensionFrames, 'lowEnergyRatio'));
  const spectralFlatnessMean = mean(values(extensionFrames, 'spectralFlatness'));
  const extensionDurationSec = Math.max(0, originalStartSec - proposedStartSec);
  const songSideFrames = framesInRange(
    frames,
    originalStartSec,
    originalStartSec + Math.max(20, Math.min(30, extensionDurationSec))
  );
  const songSideMusicMean = mean(values(songSideFrames, 'musicProbability'));
  const songSideSingingMean = mean(values(songSideFrames, 'singingProbability'));
  const songSideTemporalMean = mean(values(songSideFrames, 'songProbability'));
  const musicSupport = musicMean >= 0.42 || musicP90 >= 0.62 || temporalMean >= 0.35 || temporalP90 >= 0.6;
  // Live start extension is only safe when the missing intro looks like
  // speech-backed vocal content. Plain BGM/rehearsal often has high music
  // support and would otherwise be pulled into the song segment.
  const vocalIntroSupport = musicMean >= 0.45 && speechMean >= 0.58 && singingMean >= 0.32;
  const instrumentalIntroSupport = extensionDurationSec >= finite(options.startTrimInstrumentalIntroMinSec, 20)
    && extensionDurationSec <= finite(options.startTrimInstrumentalIntroMaxSec, 45)
    && musicMean >= 0.68
    && musicP90 >= 0.9
    && singingMean <= 0.35
    && speechMean <= 0.42
    && temporalMean <= 0.4
    && lowEnergyMean <= 0.6
    && spectralFlatnessMean <= 0.35
    && songSideFrames.length >= minFrames
    && songSideMusicMean >= 0.55
    && (songSideSingingMean >= 0.45 || songSideTemporalMean >= 0.65);
  const speechOnly = speechMean >= 0.62 && singingMean <= 0.24 && musicMean <= 0.52 && temporalMean <= 0.45;
  const lowEnergyOnly = lowEnergyMean >= 0.78 && musicP90 <= 0.45 && temporalP90 <= 0.45;
  const noisyNonMusic = spectralFlatnessMean >= 0.68 && musicMean <= 0.45 && temporalMean <= 0.45;
  const pass = musicSupport && (vocalIntroSupport || instrumentalIntroSupport) && !speechOnly && !lowEnergyOnly && !noisyNonMusic;
  let reason = 'supported';
  if (speechOnly) reason = 'speech-only';
  else if (lowEnergyOnly) reason = 'low-energy-only';
  else if (noisyNonMusic) reason = 'noisy-non-music';
  else if (!vocalIntroSupport && !instrumentalIntroSupport) reason = 'weak-vocal-intro-support';
  else if (!musicSupport) reason = 'weak-music-support';

  return {
    pass,
    reason,
    frameCount: extensionFrames.length,
    musicMean: roundNumber(musicMean, 4),
    musicP90: roundNumber(musicP90, 4),
    singingMean: roundNumber(singingMean, 4),
    speechMean: roundNumber(speechMean, 4),
    vocalIntroSupport,
    instrumentalIntroSupport,
    temporalMean: roundNumber(temporalMean, 4),
    temporalP90: roundNumber(temporalP90, 4),
    lowEnergyMean: roundNumber(lowEnergyMean, 4),
    spectralFlatnessMean: roundNumber(spectralFlatnessMean, 4),
    extensionDurationSec: roundNumber(extensionDurationSec, 3),
    songSideMusicMean: roundNumber(songSideMusicMean, 4),
    songSideSingingMean: roundNumber(songSideSingingMean, 4),
    songSideTemporalMean: roundNumber(songSideTemporalMean, 4),
  };
}

function summarizeStartHardTrimEvidence(frames, originalStartSec, proposedStartSec, options = {}) {
  const trimmedFrames = framesInRange(frames, originalStartSec, proposedStartSec);
  const minFrames = Math.max(1, Math.round(finite(options.startTrimEvidenceMinFrames, 3)));
  if (trimmedFrames.length < minFrames) {
    return { pass: true, reason: 'insufficient-frames', frameCount: trimmedFrames.length };
  }
  const songSideWindowSec = Math.max(options.edgeWindowSec || 20, proposedStartSec - originalStartSec);
  const songSideFrames = framesInRange(frames, proposedStartSec, proposedStartSec + songSideWindowSec);
  const evidence = hardTrimEvidence(trimmedFrames, songSideFrames, options);
  return {
    ...evidence,
    reason: evidence.pass ? evidence.reason : 'ambiguous-start-edge',
  };
}

function summarizeEndTrimEvidence(frames, proposedEndSec, originalEndSec, options = {}) {
  const trimmedFrames = framesInRange(frames, proposedEndSec, originalEndSec);
  const minFrames = Math.max(1, Math.round(finite(options.endTrimEvidenceMinFrames, 4)));
  if (trimmedFrames.length < minFrames) {
    return { pass: true, reason: 'insufficient-frames', frameCount: trimmedFrames.length };
  }

  const musicMean = mean(values(trimmedFrames, 'musicProbability'));
  const musicP90 = quantile(values(trimmedFrames, 'musicProbability'), 0.9);
  const singingMean = mean(values(trimmedFrames, 'singingProbability'));
  const singingP90 = quantile(values(trimmedFrames, 'singingProbability'), 0.9);
  const speechMean = mean(values(trimmedFrames, 'speechProbability'));
  const temporalMean = mean(values(trimmedFrames, 'songProbability'));
  const temporalP90 = quantile(values(trimmedFrames, 'songProbability'), 0.9);
  const lowEnergyMean = mean(values(trimmedFrames, 'lowEnergyRatio'));
  const trimDurationSec = Math.max(0, originalEndSec - proposedEndSec);
  const songSideWindowSec = Math.max(options.edgeWindowSec || 20, originalEndSec - proposedEndSec);
  const songSideFrames = framesInRange(frames, proposedEndSec - songSideWindowSec, proposedEndSec);
  const evidence = hardTrimEvidence(trimmedFrames, songSideFrames, options);
  const strongSongTail = (
    temporalMean >= 0.5
    || temporalP90 >= 0.72
    || singingMean >= 0.35
    || singingP90 >= 0.75
  );
  const musicBackedVocalTail = musicMean >= 0.88
    && (singingMean >= 0.24 || singingP90 >= 0.6);
  const protectedSongTail = strongSongTail || musicBackedVocalTail;
  const clearSpeechTail = (speechMean >= 0.5 || evidence.clearSpeech)
    && !musicBackedVocalTail;
  const sustainedSilenceTail = evidence.sustainedSilence
    || (lowEnergyMean >= 0.7 && temporalP90 <= 0.5);
  const weakNonSongTail = musicMean <= 0.35
    && temporalMean <= 0.35
    && singingP90 <= 0.58;
  const lowConfidenceSpeechReset = speechMean >= 0.38
    && singingMean <= 0.32
    && musicP90 <= 0.58;
  const longAmbiguousMusicChangeTrim = trimDurationSec > 25
    && evidence.musicChange
    && !clearSpeechTail
    && !sustainedSilenceTail
    && !lowConfidenceSpeechReset;
  const clearNonSongTail = clearSpeechTail
    || sustainedSilenceTail
    || (weakNonSongTail && !longAmbiguousMusicChangeTrim && (
      evidence.musicChange || lowConfidenceSpeechReset || lowEnergyMean >= 0.45
    ));
  const pass = !protectedSongTail
    || clearSpeechTail
    || lowConfidenceSpeechReset
    || (clearNonSongTail && temporalP90 <= 0.55 && singingP90 <= 0.62);
  let reason = 'supported';
  if (musicBackedVocalTail && !clearNonSongTail) reason = 'music-backed-vocal-tail';
  else if (strongSongTail && !clearNonSongTail) reason = 'strong-song-tail';
  else if (clearSpeechTail) reason = 'clear-speech';
  else if (sustainedSilenceTail) reason = 'sustained-silence';
  else if (lowConfidenceSpeechReset) reason = 'low-confidence-speech-reset';
  else if (weakNonSongTail && evidence.musicChange) reason = 'weak-non-song-music-change';
  else if (weakNonSongTail) reason = 'weak-non-song-tail';

  return {
    pass,
    reason,
    clearSpeech: evidence.clearSpeech,
    sustainedSilence: evidence.sustainedSilence,
    musicChange: evidence.musicChange,
    clearNonSongTail,
    lowConfidenceSpeechReset,
    weakNonSongTail,
    musicBackedVocalTail,
    longAmbiguousMusicChangeTrim,
    frameCount: trimmedFrames.length,
    songSideFrameCount: evidence.songSideFrameCount,
    silenceRunSec: evidence.silenceRunSec,
    musicMean: roundNumber(musicMean, 4),
    musicP90: roundNumber(musicP90, 4),
    singingMean: roundNumber(singingMean, 4),
    singingP90: roundNumber(singingP90, 4),
    speechMean: roundNumber(speechMean, 4),
    temporalMean: roundNumber(temporalMean, 4),
    temporalP90: roundNumber(temporalP90, 4),
    lowEnergyMean: roundNumber(lowEnergyMean, 4),
    trimDurationSec: roundNumber(trimDurationSec, 3),
    probabilityChange: evidence.probabilityChange,
    spectralChange: evidence.spectralChange,
    energyChange: evidence.energyChange,
  };
}

export function applySegmentFilterPredictions(segments, predictions, options = {}) {
  const opts = { ...DEFAULT_SEGMENT_FILTER_OPTIONS, ...options };
  const allowStartTrim = opts.allowStartTrim !== false;
  const allowEndTrim = opts.allowEndTrim !== false;
  const startTrimMode = String(opts.startTrimMode || 'bidirectional');
  const startTrimScale = Number.isFinite(Number(opts.startTrimScale))
    ? Math.max(0, Number(opts.startTrimScale))
    : opts.trimScale;
  const largeEndTrimThresholdSec = Number.isFinite(Number(opts.largeEndTrimThresholdSec))
    ? Math.max(0, Number(opts.largeEndTrimThresholdSec))
    : Infinity;
  const largeEndTrimScale = Number.isFinite(Number(opts.largeEndTrimScale))
    ? Math.max(1, Number(opts.largeEndTrimScale))
    : 1;
  const startTrimMinAbsSec = Number.isFinite(Number(opts.startTrimMinAbsSec))
    ? Math.max(0, Number(opts.startTrimMinAbsSec))
    : 0;
  const startTrimEvidenceFrames = opts.startTrimEvidenceGuard === false
    ? []
    : normalizeFrames(opts.startTrimEvidenceFrames || []);
  const endTrimEvidenceFrames = opts.endTrimEvidenceGuard === false
    ? []
    : normalizeFrames(opts.endTrimEvidenceFrames || []);
  const inputSegments = Array.isArray(segments) ? segments : [];
  const inputPredictions = Array.isArray(predictions) ? predictions : [];
  if (!inputSegments.length || !inputPredictions.length) {
    return { segments: inputSegments.map(normalizeSegment), adjustments: [], changed: false };
  }

  const sorted = inputSegments.map((segment, index) => ({ segment, prediction: inputPredictions[index] || {}, index }))
    .sort((a, b) => finite(a.segment.startSec) - finite(b.segment.startSec));
  const kept = [];
  const adjustments = [];

  for (let sortedIndex = 0; sortedIndex < sorted.length; sortedIndex += 1) {
    const { segment, prediction, index } = sorted[sortedIndex];
    const keepProbability = clamp(prediction.keepProbability ?? prediction.keep_probability ?? prediction.keep, 0, 1);
    let startTrimDeltaSec = clamp(prediction.startTrimDeltaSec ?? prediction.start_delta_sec ?? 0, -opts.trimClampSec, opts.trimClampSec) * startTrimScale;
    const rawEndTrimDeltaSec = clamp(prediction.endTrimDeltaSec ?? prediction.end_delta_sec ?? 0, -opts.trimClampSec, opts.trimClampSec);
    const isLargeEndTrim = rawEndTrimDeltaSec <= -largeEndTrimThresholdSec;
    const endTrimScale = isLargeEndTrim
      ? opts.trimScale * largeEndTrimScale
      : opts.trimScale;
    let endTrimDeltaSec = clamp(rawEndTrimDeltaSec * endTrimScale, -opts.trimClampSec, opts.trimClampSec);
    const original = normalizeSegment(segment);
    if (startTrimMode === 'extend-only') {
      startTrimDeltaSec = Math.min(0, startTrimDeltaSec);
    } else if (startTrimMode === 'trim-only') {
      startTrimDeltaSec = Math.max(0, startTrimDeltaSec);
    }
    if (startTrimMinAbsSec > 0 && Math.abs(startTrimDeltaSec) < startTrimMinAbsSec) {
      startTrimDeltaSec = 0;
    }
    let startTrimEvidence = null;
    if (startTrimDeltaSec < 0 && startTrimEvidenceFrames.length) {
      startTrimEvidence = summarizeStartTrimEvidence(
        startTrimEvidenceFrames,
        original.startSec + startTrimDeltaSec,
        original.startSec,
        opts
      );
      if (!startTrimEvidence.pass) startTrimDeltaSec = 0;
    }
    let endTrimEvidence = null;
    if (endTrimDeltaSec < 0 && endTrimEvidenceFrames.length) {
      endTrimEvidence = summarizeEndTrimEvidence(
        endTrimEvidenceFrames,
        original.endSec + endTrimDeltaSec,
        original.endSec,
        opts
      );
      if (!endTrimEvidence.pass) endTrimDeltaSec = 0;
    }

    if (keepProbability < opts.keepThreshold) {
      adjustments.push({
        index,
        action: 'drop',
        keepProbability: roundNumber(keepProbability, 4),
        original,
      });
      continue;
    }

    let nextSegment = { ...original };
    const trimAllowed = keepProbability >= opts.trimConfidenceThreshold;
    if (trimAllowed) {
      const previousEnd = kept.length ? finite(kept[kept.length - 1].endSec, 0) : finite(opts.startSec, 0);
      const nextOriginal = sorted[sortedIndex + 1]?.segment;
      const nextStart = nextOriginal ? finite(nextOriginal.startSec, Infinity) : finite(opts.endSec, Infinity);
      const minDurationSec = Math.max(1, finite(opts.minSegmentDurationSec, DEFAULT_SEGMENT_FILTER_OPTIONS.minSegmentDurationSec));
      let proposedStart = allowStartTrim ? original.startSec + startTrimDeltaSec : original.startSec;
      let proposedEnd = allowEndTrim ? original.endSec + endTrimDeltaSec : original.endSec;
      proposedStart = clamp(proposedStart, previousEnd, Math.max(previousEnd, nextStart - minDurationSec));
      proposedEnd = clamp(proposedEnd, proposedStart + minDurationSec, nextStart);
      if (proposedEnd - proposedStart >= minDurationSec) {
        nextSegment = normalizeSegment({ ...original, startSec: proposedStart, endSec: proposedEnd });
      }
    }

    kept.push(nextSegment);
    adjustments.push({
      index,
      action: nextSegment.startSec !== original.startSec || nextSegment.endSec !== original.endSec ? 'trim' : 'keep',
      keepProbability: roundNumber(keepProbability, 4),
      startTrimDeltaSec: roundNumber(startTrimDeltaSec, 3),
      endTrimDeltaSec: roundNumber(endTrimDeltaSec, 3),
      endTrimScale: roundNumber(endTrimScale, 3),
      startTrimApplied: allowStartTrim,
      endTrimApplied: allowEndTrim,
      startTrimEvidence,
      endTrimEvidence,
      original,
      segment: nextSegment,
    });
  }

  const changed = adjustments.some((item) => item.action !== 'keep');
  return { segments: kept.map(normalizeSegment), adjustments, changed };
}

function summarizeSpeechResetTail(frames, startSec, endSec) {
  const tailFrames = framesInRange(frames, startSec, endSec);
  const temporal = values(tailFrames, 'songProbability');
  const singing = values(tailFrames, 'singingProbability');
  const speech = values(tailFrames, 'speechProbability');
  const music = values(tailFrames, 'musicProbability');
  const resetSearchFrames = framesInRange(frames, startSec, startSec + 12);
  const resetRun = findFirstRun(resetSearchFrames, (frame) => (
    strictSilent(frame, DEFAULT_SEGMENT_FILTER_OPTIONS)
    || (
      finite(frame.audioRms, 0) <= 0.015
      && finite(frame.songProbability, 0) <= 0.35
      && finite(frame.singingProbability, 0) <= 0.2
    )
    || (
      finite(frame.songProbability, 0) <= 0.22
      && finite(frame.singingProbability, 0) <= 0.1
      && finite(frame.musicProbability, 0) <= 0.7
    )
  ), 2.0);
  const postResetFrames = resetRun ? framesInRange(frames, resetRun.endSec, endSec) : [];
  const postResetStrongSongRunSec = maxRunDurationSec(postResetFrames, (frame) => {
    const threshold = finite(frame.temporalHeadThreshold, 0.75);
    return finite(frame.songProbability, 0) >= Math.max(0.62, threshold - 0.1)
      || finite(frame.singingProbability, 0) >= 0.65;
  });
  return {
    frameCount: tailFrames.length,
    temporalMean: mean(temporal),
    temporalP50: quantile(temporal, 0.5),
    temporalP90: quantile(temporal, 0.9),
    singingMean: mean(singing),
    singingP90: quantile(singing, 0.9),
    speechMean: mean(speech),
    speechP90: quantile(speech, 0.9),
    musicMean: mean(music),
    resetRunSec: resetRun ? resetRun.durationSec : 0,
    resetStartOffsetSec: resetRun ? Math.max(0, resetRun.startSec - startSec) : Infinity,
    postResetDurationSec: resetRun ? Math.max(0, endSec - resetRun.endSec) : 0,
    postResetStrongSongRunSec,
  };
}

function summarizeSpeechResetPreWindow(frames, startSec, endSec) {
  const preFrames = framesInRange(frames, startSec, endSec);
  return {
    frameCount: preFrames.length,
    temporalMean: mean(values(preFrames, 'songProbability')),
    musicMean: mean(values(preFrames, 'musicProbability')),
    singingMean: mean(values(preFrames, 'singingProbability')),
  };
}

function speechResetTailPass(tailStats, preStats, options) {
  if (tailStats.frameCount < options.minTailFrames) return false;
  if (preStats.frameCount < options.minPreFrames) return false;
  const tailLooksNonSongSpeech = (
    tailStats.temporalMean <= options.maxTailTemporalMean
    && tailStats.temporalP50 <= options.maxTailTemporalP50
    && tailStats.temporalP90 <= options.maxTailTemporalP90
    && tailStats.singingMean <= options.maxTailSingingMean
    && tailStats.speechMean >= options.minTailSpeechMean
  );
  const musicBackedVocalTail = tailStats.musicMean >= 0.88
    && (
      tailStats.singingMean >= 0.24
      || (tailStats.singingP90 >= 0.6 && tailStats.temporalP90 >= 0.45)
    );
  const tailLooksPostResetRebound = (
    tailStats.resetRunSec >= 2
    && tailStats.resetStartOffsetSec <= 5
    && tailStats.postResetDurationSec <= 30
    && tailStats.postResetStrongSongRunSec <= 12
    && tailStats.temporalMean <= 0.58
  );
  const beforeLooksSongLike = (
    preStats.temporalMean >= options.minPreTemporalMean
    || preStats.musicMean >= options.minPreMusicMean
  );
  return beforeLooksSongLike && (
    (tailLooksNonSongSpeech && !musicBackedVocalTail)
    || tailLooksPostResetRebound
  );
}

export function refineLiveSegmentEndsBySpeechReset(segments, frames, options = {}) {
  const opts = {
    ...DEFAULT_LIVE_SPEECH_RESET_END_REFINEMENT_OPTIONS,
    ...options,
  };
  const normalizedFrames = normalizeFrames(frames);
  const inputSegments = Array.isArray(segments) ? segments : [];
  if (!opts.enabled || !inputSegments.length || !normalizedFrames.length) {
    return { segments: inputSegments.map(normalizeSegment), adjustments: [], changed: false };
  }

  const minDurationSec = Math.max(1, finite(opts.minSegmentDurationSec, DEFAULT_SEGMENT_FILTER_OPTIONS.minSegmentDurationSec));
  const scanStepSec = Math.max(0.1, finite(opts.scanStepSec, DEFAULT_LIVE_SPEECH_RESET_END_REFINEMENT_OPTIONS.scanStepSec));
  const adjustments = [];
  const refined = inputSegments.map((segment) => {
    const original = normalizeSegment(segment);
    const segmentDurationSec = original.endSec - original.startSec;
    if (segmentDurationSec <= minDurationSec + opts.minTrimSec) {
      adjustments.push({ action: 'keep', reason: 'too-short-for-speech-reset-trim', original, segment: original });
      return original;
    }

    const scanStart = Math.max(original.startSec + minDurationSec, original.endSec - opts.maxTrimSec);
    const scanEnd = original.endSec - opts.minTrimSec;
    if (scanEnd <= scanStart) {
      adjustments.push({ action: 'keep', reason: 'no-speech-reset-scan-range', original, segment: original });
      return original;
    }

    let best = null;
    for (let candidateEnd = scanStart; candidateEnd <= scanEnd + 1e-6; candidateEnd += scanStepSec) {
      const trimSec = original.endSec - candidateEnd;
      if (trimSec < opts.minTrimSec || trimSec < opts.minTailSec) continue;
      const tailStats = summarizeSpeechResetTail(normalizedFrames, candidateEnd, original.endSec);
      const preStats = summarizeSpeechResetPreWindow(
        normalizedFrames,
        candidateEnd - opts.preWindowSec,
        candidateEnd
      );
      if (!speechResetTailPass(tailStats, preStats, opts)) continue;
      best = { candidateEnd, trimSec, tailStats, preStats };
      break;
    }

    if (!best) {
      adjustments.push({ action: 'keep', reason: 'no-speech-reset-tail', original, segment: original });
      return original;
    }

    const nextSegment = normalizeSegment({
      ...original,
      endSec: roundNumber(best.candidateEnd, 3),
    });
    adjustments.push({
      action: 'speech-reset-end-trim',
      reason: 'low-temporal-high-speech-tail',
      trimSec: roundNumber(best.trimSec, 3),
      tailStats: {
        frameCount: best.tailStats.frameCount,
        temporalMean: roundNumber(best.tailStats.temporalMean, 4),
        temporalP50: roundNumber(best.tailStats.temporalP50, 4),
        temporalP90: roundNumber(best.tailStats.temporalP90, 4),
        singingMean: roundNumber(best.tailStats.singingMean, 4),
        singingP90: roundNumber(best.tailStats.singingP90, 4),
        speechMean: roundNumber(best.tailStats.speechMean, 4),
        speechP90: roundNumber(best.tailStats.speechP90, 4),
        musicMean: roundNumber(best.tailStats.musicMean, 4),
        resetRunSec: roundNumber(best.tailStats.resetRunSec, 3),
        resetStartOffsetSec: roundNumber(best.tailStats.resetStartOffsetSec, 3),
        postResetDurationSec: roundNumber(best.tailStats.postResetDurationSec, 3),
        postResetStrongSongRunSec: roundNumber(best.tailStats.postResetStrongSongRunSec, 3),
      },
      preStats: {
        frameCount: best.preStats.frameCount,
        temporalMean: roundNumber(best.preStats.temporalMean, 4),
        musicMean: roundNumber(best.preStats.musicMean, 4),
        singingMean: roundNumber(best.preStats.singingMean, 4),
      },
      original,
      segment: nextSegment,
    });
    return nextSegment;
  });

  const changed = adjustments.some((item) => item.action === 'speech-reset-end-trim');
  return { segments: refined, adjustments, changed };
}

function resolveOrt(runtime) {
  return runtime?.ort || runtime || globalThis.ort || null;
}

function isOrtSessionBusyError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('session already started') || message.includes('session mismatch');
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function retryOrtSessionRunWhenBusy(runOnce, runtime, label) {
  const maxRetries = 8;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await runOnce();
    } catch (error) {
      if (!isOrtSessionBusyError(error) || attempt >= maxRetries) {
        throw error;
      }
      runtime.lastRunQueueRetry = {
        label,
        attempt: attempt + 1,
        error: error?.message || String(error),
        at: new Date().toISOString(),
      };
      await delayMs(20 + (attempt * 20));
    }
  }
  throw new Error(`${label} stayed busy after retries.`);
}

async function enqueueOrtSessionRun(runtime, label, runOnce) {
  const ort = resolveOrt(runtime?.ort || runtime);
  const queueTarget = ort || runtime;
  const previous = queueTarget.__ytjOrtRunQueue || Promise.resolve();
  const queued = previous.catch(() => {}).then(() => retryOrtSessionRunWhenBusy(runOnce, runtime, label));
  queueTarget.__ytjOrtRunQueue = queued.catch(() => {});
  if (runtime && typeof runtime === 'object') {
    runtime.runQueue = queueTarget.__ytjOrtRunQueue;
  }
  return queued;
}

export async function loadSegmentFilterModel({
  ort: ortRuntime = null,
  modelUrl = null,
  metaUrl = null,
  executionProviders = ['wasm'],
  assetProfile = 'default',
  assetBasePath = 'models/fireredvad/aed',
  requireAssetProfile = false,
} = {}) {
  const ort = resolveOrt(ortRuntime);
  if (!ort?.InferenceSession || !ort?.Tensor) {
    throw new Error('ONNX Runtime Web is unavailable for segment filter.');
  }
  const requestedAssetProfile = normalizeSegmentFilterAssetProfile(assetProfile).key;
  const candidates = modelUrl
    ? [{ assetProfile: requestedAssetProfile, modelUrl, metaUrl }]
    : assetCandidates('segment', requestedAssetProfile, assetBasePath, {
      allowProfileFallback: !requireAssetProfile,
    });
  return createProfiledSession({
    ort,
    candidates,
    executionProviders,
    requestedAssetProfile,
  });
}

export async function runSegmentFilterModel(runtime, segments, frames, context = {}, options = {}) {
  const ort = resolveOrt(runtime?.ort || runtime);
  const session = runtime?.session || runtime;
  if (!ort?.Tensor || !session?.run) {
    throw new Error('Invalid segment filter runtime.');
  }
  const meta = runtime?.meta || {};
  const features = buildSegmentFilterFeatureMatrix(segments, frames, context, options);
  if (!features.length) return [];
  const inputDim = Number(meta.inputDim) || SEGMENT_FILTER_FEATURE_NAMES.length;
  const input = new Float32Array(features.length * inputDim);
  for (let row = 0; row < features.length; row += 1) {
    for (let col = 0; col < inputDim; col += 1) {
      input[(row * inputDim) + col] = Number(features[row][col]) || 0;
    }
  }
  const inputName = meta.inputName || session.inputNames?.[0] || 'segment_features';
  const outputName = meta.outputName || session.outputNames?.[0] || 'segment_filter_output';
  const feeds = { [inputName]: new ort.Tensor('float32', input, [features.length, inputDim]) };
  const output = await enqueueOrtSessionRun(runtime, 'segment-filter', () => session.run(feeds));
  const tensor = output[outputName] || output[Object.keys(output)[0]];
  const data = tensor?.data || [];
  const outputWidth = Math.max(1, Math.floor(data.length / Math.max(1, features.length)));
  const predictions = [];
  for (let row = 0; row < features.length; row += 1) {
    predictions.push({
      keepProbability: clamp(data[(row * outputWidth)] ?? 1, 0, 1),
      startTrimDeltaSec: outputWidth >= 3
        ? clamp(data[(row * outputWidth) + 1] ?? 0, -DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec, DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec)
        : 0,
      endTrimDeltaSec: outputWidth >= 3
        ? clamp(data[(row * outputWidth) + 2] ?? 0, -DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec, DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec)
        : 0,
    });
  }
  return predictions;
}

export async function loadEdgeTrimAdvisorModel({
  ort: ortRuntime = null,
  modelUrl = null,
  metaUrl = null,
  executionProviders = ['wasm'],
  assetProfile = 'default',
  assetBasePath = 'models/fireredvad/aed',
  requireAssetProfile = false,
} = {}) {
  const ort = resolveOrt(ortRuntime);
  if (!ort?.InferenceSession || !ort?.Tensor) {
    throw new Error('ONNX Runtime Web is unavailable for edge trim advisor.');
  }
  const requestedAssetProfile = normalizeSegmentFilterAssetProfile(assetProfile).key;
  const candidates = modelUrl
    ? [{ assetProfile: requestedAssetProfile, modelUrl, metaUrl }]
    : assetCandidates('edge', requestedAssetProfile, assetBasePath, {
      allowProfileFallback: !requireAssetProfile,
    });
  return createProfiledSession({
    ort,
    candidates,
    executionProviders,
    requestedAssetProfile,
  });
}

export async function runEdgeTrimAdvisorModel(runtime, segments, frames, context = {}, options = {}) {
  const ort = resolveOrt(runtime?.ort || runtime);
  const session = runtime?.session || runtime;
  if (!ort?.Tensor || !session?.run) {
    throw new Error('Invalid edge trim advisor runtime.');
  }
  const meta = runtime?.meta || {};
  const features = buildSegmentFilterFeatureMatrix(segments, frames, context, options);
  if (!features.length) return [];
  const inputDim = Number(meta.inputDim) || SEGMENT_FILTER_FEATURE_NAMES.length;
  const input = new Float32Array(features.length * inputDim);
  for (let row = 0; row < features.length; row += 1) {
    for (let col = 0; col < inputDim; col += 1) {
      input[(row * inputDim) + col] = Number(features[row][col]) || 0;
    }
  }
  const inputName = meta.inputName || session.inputNames?.[0] || 'segment_features';
  const outputName = meta.outputName || session.outputNames?.[0] || 'edge_trim_delta_sec';
  const feeds = { [inputName]: new ort.Tensor('float32', input, [features.length, inputDim]) };
  const output = await enqueueOrtSessionRun(runtime, 'edge-trim-advisor', () => session.run(feeds));
  const tensor = output[outputName] || output[Object.keys(output)[0]];
  const data = tensor?.data || [];
  const predictions = [];
  for (let row = 0; row < features.length; row += 1) {
    predictions.push({
      startTrimDeltaSec: clamp(data[(row * 2)] ?? 0, -DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec, DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec),
      endTrimDeltaSec: clamp(data[(row * 2) + 1] ?? 0, -DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec, DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec),
    });
  }
  return predictions;
}

export async function runSegmentFilterPipeline(runtimes, segments, frames, context = {}, options = {}) {
  const keepPredictions = runtimes?.segmentFilter
    ? await runSegmentFilterModel(runtimes.segmentFilter, segments, frames, context, options)
    : [];
  const edgePredictions = runtimes?.edgeTrimAdvisor
    ? await runEdgeTrimAdvisorModel(runtimes.edgeTrimAdvisor, segments, frames, context, options)
    : [];
  return (Array.isArray(segments) ? segments : []).map((_, index) => ({
    keepProbability: keepPredictions[index]?.keepProbability ?? 1,
    startTrimDeltaSec: edgePredictions[index]?.startTrimDeltaSec ?? 0,
    endTrimDeltaSec: edgePredictions[index]?.endTrimDeltaSec ?? 0,
  }));
}
