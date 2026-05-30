import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { FireRedAedSongDetector } from '../../lib/songDetection/fireredAedDetector.js';
import {
  summarizeAnalysisFrameDistribution,
  summarizeSegmentDiagnosticFeatures,
} from '../../lib/songDetection/frameDiagnostics.js';
import { smoothFireRedAnalyses } from '../../lib/songDetection/globalSmoothing.js';
import {
  DEFAULT_SEGMENT_FILTER_OPTIONS,
  applySegmentFilterPredictions,
  refineLiveSegmentStartsByShortPrefixRestart,
  refineLiveSegmentEndsBySpeechReset,
  loadEdgeTrimAdvisorModel,
  loadSegmentFilterModel,
  runSegmentFilterPipeline,
  segmentFilterAssetNames,
} from '../../lib/songDetection/segmentFilter.js';

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_WORKLET_CHUNK_FRAMES = 2048;
const DEFAULT_HOP_SEC = 0.5;
const DEFAULT_LIVE_FINALIZE_DELAY_SEC = 180;
const DEFAULT_REPORT_STEP_SEC = 5;
const DEFAULT_MIN_SEGMENT_DURATION_SEC = 90;
const LIVE_SEGMENT_FILTER_KEEP_THRESHOLD = 0.35;
const LIVE_FINAL_SEGMENT_FILTER_KEEP_THRESHOLD = 0.9;
const DEFAULT_LIVE_START_EDGE_TRIM_ENABLED = true;
const DEFAULT_LIVE_START_EDGE_TRIM_MODE = 'bidirectional';
const DEFAULT_LIVE_START_EDGE_TRIM_SCALE = 0.75;
const DEFAULT_LIVE_START_EDGE_TRIM_MIN_ABS_SEC = 2;
const LIVE_LARGE_END_TRIM_THRESHOLD_SEC = 30;
const LIVE_LARGE_END_TRIM_SCALE = 1.6;
const LIVE_ANALYSIS_METHODS = Object.freeze({
  AED_CACHE_60S: 'aed-cache-60s',
  PCM_ROLLOVER_30MIN: 'pcm-rollover-30min',
});
const DEFAULT_LIVE_ANALYSIS_METHOD = LIVE_ANALYSIS_METHODS.AED_CACHE_60S;
const LIVE_FILTER_DROP_PROTECTION = Object.freeze({
  minKeepProbability: 0.86,
  minDurationSec: 90,
  minConfidence: 0.65,
  minTemporalMean: 0.5,
  minSingingMean: 0.12,
  minSingingP90: 0.55,
  minSingingRatioMean: 0.08,
  maxLowSingingHighMusicRatio: 0.65,
});

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const values = [];
    while (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      values.push(argv[index + 1]);
      index += 1;
    }
    args[key] = values.length > 1 ? values : values[0] ?? true;
  }
  return args;
}

function parseTimedRanges(value, label = 'range') {
  if (value === undefined || value === null || value === '') return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(':').map((part) => Number(part.trim()));
      if (parts.length !== 2 || !parts.every(Number.isFinite)) {
        throw new Error(`Invalid ${label} item "${item}". Expected atSec:durationSec.`);
      }
      return {
        atSec: Math.max(0, parts[0]),
        durationSec: Math.max(0, parts[1]),
      };
    })
    .filter((item) => item.durationSec > 0)
    .sort((a, b) => a.atSec - b.atSec);
}

function parseStallInsertions(value) {
  return parseTimedRanges(value, '--stall-insertions');
}

function parseSnapshotUnavailableInsertions(value) {
  return parseTimedRanges(value, '--snapshot-unavailable-insertions');
}

function parseIgnoreRanges(value) {
  if (value === undefined || value === null || value === '') return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(':').map((part) => Number(part.trim()));
      if (parts.length !== 2 || !parts.every(Number.isFinite)) {
        throw new Error(`Invalid --ignore-ranges item "${item}". Expected startSec:endSec.`);
      }
      const startSec = Math.max(0, parts[0]);
      const endSec = Math.max(startSec, parts[1]);
      return { startSec, endSec };
    })
    .filter((item) => item.endSec > item.startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

function toSeconds(value) {
  if (typeof value === 'number') return Math.max(0, value);
  const text = String(value || '').trim();
  if (!text) return 0;
  const parts = text.split(':').map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2 && parts.every(Number.isFinite)) return (parts[0] * 60) + parts[1];
  return Math.max(0, Number(text) || 0);
}

function roundNumber(value, digits = 3) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function normalizeLiveAnalysisMethod(value, fallback = DEFAULT_LIVE_ANALYSIS_METHOD) {
  const key = String(value || '').trim().toLowerCase();
  if (key === LIVE_ANALYSIS_METHODS.AED_CACHE_60S) return LIVE_ANALYSIS_METHODS.AED_CACHE_60S;
  if (key === LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN) return LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN;
  return fallback;
}

function resolveLiveFrameBuilderConfig(method) {
  const liveAnalysisMethod = normalizeLiveAnalysisMethod(method);
  if (liveAnalysisMethod === LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN) {
    return { liveAnalysisMethod, chunkSec: 30 * 60, overlapSec: 120 };
  }
  return { liveAnalysisMethod: LIVE_ANALYSIS_METHODS.AED_CACHE_60S, chunkSec: 60, overlapSec: 60 };
}

function formatTime(seconds) {
  const sec = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function loadManual(path) {
  if (!path) return [];
  const text = await readFile(path, 'utf8');
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        startSec: toSeconds(parts[0]),
        endSec: toSeconds(parts[1]),
        title: parts.slice(2).join(' '),
      };
    })
    .filter((segment) => segment.endSec > segment.startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

function labelsFromSegments(times, segments) {
  return times.map((time) => segments.some((segment) => time >= segment.startSec && time < segment.endSec) ? 1 : 0);
}

function metrics(pred, actual) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let index = 0; index < pred.length; index += 1) {
    if (pred[index] && actual[index]) tp += 1;
    else if (pred[index] && !actual[index]) fp += 1;
    else if (!pred[index] && actual[index]) fn += 1;
    else tn += 1;
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
  return { precision, recall, f1, tp, fp, fn, tn };
}

