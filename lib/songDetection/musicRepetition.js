import { normalizeAnalysisFrame } from './analysisFrame.js';
import { clamp, roundNumber } from './common.js';

export const MUSIC_REPETITION_VERSION = 'music-repetition-feature-fingerprint-v1';

function finite(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values, avg = mean(values)) {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length);
}

function frameValue(frame, primary, secondary = null) {
  return clamp(finite(frame?.[primary] ?? (secondary ? frame?.[secondary] : 0), 0), 0, 1);
}

function normalizeFrames(frames) {
  return (Array.isArray(frames) ? frames : [])
    .map((frame) => normalizeAnalysisFrame(frame))
    .filter(Boolean)
    .sort((a, b) => a.timeSec - b.timeSec);
}

function summarizeWindow(frames, startSec, endSec) {
  const windowFrames = frames.filter((frame) => frame.timeSec >= startSec && frame.timeSec < endSec);
  if (!windowFrames.length) return null;

  const music = windowFrames.map((frame) => frameValue(frame, 'musicProbability', 'musicMean'));
  const singing = windowFrames.map((frame) => frameValue(frame, 'singingProbability', 'singingMean'));
  const speech = windowFrames.map((frame) => frameValue(frame, 'speechProbability', 'speechMean'));
  const temporal = windowFrames.map((frame) => frameValue(frame, 'temporalHeadProbability', 'songProbability'));
  const rms = windowFrames.map((frame) => Math.min(1, Math.log1p(Math.max(0, finite(frame.audioRms, 0)) * 60) / Math.log1p(60)));
  const flatness = windowFrames.map((frame) => frameValue(frame, 'spectralFlatness'));
  const flux = windowFrames.map((frame) => frameValue(frame, 'spectralFlux'));
  const centroid = windowFrames.map((frame) => frameValue(frame, 'spectralCentroid'));
  const mid = windowFrames.map((frame) => frameValue(frame, 'midEnergyRatio'));
  const high = windowFrames.map((frame) => frameValue(frame, 'highEnergyRatio'));

  const musicMean = mean(music);
  const singingMean = mean(singing);
  const speechMean = mean(speech);
  const temporalMean = mean(temporal);
  const vector = [
    musicMean,
    singingMean,
    speechMean,
    temporalMean,
    mean(rms),
    stddev(rms),
    mean(flatness),
    mean(flux),
    mean(centroid),
    mean(mid),
    mean(high),
  ];

  return {
    startSec,
    endSec,
    durationSec: endSec - startSec,
    frameCount: windowFrames.length,
    musicMean,
    singingMean,
    speechMean,
    temporalMean,
    vector,
    musicOnlyLike: musicMean >= 0.58
      && singingMean <= 0.28
      && speechMean <= 0.42
      && temporalMean <= 0.42,
    vocalLike: singingMean >= 0.4 || temporalMean >= 0.55,
  };
}

function buildWindows(frames, options) {
  if (!frames.length) return [];
  const first = Number.isFinite(Number(options.startSec)) ? Number(options.startSec) : frames[0].timeSec;
  const last = Number.isFinite(Number(options.endSec)) ? Number(options.endSec) : frames[frames.length - 1].timeSec;
  const windowSec = Math.max(2, finite(options.windowSec, 8));
  const hopSec = Math.max(1, finite(options.hopSec, 4));
  const windows = [];
  for (let startSec = first; startSec + windowSec <= last + 0.001; startSec += hopSec) {
    const summary = summarizeWindow(frames, startSec, startSec + windowSec);
    if (summary && summary.frameCount >= Math.max(2, Math.floor(windowSec))) {
      windows.push(summary);
    }
  }
  return windows;
}

function fingerprintSimilarity(left, right) {
  const weights = [0.9, 1.15, 0.7, 1.05, 1.0, 0.65, 1.0, 0.8, 1.0, 1.0, 0.75];
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  let distance = 0;
  for (let index = 0; index < weights.length; index += 1) {
    distance += Math.abs((left.vector[index] || 0) - (right.vector[index] || 0)) * weights[index];
  }
  return clamp(1 - (distance / Math.max(0.001, weightTotal * 0.42)), 0, 1);
}

export function estimateMusicRepetition(frames, options = {}) {
  const normalized = normalizeFrames(frames);
  const windows = buildWindows(normalized, options);
  const musicWindows = windows.filter((window) => window.musicOnlyLike);
  const minSeparationSec = Math.max(8, finite(options.minSeparationSec, 24));
  const similarityThreshold = clamp(finite(options.similarityThreshold, 0.9), 0.5, 0.99);
  const matchedIndexes = new Set();
  const matches = [];
  let bestSimilarity = 0;

  for (let leftIndex = 0; leftIndex < musicWindows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < musicWindows.length; rightIndex += 1) {
      const left = musicWindows[leftIndex];
      const right = musicWindows[rightIndex];
      if (right.startSec - left.startSec < minSeparationSec) continue;
      const similarity = fingerprintSimilarity(left, right);
      bestSimilarity = Math.max(bestSimilarity, similarity);
      if (similarity < similarityThreshold) continue;
      matchedIndexes.add(leftIndex);
      matchedIndexes.add(rightIndex);
      matches.push({
        leftStartSec: roundNumber(left.startSec, 3),
        rightStartSec: roundNumber(right.startSec, 3),
        similarity: roundNumber(similarity, 4),
      });
    }
  }

  const repeatedWindowRatio = musicWindows.length ? matchedIndexes.size / musicWindows.length : 0;
  const musicOnlyWindowRatio = windows.length ? musicWindows.length / windows.length : 0;
  const vocalWindowRatio = windows.length
    ? windows.filter((window) => window.vocalLike).length / windows.length
    : 0;
  const supportEnough = musicWindows.length >= 4 && matchedIndexes.size >= 3;
  const rawScore = supportEnough
    ? ((Math.max(0, bestSimilarity - 0.82) / 0.18) * 0.38)
      + (repeatedWindowRatio * 0.44)
      + (musicOnlyWindowRatio * 0.18)
    : 0;
  const vocalPenalty = Math.max(0, vocalWindowRatio - 0.18) * 0.75;
  const score = clamp(rawScore - vocalPenalty, 0, 1);

  return {
    version: MUSIC_REPETITION_VERSION,
    status: 'feature-fingerprint-v1',
    score: roundNumber(score, 4),
    bestSimilarity: roundNumber(bestSimilarity, 4),
    windowCount: windows.length,
    musicOnlyWindowCount: musicWindows.length,
    matchedWindowCount: matchedIndexes.size,
    matchCount: matches.length,
    repeatedWindowRatio: roundNumber(repeatedWindowRatio, 4),
    musicOnlyWindowRatio: roundNumber(musicOnlyWindowRatio, 4),
    vocalWindowRatio: roundNumber(vocalWindowRatio, 4),
    windowSec: Math.max(2, finite(options.windowSec, 8)),
    hopSec: Math.max(1, finite(options.hopSec, 4)),
    minSeparationSec,
    similarityThreshold,
    matches: matches.slice(0, 12),
  };
}
