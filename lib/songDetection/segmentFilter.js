const SEGMENT_FILTER_VERSION = 'segment-filter-v1';

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
]);

export const DEFAULT_SEGMENT_FILTER_OPTIONS = Object.freeze({
  keepThreshold: 0.35,
  trimConfidenceThreshold: 0.55,
  trimClampSec: 60,
  minSegmentDurationSec: 90,
  edgeWindowSec: 20,
  lowEnergyRmsThreshold: 0.006,
  lowEnergyPeakThreshold: 0.025,
  lowEnergyRatioThreshold: 0.72,
  speechResetThreshold: 0.58,
  speechResetSingingCeiling: 0.38,
  speechResetMusicCeiling: 0.72,
});

export { SEGMENT_FILTER_VERSION };

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

function normalizeFrame(frame) {
  const timeSec = finite(frame?.timeSec, NaN);
  if (!Number.isFinite(timeSec)) return null;
  return {
    ...frame,
    timeSec,
    songProbability: clamp(frame?.temporalHeadProbability ?? frame?.songProbability, 0, 1),
    temporalHeadThreshold: clamp(frame?.temporalHeadThreshold, 0.05, 0.95),
    singingProbability: clamp(frame?.singingProbability ?? frame?.singingMean, 0, 1),
    musicProbability: clamp(frame?.musicProbability ?? frame?.musicMean, 0, 1),
    speechProbability: clamp(frame?.speechProbability ?? frame?.speechMean, 0, 1),
    singingRatio: clamp(frame?.singingRatio, 0, 1),
    musicRatio: clamp(frame?.musicRatio, 0, 1),
    speechRatio: clamp(frame?.speechRatio, 0, 1),
    audioRms: Math.max(0, finite(frame?.audioRms, 0)),
    audioPeak: Math.max(0, finite(frame?.audioPeak, 0)),
    spectralFlatness: clamp(frame?.spectralFlatness, 0, 1),
    spectralFlux: clamp(frame?.spectralFlux, 0, 1),
    midEnergyRatio: clamp(frame?.midEnergyRatio, 0, 1),
    lowEnergyRatio: clamp(frame?.lowEnergyRatio, 0, 1),
  };
}

function normalizeFrames(frames) {
  return (Array.isArray(frames) ? frames : [])
    .map(normalizeFrame)
    .filter(Boolean)
    .sort((a, b) => a.timeSec - b.timeSec);
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
  const musicMean = mean(music);
  const singingMean = mean(singing);
  const speechMean = mean(speech);
  const musicOnlyExtraScore = clamp((musicMean - (singingMean * 1.7) - (speechMean * 1.15) + (durationSec >= 180 ? 0.12 : 0)) / 0.75, 0, 1);

  return [
    durationSec,
    clamp(segment?.confidence, 0, 1),
    mean(temporal),
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
    mean(audioRms),
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

export function applySegmentFilterPredictions(segments, predictions, options = {}) {
  const opts = { ...DEFAULT_SEGMENT_FILTER_OPTIONS, ...options };
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
    const startTrimDeltaSec = clamp(prediction.startTrimDeltaSec ?? prediction.start_delta_sec ?? 0, -opts.trimClampSec, opts.trimClampSec);
    const endTrimDeltaSec = clamp(prediction.endTrimDeltaSec ?? prediction.end_delta_sec ?? 0, -opts.trimClampSec, opts.trimClampSec);
    const original = normalizeSegment(segment);

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
      let proposedStart = original.startSec + startTrimDeltaSec;
      let proposedEnd = original.endSec + endTrimDeltaSec;
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
      original,
      segment: nextSegment,
    });
  }

  const changed = adjustments.some((item) => item.action !== 'keep');
  return { segments: kept.map(normalizeSegment), adjustments, changed };
}

function resolveOrt(runtime) {
  return runtime?.ort || runtime || globalThis.ort || null;
}

export async function loadSegmentFilterModel({ ort: ortRuntime = null, modelUrl = null, metaUrl = null, executionProviders = ['wasm'] } = {}) {
  const ort = resolveOrt(ortRuntime);
  if (!ort?.InferenceSession || !ort?.Tensor) {
    throw new Error('ONNX Runtime Web is unavailable for segment filter.');
  }
  const resolvedModelUrl = modelUrl || (globalThis.chrome?.runtime?.getURL
    ? chrome.runtime.getURL('models/fireredvad/aed/segment_filter.onnx')
    : 'models/fireredvad/aed/segment_filter.onnx');
  const resolvedMetaUrl = metaUrl || (globalThis.chrome?.runtime?.getURL
    ? chrome.runtime.getURL('models/fireredvad/aed/segment_filter.meta.json')
    : 'models/fireredvad/aed/segment_filter.meta.json');
  const [session, meta] = await Promise.all([
    ort.InferenceSession.create(resolvedModelUrl, { executionProviders }),
    fetch(resolvedMetaUrl).then((response) => (response.ok ? response.json() : null)).catch(() => null),
  ]);
  return { ort, session, meta: meta || {}, modelUrl: resolvedModelUrl };
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
  const output = await session.run({ [inputName]: new ort.Tensor('float32', input, [features.length, inputDim]) });
  const tensor = output[outputName] || output[Object.keys(output)[0]];
  const data = tensor?.data || [];
  const predictions = [];
  for (let row = 0; row < features.length; row += 1) {
    predictions.push({
      keepProbability: clamp(data[(row * 3)] ?? 1, 0, 1),
      startTrimDeltaSec: clamp(data[(row * 3) + 1] ?? 0, -DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec, DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec),
      endTrimDeltaSec: clamp(data[(row * 3) + 2] ?? 0, -DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec, DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec),
    });
  }
  return predictions;
}