function overlapSeconds(a, b) {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

function overlapWithRanges(segment, ranges) {
  return (Array.isArray(ranges) ? ranges : [])
    .reduce((total, range) => total + overlapSeconds(segment, range), 0);
}

function segmentDurationSec(segment) {
  return Math.max(0, Number(segment?.endSec) - Number(segment?.startSec));
}

function segmentMatches(predicted, manual, ignoredRanges = []) {
  return manual.map((target) => {
    let best = null;
    for (const segment of predicted) {
      const overlap = overlapSeconds(segment, target);
      const ignoredOverlapSec = overlapWithRanges(segment, ignoredRanges);
      const effectivePredictedDurationSec = Math.max(1, segmentDurationSec(segment) - ignoredOverlapSec);
      if (!best || overlap > best.overlapSec) {
        best = {
          overlapSec: overlap,
          predicted: segment,
          recallRatio: overlap / Math.max(1, target.endSec - target.startSec),
          predictedPrecisionRatio: overlap / effectivePredictedDurationSec,
          ignoredOverlapSec,
          effectivePredictedDurationSec,
          startDeltaSec: segment.startSec - target.startSec,
          endDeltaSec: segment.endSec - target.endSec,
        };
      }
    }
    return { manual: target, best };
  });
}

function summarizeRangeFeatures(frames, startSec, endSec) {
  return summarizeSegmentDiagnosticFeatures(frames, { startSec, endSec });
}

function overlappingManualSegments(segment, manualSegments) {
  return (Array.isArray(manualSegments) ? manualSegments : [])
    .map((manual) => ({
      manual,
      overlapSec: overlapSeconds(segment, manual),
      gapBeforeSec: Number(manual.startSec) - Number(segment.endSec),
      gapAfterSec: Number(segment.startSec) - Number(manual.endSec),
    }))
    .filter((item) => item.overlapSec > 0);
}

function classifyMatchOutlier(match, { frames, manualSegments, minSegmentDurationSec }) {
  const outliers = [];
  const manual = match?.manual || {};
  const best = match?.best || null;
  const title = manual.title || manual.name || '';
  if (!best || !best.overlapSec) {
    const manualFeatures = summarizeSegmentDiagnosticFeatures(frames, manual);
    outliers.push({
      type: manualFeatures.acapellaCandidate ? 'acapella-risk' : 'missed-song',
      manual,
      title,
      manualFeatures,
    });
    return outliers;
  }
  const recall = Number(best.recallRatio) || 0;
  const precision = Number(best.predictedPrecisionRatio) || 0;
  const startDeltaSec = Number(best.startDeltaSec) || 0;
  const endDeltaSec = Number(best.endDeltaSec) || 0;
  const predicted = best.predicted || {};
  const manualFeatures = summarizeSegmentDiagnosticFeatures(frames, manual);
  const predictedFeatures = summarizeSegmentDiagnosticFeatures(frames, predicted);
  const base = {
    manual,
    predicted,
    title,
    recall: roundNumber(recall, 4),
    precision: roundNumber(precision, 4),
    manualFeatures,
    predictedFeatures,
  };

  if (recall < 0.75) {
    outliers.push({
      ...base,
      type: manualFeatures.acapellaCandidate ? 'acapella-risk' : 'low-recall',
    });
  }

  if (precision < 0.85) {
    const overlaps = overlappingManualSegments(predicted, manualSegments);
    const closeSongMerge = overlaps.length >= 2
      && overlaps.some((left, index) => overlaps.slice(index + 1).some((right) => {
        const gapSec = Math.max(0, Math.max(left.manual.startSec, right.manual.startSec) - Math.min(left.manual.endSec, right.manual.endSec));
        return gapSec <= 45;
      }));
    if (closeSongMerge) {
      outliers.push({
        ...base,
        type: 'merged-close-songs',
        overlapCount: overlaps.length,
      });
    }
  }

  if (startDeltaSec < -30) {
    const extensionFeatures = summarizeRangeFeatures(frames, predicted.startSec, manual.startSec);
    // This is only a weak burst/rebound diagnostic. It is not music-fragment
    // repetition detection; that needs an embedding/model feature.
    const type = (
      extensionFeatures.postResetRebound >= 0.35
      || extensionFeatures.musicOnlyScore >= 0.35
    )
      ? 'early-start-rehearsal'
      : 'early-start';
    outliers.push({
      ...base,
      type,
      deltaSec: roundNumber(startDeltaSec, 3),
      extensionFeatures,
    });
  }
  if (startDeltaSec > 30) {
    outliers.push({
      ...base,
      type: 'late-start',
      deltaSec: roundNumber(startDeltaSec, 3),
    });
  }
  if (endDeltaSec < -45) {
    const missingTailFeatures = summarizeRangeFeatures(frames, predicted.endSec, manual.endSec);
    const type = (
      missingTailFeatures.tailSpeechWithMusic >= 0.12
      || (missingTailFeatures.stats?.speech?.mean >= 0.4 && missingTailFeatures.stats?.music?.mean >= 0.65)
    )
      ? 'early-end-speech-like'
      : 'early-end';
    outliers.push({
      ...base,
      type,
      deltaSec: roundNumber(endDeltaSec, 3),
      missingTailFeatures,
    });
  }
  if (endDeltaSec > 45) {
    const extensionFeatures = summarizeRangeFeatures(frames, manual.endSec, predicted.endSec);
    const type = (
      extensionFeatures.musicOnlyScore >= 0.35
      || extensionFeatures.tailSpeechWithMusic >= 0.12
      || extensionFeatures.postResetRebound >= 0.35
    )
      ? 'late-end-bgm'
      : 'late-end';
    outliers.push({
      ...base,
      type,
      deltaSec: roundNumber(endDeltaSec, 3),
      extensionFeatures,
    });
  }
  return outliers;
}

function classifyPredictionOutliers(predicted, manual, frames, ignoredRanges = []) {
  const outliers = [];
  for (const segment of Array.isArray(predicted) ? predicted : []) {
    let bestOverlapSec = 0;
    for (const target of Array.isArray(manual) ? manual : []) {
      bestOverlapSec = Math.max(bestOverlapSec, overlapSeconds(segment, target));
    }
    const durationSec = Math.max(0, Number(segment.endSec) - Number(segment.startSec));
    const ignoredOverlapSec = overlapWithRanges(segment, ignoredRanges);
    const extraSec = Math.max(0, durationSec - bestOverlapSec - ignoredOverlapSec);
    if ((bestOverlapSec <= 0 && extraSec >= 60) || extraSec > 60) {
      const segmentFeatures = summarizeSegmentDiagnosticFeatures(frames, segment);
      const type = segmentFeatures.repetitionScore >= 0.66
        ? 'false-positive-repetitive-bgm'
        : (segmentFeatures.musicOnlyScore >= 0.35 ? 'false-positive-bgm' : 'long-false-positive');
      outliers.push({
        type,
        segment,
        durationSec: roundNumber(durationSec, 3),
        overlapSec: roundNumber(bestOverlapSec, 3),
        ignoredOverlapSec: roundNumber(ignoredOverlapSec, 3),
        extraSec: roundNumber(extraSec, 3),
        segmentFeatures,
      });
    }
  }
  return outliers;
}

function classifySkippedShortManualSegments(segments, minSegmentDurationSec, frames) {
  return (Array.isArray(segments) ? segments : []).map((manual) => ({
    type: 'missed-short-song',
    manual,
    title: manual.title || manual.name || '',
    durationSec: roundNumber(Number(manual.durationSec) || (Number(manual.endSec) - Number(manual.startSec)), 3),
    minSegmentDurationSec,
    manualFeatures: summarizeSegmentDiagnosticFeatures(frames, manual),
  }));
}

function modelCoverageForManual(frames, manual) {
  const targetStart = Number(manual?.startSec) || 0;
  const targetEnd = Number(manual?.endSec) || 0;
  const targetFrames = (Array.isArray(frames) ? frames : []).filter((frame) => {
    const timeSec = Number(frame?.timeSec);
    return Number.isFinite(timeSec) && timeSec >= targetStart && timeSec <= targetEnd;
  });
  if (!targetFrames.length) return 0;
  const positive = targetFrames.filter((frame) => {
    const threshold = Number(frame.temporalHeadThreshold) || 0.75;
    return Number(frame.temporalHeadProbability ?? frame.songProbability) >= threshold;
  }).length;
  return positive / targetFrames.length;
}

function classifyModelDropOutliers(matches, frames) {
  const outliers = [];
  for (const match of Array.isArray(matches) ? matches : []) {
    const bestRecall = Number(match?.best?.recallRatio) || 0;
    if (bestRecall >= 0.75) continue;
    const modelCoverage = modelCoverageForManual(frames, match.manual);
    if (modelCoverage >= 0.75) {
      outliers.push({
        type: 'model-drop',
        manual: match.manual,
        predicted: match.best?.predicted || null,
        recall: roundNumber(bestRecall, 4),
        modelCoverage: roundNumber(modelCoverage, 4),
      });
    }
  }
  return outliers;
}

function clipManualSegmentsToRange(segments, startSec, endSec) {
  const start = Math.max(0, Number(startSec) || 0);
  const hasEnd = Number.isFinite(Number(endSec));
  const end = hasEnd ? Math.max(start, Number(endSec)) : Infinity;
  return segments
    .map((segment) => ({
      ...segment,
      startSec: Math.max(start, Number(segment.startSec) || 0),
      endSec: Math.min(end, Number(segment.endSec) || 0),
    }))
    .filter((segment) => segment.endSec > segment.startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

function splitManualSegmentsByDuration(segments, minDurationSec) {
  const minDuration = Math.max(0, Number(minDurationSec) || 0);
  const kept = [];
  const skippedShort = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const durationSec = Math.max(0, Number(segment.endSec) - Number(segment.startSec));
    if (durationSec + 1e-6 < minDuration) {
      skippedShort.push({ ...segment, durationSec: roundNumber(durationSec, 3) });
    } else {
      kept.push(segment);
    }
  }
  return { kept, skippedShort };
}

function mergeEvaluationIgnoreRanges(ranges) {
  const sorted = (Array.isArray(ranges) ? ranges : [])
    .map((range) => ({
      ...range,
      startSec: Math.max(0, Number(range?.startSec) || 0),
      endSec: Math.max(0, Number(range?.endSec) || 0),
    }))
    .filter((range) => range.endSec > range.startSec)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const output = [];
  for (const range of sorted) {
    const previous = output[output.length - 1];
    if (!previous || range.startSec > previous.endSec + 1e-6) {
      output.push(range);
      continue;
    }
    previous.endSec = Math.max(previous.endSec, range.endSec);
    previous.reason = [previous.reason, range.reason].filter(Boolean).join('|') || null;
  }
  return output;
}

function computeNextIntegerSecond(currentTimeSec) {
  const current = Math.max(0, Number(currentTimeSec) || 0);
  const rounded = Math.round(current);
  if (Math.abs(current - rounded) <= 0.02) return rounded;
  return Math.ceil(current);
}

function normalizeLiveAnalysisCacheFrame(currentTimeSec, analysis) {
  if (!analysis || !analysis.ready) return null;
  return {
    ready: true,
    timeSec: roundNumber(currentTimeSec, 3),
    songProbability: roundNumber(Number(analysis.songProbability) || 0, 4),
    baseSongProbability: roundNumber(Number(analysis.baseSongProbability) || 0, 4),
    temporalHeadReady: Boolean(analysis.temporalHeadReady),
    temporalHeadProbability: Number.isFinite(Number(analysis.temporalHeadProbability))
      ? roundNumber(Number(analysis.temporalHeadProbability), 4)
      : null,
    temporalHeadThreshold: Number.isFinite(Number(analysis.temporalHeadThreshold))
      ? roundNumber(Number(analysis.temporalHeadThreshold), 4)
      : null,
    temporalHeadHistoryWindows: Number(analysis.temporalHeadHistoryWindows) || 0,
    speechProbability: roundNumber(Number(analysis.speechProbability ?? analysis.speechMean) || 0, 4),
    singingProbability: roundNumber(Number(analysis.singingProbability ?? analysis.singingMean) || 0, 4),
    musicProbability: roundNumber(Number(analysis.musicProbability ?? analysis.musicMean) || 0, 4),
    speechMean: roundNumber(Number(analysis.speechMean) || 0, 4),
    singingMean: roundNumber(Number(analysis.singingMean) || 0, 4),
    musicMean: roundNumber(Number(analysis.musicMean) || 0, 4),
    speechRatio: roundNumber(Number(analysis.speechRatio) || 0, 4),
    singingRatio: roundNumber(Number(analysis.singingRatio) || 0, 4),
    musicRatio: roundNumber(Number(analysis.musicRatio) || 0, 4),
    audioRms: roundNumber(Number(analysis.audioRms) || 0, 6),
    audioPeak: roundNumber(Number(analysis.audioPeak) || 0, 6),
    spectralCentroid: roundNumber(Number(analysis.spectralCentroid) || 0, 4),
    spectralFlatness: roundNumber(Number(analysis.spectralFlatness) || 0, 4),
    spectralFlux: roundNumber(Number(analysis.spectralFlux) || 0, 4),
    lowEnergyRatio: roundNumber(Number(analysis.lowEnergyRatio) || 0, 4),
    midEnergyRatio: roundNumber(Number(analysis.midEnergyRatio) || 0, 4),
    highEnergyRatio: roundNumber(Number(analysis.highEnergyRatio) || 0, 4),
    analyzedAudioSec: roundNumber(Number(analysis.analyzedAudioSec) || 0, 3),
    detectorVersion: analysis.detectorVersion || null,
  };
}

function uniqueSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .slice()
    .sort((a, b) => Number(a.startSec) - Number(b.startSec) || Number(a.endSec) - Number(b.endSec))
    .filter((segment, index, list) => list.findIndex((candidate) => (
      Math.abs(Number(candidate.startSec) - Number(segment.startSec)) < 0.001
      && Math.abs(Number(candidate.endSec) - Number(segment.endSec)) < 0.001
    )) === index);
}

function summarizeLiveSegmentEvidence(frames, segment) {
  const startSec = Number(segment?.startSec);
  const endSec = Number(segment?.endSec);
  const segmentFrames = (Array.isArray(frames) ? frames : []).filter((frame) => {
    const timeSec = Number(frame?.timeSec);
    return Number.isFinite(timeSec) && timeSec >= startSec && timeSec <= endSec;
  });
  if (!segmentFrames.length) {
    return {
      frameCount: 0,
      temporalMean: 0,
      singingMean: 0,
      singingP90: 0,
      singingRatioMean: 0,
      lowSingingHighMusicRatio: 1,
    };
  }

  const values = (fieldName) => segmentFrames
    .map((frame) => Number(frame?.[fieldName]))
    .filter(Number.isFinite);
  const mean = (fieldName) => {
    const list = values(fieldName);
    if (!list.length) return 0;
    return list.reduce((sum, value) => sum + value, 0) / list.length;
  };
  const percentile = (fieldName, ratio) => {
    const list = values(fieldName).sort((a, b) => a - b);
    if (!list.length) return 0;
    const index = Math.min(list.length - 1, Math.max(0, Math.floor((list.length - 1) * ratio)));
    return list[index];
  };
  const lowSingingHighMusicCount = segmentFrames.filter((frame) => {
    const music = Number(frame?.musicProbability) || 0;
    const singing = Number(frame?.singingProbability) || 0;
    const speech = Number(frame?.speechProbability) || 0;
    return music >= 0.7 && singing <= 0.05 && speech <= 0.2;
  }).length;

  return {
    frameCount: segmentFrames.length,
    temporalMean: mean('temporalHeadProbability'),
    singingMean: mean('singingProbability'),
    singingP90: percentile('singingProbability', 0.9),
    singingRatioMean: mean('singingRatio'),
    lowSingingHighMusicRatio: lowSingingHighMusicCount / segmentFrames.length,
  };
}

function protectLiveFilterDrops(originalSegments, filteredResult, frames) {
  const sourceSegments = Array.isArray(originalSegments) ? originalSegments : [];
  const result = filteredResult || { segments: [], adjustments: [], changed: false };
  const adjustments = Array.isArray(result.adjustments) ? result.adjustments.map((item) => ({ ...item })) : [];
  const keptSegments = Array.isArray(result.segments) ? result.segments.slice() : [];
  let restored = false;

  for (let index = 0; index < adjustments.length; index += 1) {
    const adjustment = adjustments[index];
    if (adjustment?.action !== 'drop') continue;
    const sourceIndex = Number.isInteger(adjustment.index) ? adjustment.index : index;
    const segment = sourceSegments[sourceIndex];
    if (!segment) continue;
    const keepProbability = Number(adjustment.keepProbability);
    if (Number.isFinite(keepProbability) && keepProbability < LIVE_FILTER_DROP_PROTECTION.minKeepProbability) continue;
    const durationSec = Number(segment.endSec) - Number(segment.startSec);
    const confidence = Number(segment.confidence) || 0;
    if (durationSec < LIVE_FILTER_DROP_PROTECTION.minDurationSec) continue;
    if (confidence < LIVE_FILTER_DROP_PROTECTION.minConfidence) continue;

    const evidence = summarizeLiveSegmentEvidence(frames, segment);
    const hasTemporalEvidence = evidence.temporalMean >= LIVE_FILTER_DROP_PROTECTION.minTemporalMean;
    const hasVocalEvidence = evidence.singingMean >= LIVE_FILTER_DROP_PROTECTION.minSingingMean
      || evidence.singingP90 >= LIVE_FILTER_DROP_PROTECTION.minSingingP90
      || evidence.singingRatioMean >= LIVE_FILTER_DROP_PROTECTION.minSingingRatioMean;
    const looksMusicOnly = evidence.lowSingingHighMusicRatio >= LIVE_FILTER_DROP_PROTECTION.maxLowSingingHighMusicRatio;
    if (!hasTemporalEvidence || !hasVocalEvidence || looksMusicOnly) continue;

    const restoredSegment = { ...segment, provisional: false };
    keptSegments.push(restoredSegment);
    adjustments[index] = {
      ...adjustment,
      action: 'keep-live-protected',
      segment: restoredSegment,
      evidence: {
        frameCount: evidence.frameCount,
        temporalMean: roundNumber(evidence.temporalMean, 4),
        singingMean: roundNumber(evidence.singingMean, 4),
        singingP90: roundNumber(evidence.singingP90, 4),
        singingRatioMean: roundNumber(evidence.singingRatioMean, 4),
        lowSingingHighMusicRatio: roundNumber(evidence.lowSingingHighMusicRatio, 4),
      },
    };
    restored = true;
  }

  if (!restored) return result;
  return {
    ...result,
    segments: uniqueSegments(keptSegments),
    adjustments,
    changed: adjustments.some((item) => item.action === 'drop' || item.action === 'trim'),
  };
}

function mergeSegments(left, right) {
  return uniqueSegments([...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]);
}

function clipSegmentsToTime(segments, nowSec) {
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => Number(segment.startSec) < nowSec)
    .map((segment) => ({
      ...segment,
      endSec: Math.min(Number(segment.endSec) || 0, nowSec),
    }))
    .filter((segment) => segment.endSec > segment.startSec);
}

