import { roundNumber } from './common.js';
import { normalizeAnalysisFrame } from './analysisFrame.js';

function finite(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp01(value) {
  const num = finite(value, 0);
  return Math.max(0, Math.min(1, num));
}

function frameTime(frame) {
  return finite(frame?.timeSec, null);
}

function frameValue(frame, names, fallback = 0) {
  for (const name of names) {
    const value = finite(frame?.[name], null);
    if (value !== null) return value;
  }
  return fallback;
}

function quantile(sortedValues, ratio) {
  if (!sortedValues.length) return 0;
  const bounded = Math.max(0, Math.min(1, Number(ratio) || 0));
  const index = Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * bounded));
  return sortedValues[index];
}

function summarizeValues(values) {
  const safeValues = values
    .map((value) => finite(value, null))
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  if (!safeValues.length) {
    return {
      count: 0,
      mean: 0,
      min: 0,
      p50: 0,
      p80: 0,
      p90: 0,
      p95: 0,
      max: 0,
    };
  }
  const sum = safeValues.reduce((total, value) => total + value, 0);
  return {
    count: safeValues.length,
    mean: roundNumber(sum / safeValues.length, 4),
    min: roundNumber(safeValues[0], 4),
    p50: roundNumber(quantile(safeValues, 0.5), 4),
    p80: roundNumber(quantile(safeValues, 0.8), 4),
    p90: roundNumber(quantile(safeValues, 0.9), 4),
    p95: roundNumber(quantile(safeValues, 0.95), 4),
    max: roundNumber(safeValues[safeValues.length - 1], 4),
  };
}

function normalizeFrame(frame) {
  const normalized = normalizeAnalysisFrame(frame);
  if (!normalized) return null;
  const timeSec = frameTime(normalized);
  return {
    timeSec,
    temporal: clamp01(frameValue(normalized, ['temporalHeadProbability', 'songProbability'])),
    temporalThreshold: clamp01(frameValue(normalized, ['temporalHeadThreshold'], 0.75)),
    temporalReady: Boolean(normalized.temporalHeadReady),
    singing: clamp01(frameValue(normalized, ['singingProbability', 'singingMean'])),
    music: clamp01(frameValue(normalized, ['musicProbability', 'musicMean'])),
    speech: clamp01(frameValue(normalized, ['speechProbability', 'speechMean'])),
    singingRatio: clamp01(frameValue(normalized, ['singingRatio'])),
    musicRatio: clamp01(frameValue(normalized, ['musicRatio'])),
    speechRatio: clamp01(frameValue(normalized, ['speechRatio'])),
    audioRms: Math.max(0, frameValue(normalized, ['audioRms'])),
    audioPeak: Math.max(0, frameValue(normalized, ['audioPeak'])),
    spectralFlatness: clamp01(frameValue(normalized, ['spectralFlatness'])),
    spectralFlux: clamp01(frameValue(normalized, ['spectralFlux'])),
    midEnergyRatio: clamp01(frameValue(normalized, ['midEnergyRatio'])),
  };
}

