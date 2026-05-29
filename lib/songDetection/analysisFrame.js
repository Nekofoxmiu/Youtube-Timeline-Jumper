import { clamp, roundNumber } from './common.js';

export const ANALYSIS_FRAME_VERSION = 'analysis-frame-v1';
export const ANALYSIS_FRAME_HOP_SEC = 0.5;

function finite(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function probability(value, fallback = 0) {
  return clamp(finite(value, fallback) ?? fallback, 0, 1);
}

function nonNegative(value, fallback = 0) {
  return Math.max(0, finite(value, fallback) ?? fallback);
}

function nullableProbability(value) {
  const num = finite(value, null);
  return num === null ? null : clamp(num, 0, 1);
}

function nullableNumber(value) {
  return finite(value, null);
}

export function normalizeAnalysisFrame(frame, options = {}) {
  const timeSec = finite(frame?.timeSec, null);
  if (timeSec === null) return null;

  const temporalHeadProbability = nullableProbability(frame?.temporalHeadProbability);
  const songProbability = probability(frame?.songProbability, temporalHeadProbability ?? 0);
  const temporalHeadThreshold = nullableProbability(frame?.temporalHeadThreshold);
  const sourceMode = String(options.sourceMode || frame?.sourceMode || '').trim() || null;

  return {
    ...frame,
    analysisFrameVersion: ANALYSIS_FRAME_VERSION,
    ready: frame?.ready !== false,
    timeSec,
    sourceMode,
    sourceRangeId: frame?.sourceRangeId ?? options.sourceRangeId ?? null,
    discontinuityBefore: Boolean(frame?.discontinuityBefore || options.discontinuityBefore),
    discontinuityAfter: Boolean(frame?.discontinuityAfter || options.discontinuityAfter),
    songProbability,
    baseSongProbability: probability(frame?.baseSongProbability, songProbability),
    temporalHeadReady: Boolean(frame?.temporalHeadReady || temporalHeadProbability !== null),
    temporalHeadProbability,
    temporalHeadThreshold,
    temporalHeadHistoryWindows: nonNegative(frame?.temporalHeadHistoryWindows, 0),
    speechProbability: probability(frame?.speechProbability ?? frame?.speechMean),
    singingProbability: probability(frame?.singingProbability ?? frame?.singingMean),
    musicProbability: probability(frame?.musicProbability ?? frame?.musicMean),
    speechMean: probability(frame?.speechMean ?? frame?.speechProbability),
    singingMean: probability(frame?.singingMean ?? frame?.singingProbability),
    musicMean: probability(frame?.musicMean ?? frame?.musicProbability),
    speechRatio: probability(frame?.speechRatio),
    singingRatio: probability(frame?.singingRatio),
    musicRatio: probability(frame?.musicRatio),
    audioRms: nonNegative(frame?.audioRms),
    audioPeak: nonNegative(frame?.audioPeak),
    spectralCentroid: probability(frame?.spectralCentroid),
    spectralFlatness: probability(frame?.spectralFlatness),
    spectralFlux: probability(frame?.spectralFlux),
    lowEnergyRatio: probability(frame?.lowEnergyRatio),
    midEnergyRatio: probability(frame?.midEnergyRatio),
    highEnergyRatio: probability(frame?.highEnergyRatio),
    analyzedAudioSec: nullableNumber(frame?.analyzedAudioSec),
    detectorVersion: frame?.detectorVersion ?? options.detectorVersion ?? null,
  };
}

export function normalizeAnalysisFrames(frames, options = {}) {
  return (Array.isArray(frames) ? frames : [])
    .map((frame) => normalizeAnalysisFrame(frame, options))
    .filter(Boolean)
    .sort((a, b) => a.timeSec - b.timeSec);
}

export function dedupeAnalysisFrames(frames, { minGapSec = ANALYSIS_FRAME_HOP_SEC / 2 } = {}) {
  const normalized = normalizeAnalysisFrames(frames);
  const output = [];
  let lastTimeSec = null;
  for (const frame of normalized) {
    if (lastTimeSec !== null && frame.timeSec <= lastTimeSec + minGapSec) continue;
    output.push({ ...frame, timeSec: roundNumber(frame.timeSec, 3) });
    lastTimeSec = frame.timeSec;
  }
  return output;
}