function selectNewFinalizationCandidates(finalizedState, finalCandidates) {
  const maxSourceEndSec = Number(finalizedState.maxSourceEndSec);
  const hasMaxSourceEnd = finalizedState.maxSourceEndSec !== null && Number.isFinite(maxSourceEndSec);
  return uniqueSegments(finalCandidates)
    .filter((segment) => {
      const startSec = Number(segment.startSec);
      const endSec = Number(segment.endSec);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return false;
      if (!hasMaxSourceEnd) return true;
      if (endSec <= maxSourceEndSec + 0.25) return false;
      return startSec >= maxSourceEndSec - 1;
    });
}

function updateFinalizedSourceEnd(finalizedState, sourceSegments) {
  if (!sourceSegments.length) return;
  finalizedState.maxSourceEndSec = Math.max(
    Number(finalizedState.maxSourceEndSec) || 0,
    ...sourceSegments.map((segment) => Number(segment.endSec) || 0)
  );
}

async function installFileFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    const text = String(url);
    if (text.startsWith('file:')) {
      const data = await readFile(fileURLToPath(text));
      return new Response(data, { status: 200 });
    }
    return originalFetch(url, ...rest);
  };
}

async function loadOrtRuntime() {
  await installFileFetch();
  const ortModule = await import('../../lib/vendor/onnxruntime/ort.min.js');
  globalThis.ort = ortModule.default || ortModule;
  return globalThis.ort;
}