function summarizeNormalizedFrames(frames) {
  const normalized = frames.map(normalizeFrame).filter(Boolean);
  const count = normalized.length;
  if (!count) {
    return {
      frameCount: 0,
      startSec: null,
      endSec: null,
      durationSec: 0,
      temporalReadyRatio: 0,
      modelHighRatio: 0,
      singingHighRatio: 0,
      musicHighRatio: 0,
      speechHighRatio: 0,
      musicOnlyLowVocalRatio: 0,
      lowEnergyRatio: 0,
      stats: {},
    };
  }

  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  const ratio = (predicate) => roundNumber(normalized.filter(predicate).length / count, 4);
  return {
    frameCount: count,
    startSec: roundNumber(first.timeSec, 3),
    endSec: roundNumber(last.timeSec, 3),
    durationSec: roundNumber(Math.max(0, last.timeSec - first.timeSec), 3),
    temporalReadyRatio: ratio((frame) => frame.temporalReady),
    modelHighRatio: ratio((frame) => frame.temporal >= frame.temporalThreshold),
    singingHighRatio: ratio((frame) => frame.singing >= 0.78 || frame.singingRatio >= 0.18),
    musicHighRatio: ratio((frame) => frame.music >= 0.65 || frame.musicRatio >= 0.35),
    speechHighRatio: ratio((frame) => frame.speech >= 0.65 || frame.speechRatio >= 0.35),
    musicOnlyLowVocalRatio: ratio((frame) => frame.music >= 0.65 && frame.singing <= 0.22 && frame.speech <= 0.32),
    lowEnergyRatio: ratio((frame) => frame.audioRms <= 0.0045 && frame.audioPeak <= 0.018),
    stats: {
      temporal: summarizeValues(normalized.map((frame) => frame.temporal)),
      singing: summarizeValues(normalized.map((frame) => frame.singing)),
      music: summarizeValues(normalized.map((frame) => frame.music)),
      speech: summarizeValues(normalized.map((frame) => frame.speech)),
      audioRms: summarizeValues(normalized.map((frame) => frame.audioRms)),
      spectralFlatness: summarizeValues(normalized.map((frame) => frame.spectralFlatness)),
      spectralFlux: summarizeValues(normalized.map((frame) => frame.spectralFlux)),
      midEnergyRatio: summarizeValues(normalized.map((frame) => frame.midEnergyRatio)),
    },
  };
}

function selectFramesInRange(frames, startSec, endSec) {
  const start = finite(startSec, null);
  const end = finite(endSec, null);
  if (start === null || end === null || end <= start) return [];
  return frames.filter((frame) => {
    const timeSec = frameTime(frame);
    return timeSec !== null && timeSec >= start && timeSec <= end;
  });
}

function summarizeSegments(frames, segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment, index) => {
      const startSec = finite(segment?.startSec, null);
      const endSec = finite(segment?.endSec, null);
      if (startSec === null || endSec === null || endSec <= startSec) return null;
      return {
        index,
        startSec: roundNumber(startSec, 3),
        endSec: roundNumber(endSec, 3),
        durationSec: roundNumber(endSec - startSec, 3),
        confidence: roundNumber(finite(segment?.confidence, 0), 4),
        ...summarizeNormalizedFrames(selectFramesInRange(frames, startSec, endSec)),
      };
    })
    .filter(Boolean);
}

export function summarizeAnalysisFrameDistribution(frames, options = {}) {
  const sourceFrames = Array.isArray(frames) ? frames : [];
  const normalized = sourceFrames.map(normalizeFrame).filter(Boolean);
  const all = summarizeNormalizedFrames(sourceFrames);
  const firstTime = normalized[0]?.timeSec ?? 0;
  const lastTime = normalized[normalized.length - 1]?.timeSec ?? 0;
  const firstWindowSec = Math.max(0, Number(options.firstWindowSec) || 30 * 60);
  const tailWindowSec = Math.max(0, Number(options.tailWindowSec) || 10 * 60);
  const firstWindowEnd = firstTime + firstWindowSec;
  const tailWindowStart = Math.max(firstTime, lastTime - tailWindowSec);

  return {
    all,
    firstWindowSec,
    firstWindow: summarizeNormalizedFrames(selectFramesInRange(sourceFrames, firstTime, firstWindowEnd)),
    tailWindowSec,
    tailWindow: summarizeNormalizedFrames(selectFramesInRange(sourceFrames, tailWindowStart, lastTime)),
    segments: summarizeSegments(sourceFrames, options.segments),
  };
}

export function summarizeRecentAnalysisFrameDistribution(frames, options = {}) {
  const sourceFrames = Array.isArray(frames) ? frames : [];
  const normalized = sourceFrames.map(normalizeFrame).filter(Boolean);
  if (!normalized.length) return summarizeNormalizedFrames([]);
  const lastTime = normalized[normalized.length - 1].timeSec;
  const windowSec = Math.max(1, Number(options.windowSec) || 10 * 60);
  const startTime = Math.max(normalized[0].timeSec, lastTime - windowSec);
  return {
    windowSec,
    ...summarizeNormalizedFrames(selectFramesInRange(sourceFrames, startTime, lastTime)),
  };
}
