import { roundNumber } from './common.js';
import { normalizeAnalysisFrame } from './analysisFrame.js';
import { estimateMusicRepetition } from './musicRepetition.js';

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

function clamp(value, min, max) {
  const num = finite(value, min);
  return Math.max(min, Math.min(max, num));
}

function maxRunSec(frames, predicate, hopSec = 0.5) {
  let currentSec = 0;
  let bestSec = 0;
  for (const frame of frames) {
    if (predicate(frame)) {
      currentSec += hopSec;
      bestSec = Math.max(bestSec, currentSec);
    } else {
      currentSec = 0;
    }
  }
  return bestSec;
}

function countShortMusicBursts(frames, hopSec = 0.5) {
  // Counts isolated music-only bursts, not repeated-fragment similarity.
  // Repetition similarity is estimated separately by musicRepetition.js.
  let currentSec = 0;
  let burstCount = 0;
  for (const frame of frames) {
    const musicOnly = frame.music >= 0.65
      && frame.singing <= 0.22
      && frame.speech <= 0.35;
    if (musicOnly) {
      currentSec += hopSec;
      continue;
    }
    if (currentSec >= 3 && currentSec <= 20) burstCount += 1;
    currentSec = 0;
  }
  if (currentSec >= 3 && currentSec <= 20) burstCount += 1;
  return burstCount;
}

function summarizeDiagnosticWindow(frames) {
  const normalized = frames.map(normalizeFrame).filter(Boolean);
  const base = summarizeNormalizedFrames(frames);
  if (!normalized.length) {
    return {
      ...base,
      vocalDominance: 0,
      musicOnlyScore: 0,
      postResetRebound: 0,
      repetitionScore: null,
      repetitionScoreStatus: 'insufficient-frames',
      energyDropStructure: 0,
      tailSpeechWithMusic: 0,
      acapellaCandidate: false,
      shortMusicBurstCount: 0,
      strongSongRunSec: 0,
      resetRunSec: 0,
    };
  }

  const singingMean = finite(base.stats?.singing?.mean, 0);
  const musicMean = finite(base.stats?.music?.mean, 0);
  const speechMean = finite(base.stats?.speech?.mean, 0);
  const temporalMean = finite(base.stats?.temporal?.mean, 0);
  const rmsMean = finite(base.stats?.audioRms?.mean, 0);
  const spectralFluxMean = finite(base.stats?.spectralFlux?.mean, 0);
  const lowEnergyRatio = finite(base.lowEnergyRatio, 0);
  const strongSongRunSec = maxRunSec(normalized, (frame) => {
    const threshold = Math.max(0.62, frame.temporalThreshold - 0.1);
    return frame.temporal >= threshold || frame.singing >= 0.65;
  });
  const resetRunSec = maxRunSec(normalized, (frame) => (
    (frame.audioRms <= 0.006 && frame.audioPeak <= 0.025)
    || (frame.audioRms <= 0.015 && frame.temporal <= 0.35 && frame.singing <= 0.2)
    || (frame.temporal <= 0.22 && frame.singing <= 0.1 && frame.music <= 0.7)
  ));
  const shortMusicBurstCount = countShortMusicBursts(normalized);
  const repetition = estimateMusicRepetition(frames);
  const musicOnlyScore = clamp(
    (musicMean - (singingMean * 1.7) - (speechMean * 1.15) + (base.durationSec >= 180 ? 0.12 : 0)) / 0.75,
    0,
    1
  );
  const vocalDominance = clamp(singingMean - Math.max(speechMean, musicOnlyScore * 0.5), -1, 1);
  const tailSpeechWithMusic = clamp(musicMean * speechMean * (1 - Math.min(1, singingMean)), 0, 1);
  const energyDropStructure = clamp((lowEnergyRatio * 0.65) + ((1 - Math.min(1, rmsMean * 35)) * 0.25) + (spectralFluxMean * 0.1), 0, 1);
  const postResetRebound = clamp(
    (resetRunSec >= 1.5 && strongSongRunSec > 0 && strongSongRunSec <= 12)
      ? (0.45 + (resetRunSec / 8) + ((12 - strongSongRunSec) / 30))
      : 0,
    0,
    1
  );
  const acapellaCandidate = singingMean >= 0.55
    && musicMean <= 0.45
    && speechMean <= 0.35
    && temporalMean >= 0.45;

  return {
    ...base,
    vocalDominance: roundNumber(vocalDominance, 4),
    musicOnlyScore: roundNumber(musicOnlyScore, 4),
    postResetRebound: roundNumber(postResetRebound, 4),
    repetitionScore: repetition.score,
    repetitionScoreStatus: repetition.status,
    repetition,
    energyDropStructure: roundNumber(energyDropStructure, 4),
    tailSpeechWithMusic: roundNumber(tailSpeechWithMusic, 4),
    acapellaCandidate,
    shortMusicBurstCount,
    strongSongRunSec: roundNumber(strongSongRunSec, 3),
    resetRunSec: roundNumber(resetRunSec, 3),
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

export function summarizeSegmentDiagnosticFeatures(frames, segment, options = {}) {
  const startSec = finite(segment?.startSec, null);
  const endSec = finite(segment?.endSec, null);
  if (startSec === null || endSec === null || endSec <= startSec) {
    return summarizeDiagnosticWindow([]);
  }
  const edgeWindowSec = Math.max(1, Number(options.edgeWindowSec) || 20);
  const segmentFrames = selectFramesInRange(frames, startSec, endSec);
  const startEdgeFrames = selectFramesInRange(frames, Math.max(0, startSec - edgeWindowSec), startSec + edgeWindowSec);
  const endEdgeFrames = selectFramesInRange(frames, Math.max(startSec, endSec - edgeWindowSec), endSec + edgeWindowSec);
  return {
    ...summarizeDiagnosticWindow(segmentFrames),
    startEdge: summarizeDiagnosticWindow(startEdgeFrames),
    endEdge: summarizeDiagnosticWindow(endEdgeFrames),
  };
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