function toFileUrl(path) {
  return pathToFileURL(resolve(path)).href;
}

function segmentFilterProfileForLiveMethod(liveMethod) {
  return liveMethod === LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN
    ? 'live-pcm30'
    : 'live-realtime-aed60';
}

async function loadFinalizerRuntimes({
  enabled,
  modelDir = 'models/fireredvad/aed',
  assetProfile = 'default',
}) {
  if (!enabled) return null;
  const ort = globalThis.ort;
  if (!ort?.InferenceSession || !ort?.Tensor) return null;
  const profileNames = segmentFilterAssetNames(assetProfile);
  const defaultNames = segmentFilterAssetNames('default');
  const chooseAssetPair = (profileModel, profileMeta, defaultModel, defaultMeta) => (
    assetProfile !== 'default'
      && existsSync(resolve(modelDir, profileModel))
      && existsSync(resolve(modelDir, profileMeta))
      ? [profileModel, profileMeta]
      : [defaultModel, defaultMeta]
  );
  const [segmentFilterModelName, segmentFilterMetaName] = chooseAssetPair(
    profileNames.segmentFilterModel,
    profileNames.segmentFilterMeta,
    defaultNames.segmentFilterModel,
    defaultNames.segmentFilterMeta
  );
  const [edgeTrimModelName, edgeTrimMetaName] = chooseAssetPair(
    profileNames.edgeTrimAdvisorModel,
    profileNames.edgeTrimAdvisorMeta,
    defaultNames.edgeTrimAdvisorModel,
    defaultNames.edgeTrimAdvisorMeta
  );
  const segmentFilterProfileUsed = segmentFilterModelName === profileNames.segmentFilterModel
    ? assetProfile
    : 'default';
  const edgeTrimProfileUsed = edgeTrimModelName === profileNames.edgeTrimAdvisorModel
    ? assetProfile
    : 'default';
  const modelPath = (name) => toFileUrl(resolve(modelDir, name));
  try {
    const [segmentFilter, edgeTrimAdvisor] = await Promise.all([
      loadSegmentFilterModel({
        ort,
        assetProfile: segmentFilterProfileUsed,
        modelUrl: modelPath(segmentFilterModelName),
        metaUrl: modelPath(segmentFilterMetaName),
        requireAssetProfile: requireProfileAssets,
        executionProviders: ['wasm'],
      }),
      loadEdgeTrimAdvisorModel({
        ort,
        assetProfile: edgeTrimProfileUsed,
        modelUrl: modelPath(edgeTrimModelName),
        metaUrl: modelPath(edgeTrimMetaName),
        requireAssetProfile: requireProfileAssets,
        executionProviders: ['wasm'],
      }).catch(() => null),
    ]);
    return { segmentFilter, edgeTrimAdvisor };
  } catch (error) {
    console.warn('[pcm-live-sim] finalizer unavailable; using heuristic final segments.', error);
    return null;
  }
}

function assertRequiredProfileAssets({ enabled, required, requestedProfile, runtimes }) {
  if (!enabled || !required || requestedProfile === 'default') return;
  const segmentProfileUsed = runtimes?.segmentFilter?.assetProfile || null;
  const edgeTrimProfileUsed = runtimes?.edgeTrimAdvisor?.assetProfile || null;
  const missing = [];
  if (segmentProfileUsed !== requestedProfile) {
    missing.push(`segment_filter used ${segmentProfileUsed || 'none'}`);
  }
  if (edgeTrimProfileUsed !== requestedProfile) {
    missing.push(`edge_trim_advisor used ${edgeTrimProfileUsed || 'none'}`);
  }
  if (!missing.length) return;
  throw new Error(
    `Required segment filter profile assets were not loaded for "${requestedProfile}": `
    + `${missing.join(', ')}. Check --segment-filter-model-dir or disable --require-profile-assets.`
  );
}

function shouldDisableLiveEdgeTrim(edgeMeta = {}) {
  return edgeMeta.disableLiveEdgeTrim === true;
}

function shouldEnableLiveEndTrimEvidenceGuard(edgeMeta = {}) {
  return edgeMeta.enableLiveEndTrimEvidenceGuard === true;
}

async function applyFinalizer(runtimes, segments, frames, smoothing, {
  currentTimeSec,
  finalCutoffSec,
  minSegmentDurationSec,
  previousFinalEndSec = null,
  finalizeAll = false,
  skipSegmentFilter = false,
  disableEdgeTrim = false,
  speechResetEndRefinement = true,
}) {
  const normalized = uniqueSegments(segments);
  if (skipSegmentFilter || !runtimes?.segmentFilter || !normalized.length) {
    return { segments: normalized, adjustments: [], applied: false, runtimeInfo: null };
  }

  const firstFrame = frames[0] || null;
  const predictionEndSec = finalizeAll
    ? Math.max(
        Number(currentTimeSec) || 0,
        Number(frames[frames.length - 1]?.timeSec) || 0,
        finalCutoffSec
      )
    : finalCutoffSec;
  const context = {
    trackerSegments: smoothing?.trackerSegments || [],
    modelRunSegments: smoothing?.modelRunSegments || [],
    fallbackSegments: smoothing?.fallbackSegments || [],
    selectedModelFallbackSegments: smoothing?.selectedModelFallbackSegments || [],
    endSec: predictionEndSec,
  };
  const edgeMeta = runtimes?.edgeTrimAdvisor?.meta || {};
  const edgeTrimDisabledByModel = shouldDisableLiveEdgeTrim(edgeMeta);
  const endTrimEvidenceGuardEnabled = shouldEnableLiveEndTrimEvidenceGuard(edgeMeta);
  const activeRuntimes = finalizeAll && !disableEdgeTrim && !edgeTrimDisabledByModel
    ? runtimes
    : { segmentFilter: runtimes.segmentFilter, edgeTrimAdvisor: null };
  const resolveLiveFinalKeepThreshold = (segmentMeta = {}) => {
    const profileThreshold = Number(segmentMeta.liveFinalKeepThreshold);
    if (Number.isFinite(profileThreshold)) return Math.max(0.01, Math.min(0.99, profileThreshold));
    return Math.max(
      LIVE_FINAL_SEGMENT_FILTER_KEEP_THRESHOLD,
      Number(segmentMeta.keepThreshold) || DEFAULT_SEGMENT_FILTER_OPTIONS.keepThreshold
    );
  };
  const options = {
    ...DEFAULT_SEGMENT_FILTER_OPTIONS,
    keepThreshold: finalizeAll
      ? resolveLiveFinalKeepThreshold(runtimes.segmentFilter.meta || {})
      : LIVE_SEGMENT_FILTER_KEEP_THRESHOLD,
    minSegmentDurationSec,
    startSec: Number.isFinite(Number(previousFinalEndSec))
      ? Number(previousFinalEndSec)
      : (Number.isFinite(Number(firstFrame?.timeSec)) ? Number(firstFrame.timeSec) : 0),
    endSec: finalCutoffSec,
    allowStartTrim: liveStartEdgeTrimEnabled,
    startTrimMode: DEFAULT_LIVE_START_EDGE_TRIM_MODE,
    startTrimScale: liveStartEdgeTrimScale,
    startTrimMinAbsSec: liveStartEdgeTrimMinAbsSec,
    startTrimEvidenceFrames: frames,
    startTrimEvidenceMinFrames: 3,
    negativeStartTrimBoundaryScan: liveFrameBuilderConfig.liveAnalysisMethod === LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN,
    endTrimEvidenceFrames: endTrimEvidenceGuardEnabled ? frames : [],
    endTrimEvidenceGuard: endTrimEvidenceGuardEnabled,
    endTrimEvidenceMinFrames: 4,
    largeEndTrimThresholdSec: LIVE_LARGE_END_TRIM_THRESHOLD_SEC,
    largeEndTrimScale: LIVE_LARGE_END_TRIM_SCALE,
  };
  const predictions = await runSegmentFilterPipeline(activeRuntimes, normalized, frames, context, options);
  const filtered = protectLiveFilterDrops(
    normalized,
    applySegmentFilterPredictions(normalized, predictions, options),
    frames
  );
  const speechResetRefined = finalizeAll && speechResetEndRefinement
    ? refineLiveSegmentEndsBySpeechReset(filtered.segments, frames, { minSegmentDurationSec })
    : { segments: filtered.segments, adjustments: [], changed: false };
  const protectedStartSecs = (filtered.adjustments || [])
    .filter((adjustment) => adjustment?.startTrimEvidence?.boundaryScan)
    .map((adjustment) => Number(adjustment?.segment?.startSec))
    .filter(Number.isFinite);
  const shortPrefixRefined = finalizeAll && liveFrameBuilderConfig.liveAnalysisMethod === LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN
    ? refineLiveSegmentStartsByShortPrefixRestart(speechResetRefined.segments, frames, {
      minSegmentDurationSec,
      protectedStartSecs,
    })
    : { segments: speechResetRefined.segments, adjustments: [], changed: false };
  return {
    segments: uniqueSegments(shortPrefixRefined.segments || speechResetRefined.segments || filtered.segments || []),
    adjustments: [
      ...(filtered.adjustments || []),
      ...(speechResetRefined.adjustments || []),
      ...(shortPrefixRefined.adjustments || []),
    ],
    applied: true,
    runtimeInfo: {
      segmentFilterLoaded: Boolean(runtimes.segmentFilter),
      edgeTrimAdvisorLoaded: Boolean(activeRuntimes.edgeTrimAdvisor),
      liveEdgeTrimDisabledByModel: edgeTrimDisabledByModel,
      liveEndTrimEvidenceGuardEnabled: endTrimEvidenceGuardEnabled,
      keepThreshold: options.keepThreshold,
      liveFinalKeepThreshold: finalizeAll ? options.keepThreshold : null,
      startEdgeTrimEnabled: liveStartEdgeTrimEnabled,
      startEdgeTrimScale: liveStartEdgeTrimScale,
      startEdgeTrimMinAbsSec: liveStartEdgeTrimMinAbsSec,
      startEdgeTrimEvidenceGuard: true,
      speechResetEndRefinementEnabled: finalizeAll && speechResetEndRefinement,
      speechResetEndRefinementChanged: Boolean(speechResetRefined.changed),
      shortPrefixRestartStartRefinementChanged: Boolean(shortPrefixRefined.changed),
    },
  };
}

function float32ArrayFromBuffer(buffer) {
  const count = Math.floor(buffer.length / 4);
  const output = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    output[index] = buffer.readFloatLE(index * 4);
  }
  return output;
}

async function streamFfmpegPcm({
  ffmpeg,
  audio,
  sampleRate,
  startSec,
  endSec,
  onSamples,
}) {
  const ffmpegArgs = ['-hide_banner', '-loglevel', 'error'];
  if (startSec > 0) ffmpegArgs.push('-ss', String(startSec));
  ffmpegArgs.push('-i', audio, '-vn', '-ac', '1', '-ar', String(sampleRate));
  if (Number.isFinite(endSec) && endSec > startSec) {
    ffmpegArgs.push('-t', String(endSec - startSec));
  }
  ffmpegArgs.push('-f', 'f32le', 'pipe:1');

  const child = spawn(ffmpeg, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitPromise = new Promise((resolveExit) => {
    child.on('close', resolveExit);
  });

  let pending = Buffer.alloc(0);
  for await (const chunk of child.stdout) {
    const combined = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const usableBytes = combined.length - (combined.length % 4);
    if (usableBytes > 0) {
      await onSamples(float32ArrayFromBuffer(combined.subarray(0, usableBytes)));
    }
    pending = combined.subarray(usableBytes);
  }

  const exitCode = await exitPromise;
  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
}

const args = parseArgs(process.argv);
if (!args.audio || !args.out) {
  throw new Error('Usage: node tools/live/simulate_live_pcm_detection.mjs --audio <audio.m4a/mp4> --out <summary.json> [--manual <manual.txt>] [--live-method aed-cache-60s|pcm-rollover-30min] [--segment-filter-model-dir models/fireredvad/aed] [--segment-filter-profile default|live-pcm30|live-realtime-aed60] [--require-profile-assets] [--start-sec 0] [--end-sec 600] [--ffmpeg ffmpeg] [--sample-rate 48000] [--chunk-frames 2048] [--report-step-sec 5] [--lookahead-sec 180] [--min-segment-duration-sec 90] [--stall-insertions atSec:durationSec,...] [--gate-stalls] [--snapshot-unavailable-insertions atSec:durationSec,...] [--ignore-ranges startSec:endSec,...] [--no-segment-filter] [--enable-start-edge-trim] [--disable-start-edge-trim] [--start-edge-trim-scale 1] [--start-edge-trim-min-abs-sec 2] [--disable-speech-reset-end-refinement] [--include-frames] [--include-checkpoints]');
}

const audio = String(args.audio);
const out = String(args.out);
const manualPath = args.manual ? String(args.manual) : null;
const ffmpeg = String(args.ffmpeg || 'ffmpeg');
const sampleRate = Math.max(8000, Number(args['sample-rate']) || DEFAULT_SAMPLE_RATE);
const chunkFrames = Math.max(128, Number(args['chunk-frames']) || DEFAULT_WORKLET_CHUNK_FRAMES);
const startSec = toSeconds(args['start-sec'] || 0);
const endSec = args['end-sec'] === undefined ? null : toSeconds(args['end-sec']);
const reportStepSec = Math.max(DEFAULT_HOP_SEC, Number(args['report-step-sec']) || DEFAULT_REPORT_STEP_SEC);
const lookaheadSec = Math.max(0, Number(args['lookahead-sec']) || DEFAULT_LIVE_FINALIZE_DELAY_SEC);
const minSegmentDurationSec = Math.max(15, Number(args['min-segment-duration-sec']) || DEFAULT_MIN_SEGMENT_DURATION_SEC);
const includeFrames = Boolean(args['include-frames']);
const includeCheckpoints = Boolean(args['include-checkpoints']);
const segmentFilterEnabled = !Boolean(args['no-segment-filter']);
const liveStartEdgeTrimEnabled = Boolean(args['disable-start-edge-trim'])
  ? false
  : (Boolean(args['enable-start-edge-trim']) || DEFAULT_LIVE_START_EDGE_TRIM_ENABLED);
const liveStartEdgeTrimScale = Math.max(0, Number(args['start-edge-trim-scale']) || DEFAULT_LIVE_START_EDGE_TRIM_SCALE);
const liveStartEdgeTrimMinAbsSec = Math.max(0, Number(args['start-edge-trim-min-abs-sec']) || DEFAULT_LIVE_START_EDGE_TRIM_MIN_ABS_SEC);
const speechResetEndRefinement = !Boolean(args['disable-speech-reset-end-refinement']);
const segmentFilterModelDir = String(args['segment-filter-model-dir'] || 'models/fireredvad/aed');
const liveFrameBuilderConfig = resolveLiveFrameBuilderConfig(args['live-method']);
const segmentFilterAssetProfile = String(args['segment-filter-profile'] || segmentFilterProfileForLiveMethod(liveFrameBuilderConfig.liveAnalysisMethod));
const requireProfileAssets = Boolean(args['require-profile-assets']);
const stallInsertions = parseStallInsertions(args['stall-insertions']);
const gateStalls = Boolean(args['gate-stalls']);
const snapshotUnavailableInsertions = parseSnapshotUnavailableInsertions(args['snapshot-unavailable-insertions']);
const ignoreRanges = parseIgnoreRanges(args['ignore-ranges']);
const manual = await loadManual(manualPath);

await loadOrtRuntime();
const detector = new FireRedAedSongDetector({
  sourceSampleRate: sampleRate,
  chunkSec: liveFrameBuilderConfig.chunkSec,
  overlapSec: liveFrameBuilderConfig.overlapSec,
  liveAnalysisMethod: liveFrameBuilderConfig.liveAnalysisMethod,
});
await detector.initialize();
const finalizerRuntimes = await loadFinalizerRuntimes({
  enabled: segmentFilterEnabled,
  modelDir: segmentFilterModelDir,
  assetProfile: segmentFilterAssetProfile,
});
assertRequiredProfileAssets({
  enabled: segmentFilterEnabled,
  required: requireProfileAssets,
  requestedProfile: segmentFilterAssetProfile,
  runtimes: finalizerRuntimes,
});

const initialAnalysisStartOriginSec = computeNextIntegerSecond(startSec);
let activeAnalysisOriginSec = initialAnalysisStartOriginSec;
if (typeof detector.setTimeOffsetSec === 'function') {
  detector.setTimeOffsetSec(activeAnalysisOriginSec);
}
let sourceSampleCursor = Math.round(startSec * sampleRate);
let pushedAnalysisSamples = 0;
let nextStallInsertionIndex = 0;
let nextSnapshotUnavailableIndex = 0;
let activeSnapshotUnavailable = null;
let nextAnalyzeSec = activeAnalysisOriginSec;
let nextReportSec = activeAnalysisOriginSec + reportStepSec;
let lastProgressLogAt = Date.now();
const frames = [];
const checkpoints = [];
const finalizationBatches = [];
const completedSegments = [];
const completedAnalysisRanges = [];
let activeFrameStartIndex = 0;
let activeRangeOpen = true;
const stallDiagnostics = {
  insertedSec: 0,
  gatedSec: 0,
  ungatedSilenceSec: 0,
  count: 0,
};
const snapshotUnavailableDiagnostics = {
  insertedSec: 0,
  skippedSec: 0,
  count: 0,
  completedRangeCount: 0,
};
const finalizedState = {
  segments: [],
  adjustments: [],
  maxSourceEndSec: null,
  filterApplied: false,
};

function getSourceTimeSec() {
  return sourceSampleCursor / sampleRate;
}

function getAnalysisFeedEndSec() {
  return activeAnalysisOriginSec + (pushedAnalysisSamples / sampleRate);
}

function resetFinalizedState() {
  finalizedState.segments = [];
  finalizedState.adjustments = [];
  finalizedState.filterApplied = false;
  finalizedState.maxSourceEndSec = null;
}

function appendAnalysisFrames(analysisFrames) {
  for (const frame of Array.isArray(analysisFrames) ? analysisFrames : []) {
    const lastFrame = frames[frames.length - 1] || null;
    if (lastFrame && Math.abs(Number(lastFrame.timeSec) - Number(frame.timeSec)) < 0.05) {
      frames[frames.length - 1] = frame;
    } else {
      frames.push(frame);
    }
  }
}

function openActiveAnalysisRange(currentSec) {
  activeAnalysisOriginSec = computeNextIntegerSecond(currentSec);
  pushedAnalysisSamples = 0;
  nextAnalyzeSec = activeAnalysisOriginSec;
  nextReportSec = activeAnalysisOriginSec + reportStepSec;
  activeFrameStartIndex = frames.length;
  activeRangeOpen = true;
  resetFinalizedState();
  if (typeof detector.resetAnalysisState === 'function') detector.resetAnalysisState();
  if (typeof detector.setTimeOffsetSec === 'function') detector.setTimeOffsetSec(activeAnalysisOriginSec);
}

async function flushDetectorFramesIntoCache() {
  if (typeof detector.flushPendingFrames !== 'function') return [];
  const flushedFrames = await detector.flushPendingFrames();
  appendAnalysisFrames(flushedFrames);
  return flushedFrames;
}

async function closeActiveAnalysisRange(currentSec, reason = 'discontinuity') {
  if (!activeRangeOpen) return false;
  const flushedFrames = await flushDetectorFramesIntoCache();
  const lastFlushedFrame = flushedFrames[flushedFrames.length - 1] || null;
  const finalNowSec = Math.max(
    Number(currentSec) || 0,
    Number(lastFlushedFrame?.timeSec) || 0,
    Number(frames[frames.length - 1]?.timeSec) || 0,
    activeAnalysisOriginSec
  );
  await runLiveReport(finalNowSec, true, { skipSegmentFilter: true });
  const rangeSegments = uniqueSegments(finalizedState.segments);
  completedSegments.push(...rangeSegments);
  completedAnalysisRanges.push({
    reason,
    startSec: roundNumber(activeAnalysisOriginSec, 3),
    endSec: roundNumber(finalNowSec, 3),
    frameCount: Math.max(0, frames.length - activeFrameStartIndex),
    segmentCount: rangeSegments.length,
  });
  resetFinalizedState();
  activeFrameStartIndex = frames.length;
  activeRangeOpen = false;
  pushedAnalysisSamples = 0;
  if (typeof detector.resetAnalysisState === 'function') detector.resetAnalysisState();
  return true;
}

async function pushAnalysisChunk(chunk) {
  if (!chunk || !chunk.length) return;
  if (!activeRangeOpen) {
    openActiveAnalysisRange(getSourceTimeSec());
  }
  detector.pushAudioChunk(chunk);
  pushedAnalysisSamples += chunk.length;
  await analyzeUntil(getAnalysisFeedEndSec());
}

async function analyzeUntil(currentAbsSec) {
  while (nextAnalyzeSec <= currentAbsSec + 1e-6) {
    const analysis = await detector.analyze();
    const analysisFrames = Array.isArray(analysis?.frames) && analysis.frames.length
      ? analysis.frames
      : [normalizeLiveAnalysisCacheFrame(nextAnalyzeSec, analysis)].filter(Boolean);
    appendAnalysisFrames(analysisFrames);

    while (nextReportSec <= nextAnalyzeSec + 1e-6) {
      await runLiveReport(nextReportSec, false);
      nextReportSec += reportStepSec;
    }
    nextAnalyzeSec = roundNumber(nextAnalyzeSec + DEFAULT_HOP_SEC, 3);
  }
}

async function runLiveReport(nowSec, finalizeAll, { skipSegmentFilter = false } = {}) {
  const availableFrames = frames
    .slice(activeFrameStartIndex)
    .filter((frame) => Number(frame.timeSec) <= nowSec);
  if (availableFrames.length < 20 || !availableFrames.some((frame) => frame.temporalHeadReady)) {
    if (includeCheckpoints) {
      checkpoints.push({
        nowSec: roundNumber(nowSec, 3),
        frameCount: availableFrames.length,
        skipped: 'not-enough-temporal-head-frames',
      });
    }
    return;
  }

  if (finalizeAll) {
    // Match offscreen.js: streamed checkpoints are UI-stable, but Stop should
    // rebuild final output from the full frame cache instead of frozen segments.
    resetFinalizedState();
  }

  const smoothing = smoothFireRedAnalyses(availableFrames, nowSec, {
    startSec: activeAnalysisOriginSec,
    minSegmentDurationSec,
    smoothingProfile: segmentFilterAssetProfile,
  });
  const finalCutoffSec = finalizeAll ? nowSec : Math.max(0, nowSec - lookaheadSec);
  const finalCandidates = smoothing.segments
    .filter((segment) => Number(segment.endSec) <= finalCutoffSec);
  const newlyFinal = selectNewFinalizationCandidates(finalizedState, finalCandidates);
  let filtered = {
    segments: newlyFinal,
    adjustments: [],
    applied: false,
    runtimeInfo: null,
  };
  if (newlyFinal.length) {
    const previousFinalEndSec = finalizedState.segments.length
      ? Math.max(...finalizedState.segments.map((segment) => Number(segment.endSec) || 0))
      : null;
    filtered = await applyFinalizer(finalizerRuntimes, newlyFinal, availableFrames, smoothing, {
      currentTimeSec: nowSec,
      finalCutoffSec,
      minSegmentDurationSec,
      previousFinalEndSec,
    finalizeAll,
    skipSegmentFilter: skipSegmentFilter || completedAnalysisRanges.length > 0,
    speechResetEndRefinement,
  });
    updateFinalizedSourceEnd(finalizedState, newlyFinal);
    finalizedState.segments = mergeSegments(finalizedState.segments, filtered.segments);
    finalizedState.adjustments.push(...filtered.adjustments);
    finalizedState.filterApplied = Boolean(finalizedState.filterApplied || filtered.applied);
  }

  if (newlyFinal.length || includeCheckpoints) {
    const checkpoint = {
      nowSec: roundNumber(nowSec, 3),
      finalizeAll,
      finalCutoffSec: roundNumber(finalCutoffSec, 3),
      frameCount: availableFrames.length,
      smoothingMethod: smoothing.method,
      smoothingSegmentCount: smoothing.segments.length,
      newlyFinalCount: newlyFinal.length,
      keptFinalCount: filtered.segments.length,
      finalizedSegmentCount: finalizedState.segments.length,
      filterApplied: filtered.applied,
      filterAdjustments: filtered.adjustments,
    };
    if (includeCheckpoints || newlyFinal.length) checkpoints.push(checkpoint);
    if (newlyFinal.length) {
      finalizationBatches.push({
        ...checkpoint,
        sourceSegments: newlyFinal,
        keptSegments: filtered.segments,
      });
    }
  }
}

async function processDecodedSamples(samples) {
  let offset = 0;
  while (offset < samples.length) {
    await maybeStartSnapshotUnavailable();
    if (activeSnapshotUnavailable) {
      const remainingUnavailableSamples = Math.max(0, activeSnapshotUnavailable.endSample - sourceSampleCursor);
      const count = Math.min(chunkFrames, samples.length - offset, remainingUnavailableSamples || chunkFrames);
      sourceSampleCursor += count;
      offset += count;
      snapshotUnavailableDiagnostics.skippedSec += count / sampleRate;
      await maybeFinishSnapshotUnavailable();
      continue;
    }

    await maybeInsertDueStalls();
    await maybeStartSnapshotUnavailable();
    if (activeSnapshotUnavailable) continue;

    const nextStall = stallInsertions[nextStallInsertionIndex] || null;
    const nextStallSample = nextStall ? Math.round(nextStall.atSec * sampleRate) : Infinity;
    const nextSnapshotUnavailable = snapshotUnavailableInsertions[nextSnapshotUnavailableIndex] || null;
    const nextSnapshotUnavailableSample = nextSnapshotUnavailable
      ? Math.round(nextSnapshotUnavailable.atSec * sampleRate)
      : Infinity;
    const samplesUntilStall = Math.max(0, nextStallSample - sourceSampleCursor);
    const samplesUntilSnapshotUnavailable = Math.max(0, nextSnapshotUnavailableSample - sourceSampleCursor);
    const count = Math.min(
      chunkFrames,
      samples.length - offset,
      samplesUntilStall || chunkFrames,
      samplesUntilSnapshotUnavailable || chunkFrames
    );
    const chunk = samples.subarray(offset, offset + count);
    const chunkStartSec = sourceSampleCursor / sampleRate;
    const chunkEndSec = (sourceSampleCursor + count) / sampleRate;

    if (chunkEndSec > activeAnalysisOriginSec) {
      if (chunkStartSec >= activeAnalysisOriginSec) {
        await pushAnalysisChunk(chunk);
      } else {
        const keepOffset = Math.max(0, Math.floor((activeAnalysisOriginSec - chunkStartSec) * sampleRate));
        await pushAnalysisChunk(chunk.subarray(keepOffset));
      }
    }

    sourceSampleCursor += count;
    offset += count;
  }
  await maybeInsertDueStalls();
  await maybeStartSnapshotUnavailable();
  await maybeFinishSnapshotUnavailable();

  const now = Date.now();
  if (now - lastProgressLogAt > 5000) {
    lastProgressLogAt = now;
    console.log(`[pcm-live-sim] source=${formatTime(getSourceTimeSec())} analysis=${formatTime(getAnalysisFeedEndSec())} frames=${frames.length} finalized=${finalizedState.segments.length}`);
  }
}

async function maybeStartSnapshotUnavailable() {
  if (activeSnapshotUnavailable) return;
  while (nextSnapshotUnavailableIndex < snapshotUnavailableInsertions.length) {
    const insertion = snapshotUnavailableInsertions[nextSnapshotUnavailableIndex];
    const startSample = Math.round(insertion.atSec * sampleRate);
    const endSample = startSample + Math.round(insertion.durationSec * sampleRate);
    if (sourceSampleCursor < startSample - 1) return;
    nextSnapshotUnavailableIndex += 1;
    if (sourceSampleCursor >= endSample - 1) continue;
    await beginSnapshotUnavailable({
      ...insertion,
      startSample,
      endSample,
    });
    return;
  }
}

async function beginSnapshotUnavailable(insertion) {
  snapshotUnavailableDiagnostics.count += 1;
  snapshotUnavailableDiagnostics.insertedSec += insertion.durationSec;
  const sourceSec = getSourceTimeSec();
  const completed = await closeActiveAnalysisRange(sourceSec, 'snapshot-unavailable');
  if (completed) snapshotUnavailableDiagnostics.completedRangeCount += 1;
  activeSnapshotUnavailable = insertion;
  if (includeCheckpoints) {
    checkpoints.push({
      nowSec: roundNumber(sourceSec, 3),
      sourceSec: roundNumber(sourceSec, 3),
      snapshotUnavailable: true,
      snapshotUnavailableStartSec: roundNumber(insertion.atSec, 3),
      snapshotUnavailableDurationSec: roundNumber(insertion.durationSec, 3),
      completed,
      frameCount: frames.length,
    });
  }
}

async function maybeFinishSnapshotUnavailable() {
  if (!activeSnapshotUnavailable) return;
  if (sourceSampleCursor < activeSnapshotUnavailable.endSample - 1) return;
  const sourceSec = getSourceTimeSec();
  activeSnapshotUnavailable = null;
  openActiveAnalysisRange(sourceSec);
  if (includeCheckpoints) {
    checkpoints.push({
      nowSec: roundNumber(sourceSec, 3),
      sourceSec: roundNumber(sourceSec, 3),
      snapshotUnavailableEnded: true,
      nextAnalysisOriginSec: roundNumber(activeAnalysisOriginSec, 3),
      frameCount: frames.length,
    });
  }
}

async function maybeInsertDueStalls() {
  while (nextStallInsertionIndex < stallInsertions.length) {
    const insertion = stallInsertions[nextStallInsertionIndex];
    if (sourceSampleCursor < Math.round(insertion.atSec * sampleRate) - 1) return;
    nextStallInsertionIndex += 1;
    await simulateStallInsertion(insertion);
  }
}

async function simulateStallInsertion(insertion) {
  stallDiagnostics.count += 1;
  stallDiagnostics.insertedSec += insertion.durationSec;
  if (gateStalls) {
    stallDiagnostics.gatedSec += insertion.durationSec;
  } else {
    stallDiagnostics.ungatedSilenceSec += insertion.durationSec;
  }
  if (includeCheckpoints) {
    checkpoints.push({
      nowSec: roundNumber(getAnalysisFeedEndSec(), 3),
      sourceSec: roundNumber(getSourceTimeSec(), 3),
      stalled: true,
      gated: gateStalls,
      stallAtSec: roundNumber(insertion.atSec, 3),
      stallDurationSec: roundNumber(insertion.durationSec, 3),
      frameCount: frames.length,
    });
  }
  if (gateStalls) return;

  let remaining = Math.max(0, Math.round(insertion.durationSec * sampleRate));
  const silence = new Float32Array(chunkFrames);
  while (remaining > 0) {
    const count = Math.min(chunkFrames, remaining);
    await pushAnalysisChunk(count === chunkFrames ? silence : silence.subarray(0, count));
    remaining -= count;
  }
}

await streamFfmpegPcm({
  ffmpeg,
  audio,
  sampleRate,
  startSec,
  endSec: Number.isFinite(endSec) ? endSec : null,
  onSamples: processDecodedSamples,
});

await maybeInsertDueStalls();
await maybeStartSnapshotUnavailable();
if (activeSnapshotUnavailable) {
  await maybeFinishSnapshotUnavailable();
}
const finalNowSec = roundNumber(activeRangeOpen ? getAnalysisFeedEndSec() : getSourceTimeSec(), 3);
if (activeRangeOpen) {
  await analyzeUntil(finalNowSec);
  await flushDetectorFramesIntoCache();
  await runLiveReport(finalNowSec, true);
}

let finalSegments = uniqueSegments([...completedSegments, ...finalizedState.segments]);
let globalFinalizationFilter = null;
const fullContextSmoothing = frames.length
  ? smoothFireRedAnalyses(frames, finalNowSec, {
    startSec: initialAnalysisStartOriginSec,
    minSegmentDurationSec,
    smoothingProfile: segmentFilterAssetProfile,
  })
  : null;
if (completedAnalysisRanges.length && finalSegments.length && segmentFilterEnabled && fullContextSmoothing) {
  globalFinalizationFilter = await applyFinalizer(finalizerRuntimes, finalSegments, frames, fullContextSmoothing, {
    currentTimeSec: finalNowSec,
    finalCutoffSec: finalNowSec,
    minSegmentDurationSec,
    previousFinalEndSec: null,
    finalizeAll: true,
    skipSegmentFilter: false,
    disableEdgeTrim: true,
    speechResetEndRefinement,
  });
  finalSegments = uniqueSegments(globalFinalizationFilter.segments);
}
const clippedEvaluationManual = clipManualSegmentsToRange(manual, initialAnalysisStartOriginSec, finalNowSec);
const {
  kept: evaluationManual,
  skippedShort: evaluationSkippedShortManualSegments,
} = splitManualSegmentsByDuration(clippedEvaluationManual, minSegmentDurationSec);
const evaluationIgnoreRanges = mergeEvaluationIgnoreRanges([
  ...ignoreRanges,
  ...evaluationSkippedShortManualSegments.map((segment) => ({
    startSec: segment.startSec,
    endSec: segment.endSec,
    reason: 'below-min-segment-duration',
  })),
]);
const frameTimes = frames.map((frame) => Number(frame.timeSec) || 0);
const predictedLabels = labelsFromSegments(frameTimes, finalSegments);
const manualLabels = labelsFromSegments(frameTimes, evaluationManual);
const rawModelLabels = frames.map((frame) => {
  const threshold = Number(frame.temporalHeadThreshold) || 0.75;
  return Number(frame.temporalHeadProbability ?? frame.songProbability) >= threshold ? 1 : 0;
});
const evaluationMask = frameTimes.map((timeSec) => (
  !evaluationIgnoreRanges.some((range) => timeSec >= range.startSec && timeSec < range.endSec)
));
const filterByEvaluationMask = (values) => values.filter((_, index) => evaluationMask[index]);
const ignoredEvaluationFrameCount = evaluationMask.reduce((total, keep) => total + (keep ? 0 : 1), 0);
const matches = evaluationManual.length ? segmentMatches(finalSegments, evaluationManual, evaluationIgnoreRanges) : [];
const matchOutlierContext = {
  frames,
  manualSegments: clippedEvaluationManual,
  minSegmentDurationSec,
};
const severeOutliers = [
  ...matches.flatMap((match) => classifyMatchOutlier(match, matchOutlierContext)),
  ...classifySkippedShortManualSegments(evaluationSkippedShortManualSegments, minSegmentDurationSec, frames),
  ...classifyPredictionOutliers(finalSegments, evaluationManual, frames, evaluationIgnoreRanges),
  ...classifyModelDropOutliers(matches, frames),
];

const summary = {
  audio,
  manual: manualPath,
  params: {
    sampleRate,
    chunkFrames,
    startSec,
    endSec: Number.isFinite(endSec) ? endSec : null,
    analysisStartOriginSec: initialAnalysisStartOriginSec,
    activeAnalysisOriginSec,
    sourceEndSec: roundNumber(getSourceTimeSec(), 3),
    insertedStallSec: roundNumber(stallDiagnostics.insertedSec, 3),
    gatedStallSec: roundNumber(stallDiagnostics.gatedSec, 3),
    ungatedSilenceSec: roundNumber(stallDiagnostics.ungatedSilenceSec, 3),
    gatedStalls: gateStalls,
    stallInsertions,
    snapshotUnavailableInsertions,
    ignoreRanges,
    evaluationIgnoreRanges,
    snapshotUnavailableSec: roundNumber(snapshotUnavailableDiagnostics.insertedSec, 3),
    snapshotUnavailableSkippedSec: roundNumber(snapshotUnavailableDiagnostics.skippedSec, 3),
    hopSec: DEFAULT_HOP_SEC,
    reportStepSec,
    lookaheadSec,
    minSegmentDurationSec,
    liveAnalysisMethod: liveFrameBuilderConfig.liveAnalysisMethod,
    liveChunkSec: liveFrameBuilderConfig.chunkSec,
    liveOverlapSec: liveFrameBuilderConfig.overlapSec,
    segmentFilterEnabled,
    segmentFilterModelDir,
    segmentFilterAssetProfile,
    smoothingProfile: segmentFilterAssetProfile,
    requireProfileAssets,
    speechResetEndRefinement,
    segmentFilterLoaded: Boolean(finalizerRuntimes?.segmentFilter),
    edgeTrimAdvisorLoaded: Boolean(finalizerRuntimes?.edgeTrimAdvisor),
    segmentFilterAssetProfileUsed: finalizerRuntimes?.segmentFilter?.assetProfile || null,
    edgeTrimAdvisorAssetProfileUsed: finalizerRuntimes?.edgeTrimAdvisor?.assetProfile || null,
  },
  runtimeInfo: detector.getRuntimeInfo(),
  detectorVersion: detector.getDetectorVersion(),
  frameCount: frames.length,
  analyzedEndSec: finalNowSec,
  evaluationManualBeforeMinDurationCount: clippedEvaluationManual.length,
  evaluationManualCount: evaluationManual.length,
  evaluationMinManualDurationSec: minSegmentDurationSec,
  evaluationSkippedShortManualSegments,
  evaluationIgnoredFrameCount: ignoredEvaluationFrameCount,
  evaluationIgnoredSec: roundNumber(ignoredEvaluationFrameCount * DEFAULT_HOP_SEC, 3),
  finalSegmentCount: finalSegments.length,
  finalSegments,
  smoothingProfile: fullContextSmoothing?.smoothingProfile || segmentFilterAssetProfile,
  smoothingMethod: fullContextSmoothing?.method || null,
  trackerSegments: fullContextSmoothing?.trackerSegments || [],
  modelRunSegments: fullContextSmoothing?.modelRunSegments || [],
  fallbackSegments: fullContextSmoothing?.fallbackSegments || [],
  selectedModelFallbackSegments: fullContextSmoothing?.selectedModelFallbackSegments || [],
  droppedTrackerSegments: fullContextSmoothing?.droppedTrackerSegments || [],
  excludedMusicOnlySpans: fullContextSmoothing?.excludedMusicOnlySpans || [],
  droppedMusicOnlySegments: fullContextSmoothing?.droppedMusicOnlySegments || [],
  spectralEdgeRefinements: fullContextSmoothing?.spectralEdgeRefinements || [],
  frameDistribution: summarizeAnalysisFrameDistribution(frames, {
    segments: finalSegments,
  }),
  stallDiagnostics: {
    ...stallDiagnostics,
    insertedSec: roundNumber(stallDiagnostics.insertedSec, 3),
    gatedSec: roundNumber(stallDiagnostics.gatedSec, 3),
    ungatedSilenceSec: roundNumber(stallDiagnostics.ungatedSilenceSec, 3),
  },
  snapshotUnavailableDiagnostics: {
    ...snapshotUnavailableDiagnostics,
    insertedSec: roundNumber(snapshotUnavailableDiagnostics.insertedSec, 3),
    skippedSec: roundNumber(snapshotUnavailableDiagnostics.skippedSec, 3),
  },
  completedAnalysisRanges,
  finalizationBatches,
  globalFinalizationFilter: globalFinalizationFilter
    ? {
      applied: globalFinalizationFilter.applied,
      segmentCount: globalFinalizationFilter.segments.length,
      adjustmentCount: globalFinalizationFilter.adjustments.length,
      runtimeInfo: globalFinalizationFilter.runtimeInfo || null,
    }
    : null,
  filterAdjustments: globalFinalizationFilter?.adjustments || finalizedState.adjustments,
  metrics: evaluationManual.length
    ? metrics(filterByEvaluationMask(predictedLabels), filterByEvaluationMask(manualLabels))
    : null,
  rawModelMetrics: evaluationManual.length
    ? metrics(filterByEvaluationMask(rawModelLabels), filterByEvaluationMask(manualLabels))
    : null,
  matches,
  severeOutliers,
  checkpoints: includeCheckpoints ? checkpoints : undefined,
  frames: includeFrames ? frames : undefined,
};

await writeFile(out, JSON.stringify(summary, null, 2), 'utf8');
console.log(`[pcm-live-sim] wrote ${out}`);
console.log(`[pcm-live-sim] frames=${frames.length} segments=${finalSegments.length} filter=${segmentFilterEnabled ? 'on' : 'off'} method=${liveFrameBuilderConfig.liveAnalysisMethod}`);
if (summary.metrics) console.log('[pcm-live-sim] metrics', JSON.stringify(summary.metrics));
for (const segment of finalSegments) {
  console.log(`  pred ${formatTime(segment.startSec)}-${formatTime(segment.endSec)} dur=${Math.round(segment.endSec - segment.startSec)} conf=${segment.confidence}`);
}


