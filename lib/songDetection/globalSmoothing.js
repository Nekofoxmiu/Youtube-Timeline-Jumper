import { EventSegmentTracker } from './eventSegmentTracker.js';
import { clamp, roundNumber } from './common.js';

export const GLOBAL_SMOOTHING_VERSION = 'firered-global-smoothing-v2';
export const GLOBAL_SMOOTHING_HOP_SEC = 0.5;
export const DEFAULT_MIN_SEGMENT_DURATION_SEC = 90;

export const GLOBAL_TRACKER_CONFIG = Object.freeze({
  hopSeconds: GLOBAL_SMOOTHING_HOP_SEC,
  candidateMinDurationSec: 18,
  candidateMaxDurationSec: 75,
  minCandidateAnchors: 5,
  minCandidateAnchorSpanSec: 4,
  candidateGapSec: 8,
  tailStartRequiredWindows: 4,
  tailEndRequiredWindows: 3,
  tailMaxDurationSec: 40,
  tailSpeechGraceSec: 6,
  tailPaddingSec: 40,
  minSegmentDurationSec: DEFAULT_MIN_SEGMENT_DURATION_SEC,
  mergeGapSec: 8,
  provisionalMinDurationSec: 12,
});

const MODEL_RUN_SEGMENT_RULES = Object.freeze({
  minSegmentDurationSec: 60,
  mergeGapSec: 18,
  introPaddingSec: 6,
  tailPaddingSec: 40,
  maxModelOnlyTailSec: 40,
  modelDropMaxGapSec: 8,
  suspiciousCoverageRatio: 0.65,
  suspiciousTailOverrunSec: 12,
  suspiciousStartOverrunSec: 10,
  selectiveFallbackMinOverlapRatio: 0.35,
  selectiveFallbackMinOverlapSec: 20,
  unsupportedTrackerMaxModelRatio: 0.45,
  unsupportedTrackerMinSingingMedian: 0.65,
  unsupportedTrackerMinSingingMean: 0.55,
  unsupportedTrackerMinFrames: 20,
  edgeTrimNonSongRatio: 0.72,
  edgeTrimMinFrames: 8,
  musicOnlyExcludeMinDurationSec: 180,
  musicOnlyCandidateGapSec: 6,
  musicOnlyMinCandidateRatio: 0.78,
  musicOnlyMinMusicMean: 0.55,
  musicOnlyMinMusicP80: 0.65,
  musicOnlyMaxSingingMean: 0.22,
  musicOnlyMaxSingingP90: 0.38,
  musicOnlyMaxSingingRatioMean: 0.08,
  musicOnlyMaxSpeechMean: 0.32,
  musicOnlyMaxSpeechP90: 0.55,
  musicOnlyMaxSpeechRatioMean: 0.12,
  silenceRmsThreshold: 0.0045,
  silencePeakThreshold: 0.018,
  silenceMinDurationSec: 1.6,
  silenceEndPaddingSec: 0.8,
  energyTailLookbackSec: 3.5,
  energyDropRatio: 0.2,
  energyPeakDropRatio: 0.3,
  energyDropMinDurationSec: 2.5,
  energyEndPaddingSec: 1.2,
  lowRegularityEnergyRatio: 0.35,
  lowRegularityCvThreshold: 0.05,
  preRollSec: 50,
  startLookbackSec: 45,
  startPaddingSec: 0.5,
  startEnergyRatio: 0.15,
  startPeakRatio: 0.24,
  startNoiseMultiplier: 1.55,
  startGapToleranceSec: 8,
  startMinRunSec: 0.75,
  startEnergyOnlyWindowSec: 10,
  vocalSingingThreshold: 0.72,
  vocalSingingMeanThreshold: 0.35,
  vocalSingingRatioThreshold: 0.12,
});

const DECISION_RULES = Object.freeze({
  historyWindowSec: 45,
  shortWindowSec: 4,
  mediumWindowSec: 10,
  anchorGraceSec: 12,
  introLookbackSec: 45,
  introGapToleranceSec: 8,
  singingPresentThreshold: 0.78,
  singingMeanShortThreshold: 0.5,
  singingMeanMediumThreshold: 0.52,
  musicPresentThreshold: 0.65,
  musicMeanMediumThreshold: 0.55,
  speechDominantThreshold: 0.65,
  speechLowSingingCeiling: 0.35,
});

const TRACKER_START_MARGIN = 0.02;
const TRACKER_HYSTERESIS_GAP = 0.18;

function toFiniteNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveMinSegmentDurationSec(value, fallback = GLOBAL_TRACKER_CONFIG.minSegmentDurationSec) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return clamp(Math.round(num), 15, 600);
}

function normalizeAnalysisFrame(frame) {
  const timeSec = toFiniteNumber(frame?.timeSec, null);
  if (timeSec === null) return null;
  return {
    ...frame,
    ready: frame?.ready !== false,
    timeSec,
    songProbability: clamp(Number(frame?.songProbability) || 0, 0, 1),
    temporalHeadReady: Boolean(frame?.temporalHeadReady),
    temporalHeadProbability: Number.isFinite(Number(frame?.temporalHeadProbability))
      ? clamp(Number(frame.temporalHeadProbability), 0, 1)
      : null,
    temporalHeadThreshold: Number.isFinite(Number(frame?.temporalHeadThreshold))
      ? clamp(Number(frame.temporalHeadThreshold), 0.05, 0.95)
      : null,
    speechProbability: clamp(Number(frame?.speechProbability ?? frame?.speechMean) || 0, 0, 1),
    singingProbability: clamp(Number(frame?.singingProbability ?? frame?.singingMean) || 0, 0, 1),
    musicProbability: clamp(Number(frame?.musicProbability ?? frame?.musicMean) || 0, 0, 1),
    speechMean: clamp(Number(frame?.speechMean) || 0, 0, 1),
    singingMean: clamp(Number(frame?.singingMean) || 0, 0, 1),
    musicMean: clamp(Number(frame?.musicMean) || 0, 0, 1),
    speechRatio: clamp(Number(frame?.speechRatio) || 0, 0, 1),
    singingRatio: clamp(Number(frame?.singingRatio) || 0, 0, 1),
    musicRatio: clamp(Number(frame?.musicRatio) || 0, 0, 1),
    audioRms: Math.max(0, Number(frame?.audioRms) || 0),
    audioPeak: Math.max(0, Number(frame?.audioPeak) || 0),
  };
}

export function normalizeAnalysisFrames(frames) {
  return (Array.isArray(frames) ? frames : [])
    .map(normalizeAnalysisFrame)
    .filter(Boolean)
    .sort((a, b) => a.timeSec - b.timeSec);
}

function summarizeHistory(history, now, windowSec) {
  const frames = history.filter((frame) => frame.timeSec >= now - windowSec);
  if (!frames.length) {
    return { singingMax: 0, singingMean: 0, musicMax: 0, musicMean: 0, speechMean: 0 };
  }
  return frames.reduce((acc, frame) => {
    acc.singingMax = Math.max(acc.singingMax, frame.singing);
    acc.musicMax = Math.max(acc.musicMax, frame.music);
    acc.singingMean += frame.singing / frames.length;
    acc.musicMean += frame.music / frames.length;
    acc.speechMean += frame.speech / frames.length;
    return acc;
  }, { singingMax: 0, singingMean: 0, musicMax: 0, musicMean: 0, speechMean: 0 });
}

function resolveTrackerThresholds(analysis = {}) {
  const calibratedThreshold = clamp(toFiniteNumber(analysis.temporalHeadThreshold, 0.75), 0.05, 0.95);
  const start = clamp(calibratedThreshold - TRACKER_START_MARGIN, 0.08, 0.9);
  const end = clamp(start - TRACKER_HYSTERESIS_GAP, 0.05, Math.max(0.05, start - 0.02));
  return { start, end };
}

function findAnchoredStartSec(history, now) {
  let anchorIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const frame = history[index];
    if (now - frame.timeSec > DECISION_RULES.mediumWindowSec) break;
    if (frame.singing >= DECISION_RULES.singingPresentThreshold || frame.model >= frame.thresholds.start) {
      anchorIndex = index;
      break;
    }
  }
  if (anchorIndex < 0) return null;

  let startSec = history[anchorIndex].timeSec;
  let gapSec = 0;
  for (let index = anchorIndex; index >= 0; index -= 1) {
    const frame = history[index];
    if (now - frame.timeSec > DECISION_RULES.introLookbackSec) break;
    const musicLike = frame.music >= 0.55 || frame.model >= frame.thresholds.end;
    const singingLike = frame.singing >= 0.5 || frame.model >= frame.thresholds.start;
    const speechDominant = frame.speech >= 0.68 && frame.singing < 0.28;
    if (speechDominant) break;

    if (musicLike || singingLike) {
      startSec = frame.timeSec;
      gapSec = 0;
    } else {
      gapSec += GLOBAL_SMOOTHING_HOP_SEC;
      if (gapSec > DECISION_RULES.introGapToleranceSec) break;
    }
  }
  return Math.max(0, startSec);
}

function isSilentFrame(analysis) {
  const rms = Number(analysis.audioRms);
  const peak = Number(analysis.audioPeak);
  if (!Number.isFinite(rms) || !Number.isFinite(peak)) return false;
  return rms <= MODEL_RUN_SEGMENT_RULES.silenceRmsThreshold
    && peak <= MODEL_RUN_SEGMENT_RULES.silencePeakThreshold;
}

function applyDecision(session, timeSec, analysis) {
  const thresholds = resolveTrackerThresholds(analysis);
  const temporalHeadReady = Boolean(analysis.temporalHeadReady);
  const temporalHeadProbability = clamp(Number(analysis.temporalHeadProbability ?? analysis.songProbability) || 0, 0, 1);
  const frame = {
    timeSec,
    singing: clamp(Number(analysis.singingProbability ?? analysis.singingMean) || 0, 0, 1),
    music: clamp(Number(analysis.musicProbability ?? analysis.musicMean) || 0, 0, 1),
    speech: clamp(Number(analysis.speechProbability ?? analysis.speechMean) || 0, 0, 1),
    model: temporalHeadProbability,
    thresholds,
  };
  session.history.push(frame);
  session.history = session.history.filter((item) => item.timeSec >= timeSec - DECISION_RULES.historyWindowSec);

  const shortStats = summarizeHistory(session.history, timeSec, DECISION_RULES.shortWindowSec);
  const mediumStats = summarizeHistory(session.history, timeSec, DECISION_RULES.mediumWindowSec);
  const trackerIsSong = Boolean(session.segmentTracker?.isSong);
  const silentFrame = isSilentFrame(analysis);
  const speechDominant = silentFrame || (
    mediumStats.speechMean >= DECISION_RULES.speechDominantThreshold
    && shortStats.singingMean < DECISION_RULES.speechLowSingingCeiling
  );
  const hasAcousticSingingAnchor = !speechDominant && (
    shortStats.singingMax >= DECISION_RULES.singingPresentThreshold
    || shortStats.singingMean >= DECISION_RULES.singingMeanShortThreshold
    || mediumStats.singingMean >= DECISION_RULES.singingMeanMediumThreshold
  );
  const hasAcousticMusicSustain = !silentFrame && (
    shortStats.musicMax >= DECISION_RULES.musicPresentThreshold
    || mediumStats.musicMean >= DECISION_RULES.musicMeanMediumThreshold
  );
  const hasModelAnchor = temporalHeadReady && temporalHeadProbability >= thresholds.start && !speechDominant;
  const hasModelSustain = !silentFrame && temporalHeadReady && temporalHeadProbability >= thresholds.end && !speechDominant;
  const hasSingingAnchor = hasAcousticSingingAnchor || hasModelAnchor;
  const hasMusicSustain = hasAcousticMusicSustain || hasModelSustain;

  if (hasSingingAnchor) session.lastSingingAnchorSec = timeSec;
  const hasRecentAnchor = Number.isFinite(session.lastSingingAnchorSec)
    && timeSec - session.lastSingingAnchorSec <= DECISION_RULES.anchorGraceSec;

  let songProbability = 0;
  if (hasSingingAnchor) {
    songProbability = temporalHeadReady ? Math.max(temporalHeadProbability, thresholds.start + 0.08) : thresholds.start + 0.08;
  } else if ((trackerIsSong || hasRecentAnchor || hasModelSustain) && hasMusicSustain && !speechDominant) {
    songProbability = temporalHeadReady ? Math.max(temporalHeadProbability, thresholds.end + 0.08, 0.38) : Math.max(thresholds.end + 0.08, 0.38);
  }

  const startSecOverride = hasSingingAnchor ? findAnchoredStartSec(session.history, timeSec) : null;
  const decision = {
    timeSec,
    songProbability: clamp(songProbability, 0, 1),
    confidence: clamp(songProbability, 0, 1),
    hasSingingAnchor,
    hasRecentAnchor: hasRecentAnchor || (trackerIsSong && hasModelSustain),
    hasMusicSustain,
    speechDominant,
    startSecOverride,
    modelProbability: temporalHeadProbability,
    silentFrame,
    thresholds,
  };
  session.decisions.push(decision);
  return decision;
}

function mergeSegments(segments, {
  maxGapSec = GLOBAL_TRACKER_CONFIG.mergeGapSec,
  minSegmentDurationSec = GLOBAL_TRACKER_CONFIG.minSegmentDurationSec,
} = {}) {
  const merged = [];
  for (const segment of [...segments].sort((a, b) => a.startSec - b.startSec)) {
    if (!merged.length || segment.startSec - merged[merged.length - 1].endSec > maxGapSec) {
      merged.push({ ...segment });
    } else {
      const previous = merged[merged.length - 1];
      const previousDuration = Math.max(0.001, previous.endSec - previous.startSec);
      const currentDuration = Math.max(0.001, segment.endSec - segment.startSec);
      const combinedDuration = previousDuration + currentDuration;
      previous.endSec = Math.max(previous.endSec, segment.endSec);
      previous.confidence = ((previous.confidence * previousDuration) + (segment.confidence * currentDuration)) / combinedDuration;
    }
  }
  return merged.filter((segment) => segment.endSec - segment.startSec >= minSegmentDurationSec);
}

function isVocalFrame(analysis) {
  return (Number(analysis.singingProbability) || 0) >= MODEL_RUN_SEGMENT_RULES.vocalSingingThreshold
    || (Number(analysis.singingMean) || 0) >= MODEL_RUN_SEGMENT_RULES.vocalSingingMeanThreshold
    || (Number(analysis.singingRatio) || 0) >= MODEL_RUN_SEGMENT_RULES.vocalSingingRatioThreshold;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, ratio) {
  const sorted = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values, avg = mean(values)) {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length);
}

function pushLimited(values, value, maxItems = 240) {
  values.push(value);
  if (values.length > maxItems) values.splice(0, values.length - maxItems);
}

function updateActiveEnergyProfile(active, analysis, vocalFrame) {
  const rms = Number(analysis.audioRms);
  const peak = Number(analysis.audioPeak);
  if (!Number.isFinite(rms) || !Number.isFinite(peak)) return;
  pushLimited(active.energyFrames, { timeSec: analysis.timeSec, rms, peak }, 80);
  if (vocalFrame && rms > MODEL_RUN_SEGMENT_RULES.silenceRmsThreshold * 1.5) {
    pushLimited(active.vocalRmsSamples, rms);
    pushLimited(active.vocalPeakSamples, peak);
  }
}

function getActiveEnergyReference(active) {
  const rmsSamples = active.vocalRmsSamples.filter((value) => value > MODEL_RUN_SEGMENT_RULES.silenceRmsThreshold * 1.5);
  if (rmsSamples.length < 3) return null;
  const peakSamples = active.vocalPeakSamples.filter((value) => value > MODEL_RUN_SEGMENT_RULES.silencePeakThreshold);
  return {
    rms: median(rmsSamples),
    peak: median(peakSamples.length ? peakSamples : active.vocalPeakSamples),
  };
}

function getRecentEnergyStats(active, now) {
  const frames = active.energyFrames.filter((frame) => now - frame.timeSec <= MODEL_RUN_SEGMENT_RULES.energyTailLookbackSec);
  if (!frames.length) return null;
  const rmsValues = frames.map((frame) => frame.rms);
  const peakValues = frames.map((frame) => frame.peak);
  const meanRms = mean(rmsValues);
  const rmsStd = stddev(rmsValues, meanRms);
  return {
    meanRms,
    meanPeak: mean(peakValues),
    rmsCv: meanRms > 1e-6 ? rmsStd / meanRms : 0,
  };
}

function isEnergyCollapsed(active, analysis) {
  const reference = getActiveEnergyReference(active);
  const recent = getRecentEnergyStats(active, analysis.timeSec);
  if (!reference || !recent) return false;
  const rmsFloor = Math.max(MODEL_RUN_SEGMENT_RULES.silenceRmsThreshold * 1.25, reference.rms * MODEL_RUN_SEGMENT_RULES.energyDropRatio);
  const peakFloor = Math.max(MODEL_RUN_SEGMENT_RULES.silencePeakThreshold * 1.1, reference.peak * MODEL_RUN_SEGMENT_RULES.energyPeakDropRatio);
  const energyDrop = recent.meanRms <= rmsFloor && recent.meanPeak <= peakFloor;
  const lowFlatEnergy = recent.meanRms <= reference.rms * MODEL_RUN_SEGMENT_RULES.lowRegularityEnergyRatio
    && recent.rmsCv <= MODEL_RUN_SEGMENT_RULES.lowRegularityCvThreshold;
  return energyDrop || lowFlatEnergy;
}

function getAnalysisRms(analysis) {
  const value = Number(analysis.audioRms);
  return Number.isFinite(value) ? value : 0;
}

function getAnalysisPeak(analysis) {
  const value = Number(analysis.audioPeak);
  return Number.isFinite(value) ? value : 0;
}

function isMusicLikeFrame(analysis, thresholds = resolveTrackerThresholds(analysis)) {
  const modelProbability = Number(analysis.temporalHeadProbability ?? analysis.songProbability) || 0;
  return isVocalFrame(analysis)
    || modelProbability >= thresholds.end
    || (Number(analysis.musicProbability) || 0) >= 0.58
    || (Number(analysis.musicMean) || 0) >= 0.48
    || (Number(analysis.musicRatio) || 0) >= 0.28;
}

function estimateStartEnergyReference(frames, anchorTimeSec) {
  const rmsValues = frames.map(getAnalysisRms).filter((value) => value > 0);
  if (!rmsValues.length) return null;
  const peakValues = frames.map(getAnalysisPeak).filter((value) => value > 0);
  const anchorFrames = frames.filter((frame) => anchorTimeSec - frame.timeSec <= 2 && frame.timeSec <= anchorTimeSec);
  const anchorRms = median(anchorFrames.map(getAnalysisRms).filter((value) => value > 0)) || median(rmsValues);
  const anchorPeak = median(anchorFrames.map(getAnalysisPeak).filter((value) => value > 0)) || median(peakValues);
  const noiseRms = percentile(rmsValues, 0.2);
  const noisePeak = percentile(peakValues, 0.2);
  return {
    rms: Math.max(
      MODEL_RUN_SEGMENT_RULES.silenceRmsThreshold * 1.25,
      noiseRms * MODEL_RUN_SEGMENT_RULES.startNoiseMultiplier,
      anchorRms * MODEL_RUN_SEGMENT_RULES.startEnergyRatio
    ),
    peak: Math.max(
      MODEL_RUN_SEGMENT_RULES.silencePeakThreshold * 1.05,
      noisePeak * MODEL_RUN_SEGMENT_RULES.startNoiseMultiplier,
      anchorPeak * MODEL_RUN_SEGMENT_RULES.startPeakRatio
    ),
  };
}

function isAdaptiveStartFrame(analysis, reference, anchorTimeSec) {
  if (!reference || isSilentFrame(analysis)) return false;
  const energyActive = getAnalysisRms(analysis) >= reference.rms
    || getAnalysisPeak(analysis) >= reference.peak;
  if (!energyActive) return false;
  if (isMusicLikeFrame(analysis)) return true;

  const nearAnchor = anchorTimeSec - analysis.timeSec <= MODEL_RUN_SEGMENT_RULES.startEnergyOnlyWindowSec;
  const speechLow = (Number(analysis.speechProbability) || 0) < 0.62
    && (Number(analysis.speechMean) || 0) < 0.42;
  return nearAnchor && speechLow;
}

function findAdaptiveStartSec(preRollFrames, anchorAnalysis) {
  const fallbackStart = Math.max(0, anchorAnalysis.timeSec - GLOBAL_SMOOTHING_HOP_SEC - MODEL_RUN_SEGMENT_RULES.introPaddingSec);
  const minTimeSec = Math.max(0, anchorAnalysis.timeSec - MODEL_RUN_SEGMENT_RULES.startLookbackSec);
  const frames = preRollFrames
    .filter((frame) => frame.timeSec >= minTimeSec && frame.timeSec <= anchorAnalysis.timeSec)
    .sort((a, b) => a.timeSec - b.timeSec);
  if (frames.length < 2) return fallbackStart;

  const reference = estimateStartEnergyReference(frames, anchorAnalysis.timeSec);
  if (!reference) return fallbackStart;

  let earliest = anchorAnalysis.timeSec;
  let gapSec = 0;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (isAdaptiveStartFrame(frame, reference, anchorAnalysis.timeSec)) {
      earliest = Math.max(0, frame.timeSec - GLOBAL_SMOOTHING_HOP_SEC);
      gapSec = 0;
      continue;
    }

    gapSec += GLOBAL_SMOOTHING_HOP_SEC;
    if (gapSec > MODEL_RUN_SEGMENT_RULES.startGapToleranceSec) break;
  }

  const runDuration = anchorAnalysis.timeSec - earliest;
  if (runDuration < MODEL_RUN_SEGMENT_RULES.startMinRunSec) return fallbackStart;
  return Math.max(0, earliest - MODEL_RUN_SEGMENT_RULES.startPaddingSec);
}

function finalizeModelRunSegment(active, endSec, endSecOverride = null) {
  const anchorEndSec = Number.isFinite(active.lastVocalSec) ? active.lastVocalSec : active.lastPositiveSec;
  const boundedEndSec = Number.isFinite(Number(endSecOverride))
    ? Number(endSecOverride)
    : anchorEndSec + MODEL_RUN_SEGMENT_RULES.tailPaddingSec;
  return {
    startSec: active.startSec,
    endSec: Math.min(endSec, Math.max(active.startSec, boundedEndSec)),
    confidence: active.confidenceTotal / Math.max(1, active.confidenceCount),
  };
}

export function buildModelRunSegmentsFromAnalyses(analyses, endSec) {
  const normalizedAnalyses = normalizeAnalysisFrames(analyses);
  if (!normalizedAnalyses.some((analysis) => analysis.temporalHeadReady)) return [];
  const segments = [];
  let active = null;
  const preRollFrames = [];
  const maxPreRollFrames = Math.max(1, Math.round(MODEL_RUN_SEGMENT_RULES.preRollSec / GLOBAL_SMOOTHING_HOP_SEC));

  for (const analysis of normalizedAnalyses) {
    pushLimited(preRollFrames, analysis, maxPreRollFrames);
    const probability = clamp(Number(analysis.temporalHeadProbability ?? analysis.songProbability) || 0, 0, 1);
    const thresholds = resolveTrackerThresholds(analysis);
    const positive = analysis.temporalHeadReady && probability >= thresholds.start;
    const vocalFrame = isVocalFrame(analysis);
    const silentFrame = isSilentFrame(analysis);

    if (active) updateActiveEnergyProfile(active, analysis, vocalFrame);

    if (active && !vocalFrame) {
      const energyCollapsed = isEnergyCollapsed(active, analysis);
      if (silentFrame || energyCollapsed) {
        const markerKey = silentFrame ? 'silenceStartSec' : 'energyDropStartSec';
        const minDuration = silentFrame
          ? MODEL_RUN_SEGMENT_RULES.silenceMinDurationSec
          : MODEL_RUN_SEGMENT_RULES.energyDropMinDurationSec;
        const paddingSec = silentFrame
          ? MODEL_RUN_SEGMENT_RULES.silenceEndPaddingSec
          : MODEL_RUN_SEGMENT_RULES.energyEndPaddingSec;
        if (!Number.isFinite(active[markerKey])) {
          active[markerKey] = Math.max(active.startSec, analysis.timeSec - GLOBAL_SMOOTHING_HOP_SEC);
        }
        const markerDuration = analysis.timeSec - active[markerKey];
        if (markerDuration >= minDuration) {
          segments.push(finalizeModelRunSegment(active, endSec, active[markerKey] + paddingSec));
          active = null;
          continue;
        }
      } else {
        active.silenceStartSec = null;
        active.energyDropStartSec = null;
      }
    } else if (active) {
      active.silenceStartSec = null;
      active.energyDropStartSec = null;
    }

    if (positive && vocalFrame) {
      if (!active) {
        active = {
          startSec: findAdaptiveStartSec(preRollFrames, analysis),
          lastPositiveSec: analysis.timeSec,
          lastVocalSec: analysis.timeSec,
          silenceStartSec: null,
          energyDropStartSec: null,
          modelDropStartSec: null,
          energyFrames: [],
          vocalRmsSamples: [],
          vocalPeakSamples: [],
          confidenceTotal: 0,
          confidenceCount: 0,
        };
        updateActiveEnergyProfile(active, analysis, true);
      }
      active.modelDropStartSec = null;
      active.lastPositiveSec = analysis.timeSec;
      active.lastVocalSec = analysis.timeSec;
      active.confidenceTotal += probability;
      active.confidenceCount += 1;
    } else if (positive && active) {
      active.modelDropStartSec = null;
      active.lastPositiveSec = analysis.timeSec;
      if (Number.isFinite(active.lastVocalSec) && analysis.timeSec - active.lastVocalSec > MODEL_RUN_SEGMENT_RULES.maxModelOnlyTailSec) {
        segments.push(finalizeModelRunSegment(active, endSec));
        active = null;
      }
    } else if (active) {
      if (!Number.isFinite(active.modelDropStartSec)) {
        active.modelDropStartSec = analysis.timeSec;
      }
      if (analysis.timeSec - active.modelDropStartSec <= MODEL_RUN_SEGMENT_RULES.modelDropMaxGapSec) {
        continue;
      }
      segments.push(finalizeModelRunSegment(active, endSec));
      active = null;
    }
  }

  if (active) {
    segments.push(finalizeModelRunSegment(active, endSec));
  }

  return mergeSegments(segments, {
    maxGapSec: MODEL_RUN_SEGMENT_RULES.mergeGapSec,
    minSegmentDurationSec: MODEL_RUN_SEGMENT_RULES.minSegmentDurationSec,
  }).map((segment) => normalizeOutputSegment(segment));
}

function segmentDuration(segment) {
  return Math.max(0, Number(segment?.endSec) - Number(segment?.startSec));
}

function segmentOverlapSec(left, right) {
  return Math.max(0, Math.min(left.endSec, right.endSec) - Math.max(left.startSec, right.startSec));
}

function findOverlappingModelSegments(segment, modelRunSegments) {
  return modelRunSegments
    .map((modelSegment) => ({
      segment: modelSegment,
      overlapSec: segmentOverlapSec(segment, modelSegment),
    }))
    .filter(({ segment: modelSegment, overlapSec }) => {
      const modelDuration = Math.max(1, segmentDuration(modelSegment));
      return overlapSec >= MODEL_RUN_SEGMENT_RULES.selectiveFallbackMinOverlapSec
        || overlapSec / modelDuration >= MODEL_RUN_SEGMENT_RULES.selectiveFallbackMinOverlapRatio;
    })
    .sort((a, b) => a.segment.startSec - b.segment.startSec);
}

function isNonSongEdgeFrame(analysis) {
  if (!analysis) return false;
  const thresholds = resolveTrackerThresholds(analysis);
  const modelProbability = Number(analysis.temporalHeadProbability ?? analysis.songProbability) || 0;
  const lowModel = !analysis.temporalHeadReady || modelProbability < thresholds.end;
  const lowVocal = !isVocalFrame(analysis);
  const lowMusic = (Number(analysis.musicProbability) || 0) < 0.58
    && (Number(analysis.musicMean) || 0) < 0.48
    && (Number(analysis.musicRatio) || 0) < 0.28;
  const speechDominant = (Number(analysis.speechProbability) || 0) >= 0.68
    && (Number(analysis.singingProbability) || 0) < 0.28;
  return isSilentFrame(analysis) || (lowModel && (speechDominant || (lowVocal && lowMusic)));
}

function edgeLooksNonSong(analyses, startSec, endSec) {
  const frames = analyses.filter((analysis) => analysis.timeSec >= startSec && analysis.timeSec <= endSec);
  if (frames.length < MODEL_RUN_SEGMENT_RULES.edgeTrimMinFrames) return false;
  const nonSongCount = frames.filter(isNonSongEdgeFrame).length;
  return nonSongCount / frames.length >= MODEL_RUN_SEGMENT_RULES.edgeTrimNonSongRatio;
}

function summarizeSegmentModelSupport(analyses, segment) {
  const frames = analyses.filter((analysis) => analysis.timeSec >= segment.startSec && analysis.timeSec < segment.endSec);
  if (!frames.length) {
    return {
      frameCount: 0,
      modelAboveRatio: 0,
      singingMedian: 0,
      singingMean: 0,
    };
  }
  const modelAboveCount = frames.filter((analysis) => {
    const thresholds = resolveTrackerThresholds(analysis);
    const modelProbability = Number(analysis.temporalHeadProbability ?? analysis.songProbability) || 0;
    return analysis.temporalHeadReady && modelProbability >= thresholds.start;
  }).length;
  const singingValues = frames.map((analysis) => Number(analysis.singingProbability ?? analysis.singingMean) || 0);
  return {
    frameCount: frames.length,
    modelAboveRatio: modelAboveCount / frames.length,
    singingMedian: median(singingValues),
    singingMean: mean(singingValues),
  };
}

function shouldDropUnsupportedTrackerSegment(segment, support) {
  if (support.frameCount < MODEL_RUN_SEGMENT_RULES.unsupportedTrackerMinFrames) return false;
  const weakModel = support.modelAboveRatio < MODEL_RUN_SEGMENT_RULES.unsupportedTrackerMaxModelRatio;
  const weakVocal = support.singingMedian < MODEL_RUN_SEGMENT_RULES.unsupportedTrackerMinSingingMedian
    && support.singingMean < MODEL_RUN_SEGMENT_RULES.unsupportedTrackerMinSingingMean;
  return weakModel && weakVocal && segmentDuration(segment) < MODEL_RUN_SEGMENT_RULES.maxModelOnlyTailSec * 5;
}

function frameMusicValue(analysis) {
  return Math.max(
    Number(analysis?.musicProbability) || 0,
    Number(analysis?.musicMean) || 0,
    Number(analysis?.musicRatio) || 0
  );
}

function frameSingingValue(analysis) {
  return Math.max(
    Number(analysis?.singingProbability) || 0,
    Number(analysis?.singingMean) || 0
  );
}

function frameSpeechValue(analysis) {
  return Math.max(
    Number(analysis?.speechProbability) || 0,
    Number(analysis?.speechMean) || 0
  );
}

function isMusicOnlyCandidateFrame(analysis) {
  if (!analysis || isSilentFrame(analysis)) return false;
  const musicHigh = (Number(analysis.musicProbability) || 0) >= 0.66
    || (Number(analysis.musicMean) || 0) >= 0.56
    || (Number(analysis.musicRatio) || 0) >= 0.42;
  const singingLow = (Number(analysis.singingProbability) || 0) <= 0.32
    && (Number(analysis.singingMean) || 0) <= 0.26
    && (Number(analysis.singingRatio) || 0) <= 0.1;
  const speechLow = (Number(analysis.speechProbability) || 0) <= 0.48
    && (Number(analysis.speechMean) || 0) <= 0.36
    && (Number(analysis.speechRatio) || 0) <= 0.16;
  return musicHigh && singingLow && speechLow;
}

function summarizeMusicOnlySpan(frames, startSec, endSec, candidateCount) {
  const durationSec = Math.max(0, endSec - startSec);
  const spanFrames = frames.filter((frame) => frame.timeSec >= startSec && frame.timeSec <= endSec);
  const frameCount = spanFrames.length;
  if (!frameCount || durationSec < MODEL_RUN_SEGMENT_RULES.musicOnlyExcludeMinDurationSec) return null;

  const musicValues = spanFrames.map(frameMusicValue);
  const singingValues = spanFrames.map(frameSingingValue);
  const speechValues = spanFrames.map(frameSpeechValue);
  const singingRatioValues = spanFrames.map((frame) => Number(frame.singingRatio) || 0);
  const speechRatioValues = spanFrames.map((frame) => Number(frame.speechRatio) || 0);
  const summary = {
    startSec,
    endSec,
    durationSec,
    frameCount,
    candidateRatio: candidateCount / frameCount,
    musicMean: mean(musicValues),
    musicP80: percentile(musicValues, 0.8),
    singingMean: mean(singingValues),
    singingP90: percentile(singingValues, 0.9),
    singingRatioMean: mean(singingRatioValues),
    speechMean: mean(speechValues),
    speechP90: percentile(speechValues, 0.9),
    speechRatioMean: mean(speechRatioValues),
  };

  const musicSustained = summary.candidateRatio >= MODEL_RUN_SEGMENT_RULES.musicOnlyMinCandidateRatio
    && summary.musicMean >= MODEL_RUN_SEGMENT_RULES.musicOnlyMinMusicMean
    && summary.musicP80 >= MODEL_RUN_SEGMENT_RULES.musicOnlyMinMusicP80;
  const singingLow = summary.singingMean <= MODEL_RUN_SEGMENT_RULES.musicOnlyMaxSingingMean
    && summary.singingP90 <= MODEL_RUN_SEGMENT_RULES.musicOnlyMaxSingingP90
    && summary.singingRatioMean <= MODEL_RUN_SEGMENT_RULES.musicOnlyMaxSingingRatioMean;
  const speechLow = summary.speechMean <= MODEL_RUN_SEGMENT_RULES.musicOnlyMaxSpeechMean
    && summary.speechP90 <= MODEL_RUN_SEGMENT_RULES.musicOnlyMaxSpeechP90
    && summary.speechRatioMean <= MODEL_RUN_SEGMENT_RULES.musicOnlyMaxSpeechRatioMean;
  if (!musicSustained || !singingLow || !speechLow) return null;

  return {
    startSec: roundNumber(startSec, 3),
    endSec: roundNumber(endSec, 3),
    durationSec: roundNumber(durationSec, 3),
    reason: 'long-music-only-low-vocal',
    stats: {
      frameCount,
      candidateRatio: roundNumber(summary.candidateRatio, 3),
      musicMean: roundNumber(summary.musicMean, 3),
      musicP80: roundNumber(summary.musicP80, 3),
      singingMean: roundNumber(summary.singingMean, 3),
      singingP90: roundNumber(summary.singingP90, 3),
      singingRatioMean: roundNumber(summary.singingRatioMean, 3),
      speechMean: roundNumber(summary.speechMean, 3),
      speechP90: roundNumber(summary.speechP90, 3),
      speechRatioMean: roundNumber(summary.speechRatioMean, 3),
    },
  };
}

function findLongMusicOnlySpans(analyses, startSec, endSec) {
  const frames = analyses
    .filter((analysis) => analysis.timeSec >= startSec && analysis.timeSec <= endSec)
    .sort((a, b) => a.timeSec - b.timeSec);
  const spans = [];
  let active = null;

  function closeActive(closeSec) {
    if (!active) return;
    const span = summarizeMusicOnlySpan(active.frames, active.startSec, closeSec, active.candidateCount);
    if (span) spans.push(span);
    active = null;
  }

  for (const frame of frames) {
    const frameStartSec = Math.max(startSec, Number(frame.timeSec) || startSec);
    const frameEndSec = Math.min(endSec, frameStartSec + GLOBAL_SMOOTHING_HOP_SEC);
    const candidate = isMusicOnlyCandidateFrame(frame);
    if (candidate) {
      if (!active) {
        active = {
          startSec: frameStartSec,
          lastCandidateEndSec: frameEndSec,
          gapStartSec: null,
          candidateCount: 0,
          frames: [],
        };
      }
      active.lastCandidateEndSec = frameEndSec;
      active.gapStartSec = null;
      active.candidateCount += 1;
      active.frames.push(frame);
      continue;
    }

    if (!active) continue;
    if (!Number.isFinite(active.gapStartSec)) {
      active.gapStartSec = frameStartSec;
    }
    const toleratedGapSec = frameEndSec - active.gapStartSec;
    if (toleratedGapSec <= MODEL_RUN_SEGMENT_RULES.musicOnlyCandidateGapSec) {
      active.frames.push(frame);
      continue;
    }
    closeActive(active.lastCandidateEndSec);
  }

  if (active) closeActive(active.lastCandidateEndSec);
  return spans;
}

function applyLongMusicOnlyExclusion(segments, analyses, startSec, endSec) {
  const excludedMusicOnlySpans = findLongMusicOnlySpans(analyses, startSec, endSec);
  if (!excludedMusicOnlySpans.length) {
    return { segments, excludedMusicOnlySpans, droppedMusicOnlySegments: [], changed: false };
  }

  const droppedMusicOnlySegments = [];
  const output = [];
  for (const segment of segments) {
    const matchedSpan = excludedMusicOnlySpans.find((span) => segmentOverlapSec(segment, span) > 0);
    if (matchedSpan) {
      droppedMusicOnlySegments.push({
        ...normalizeOutputSegment(segment),
        reason: matchedSpan.reason,
        exclusionSpan: matchedSpan,
      });
    } else {
      output.push(segment);
    }
  }
  const filteredSegments = output
    .map((segment) => normalizeOutputSegment(segment))
    .sort((a, b) => a.startSec - b.startSec);

  const changed = filteredSegments.length !== segments.length
    || filteredSegments.some((segment, index) => {
      const original = segments[index];
      return !original
        || Math.abs(segment.startSec - original.startSec) > 0.001
        || Math.abs(segment.endSec - original.endSec) > 0.001;
    });
  return { segments: filteredSegments, excludedMusicOnlySpans, droppedMusicOnlySegments, changed };
}

function refineTrackerSegmentWithModelEdges(segment, overlappingModels, analyses) {
  if (overlappingModels.length !== 1) return segment;
  const modelSegment = overlappingModels[0].segment;
  const trackerDuration = segmentDuration(segment);
  const modelDuration = segmentDuration(modelSegment);
  const overlapSec = segmentOverlapSec(segment, modelSegment);
  if (trackerDuration <= 0 || modelDuration <= 0 || overlapSec / trackerDuration < 0.65) return segment;

  let startSec = segment.startSec;
  let endSec = segment.endSec;
  if (
    modelSegment.startSec - segment.startSec > MODEL_RUN_SEGMENT_RULES.suspiciousStartOverrunSec
    && edgeLooksNonSong(analyses, segment.startSec, modelSegment.startSec)
  ) {
    startSec = modelSegment.startSec;
  }
  if (
    segment.endSec - modelSegment.endSec > MODEL_RUN_SEGMENT_RULES.suspiciousTailOverrunSec
    && edgeLooksNonSong(analyses, modelSegment.endSec, segment.endSec)
  ) {
    endSec = modelSegment.endSec;
  }

  return {
    ...segment,
    startSec,
    endSec: Math.max(startSec, endSec),
  };
}

function buildSelectiveModelFallbackSegments(trackerSegments, modelRunSegments, analyses, startSec, endSec, options = {}) {
  if (!modelRunSegments.length) {
    return { segments: trackerSegments, selectedFallbackSegments: [], changed: false };
  }
  if (!trackerSegments.length) {
    return {
      segments: modelRunSegments,
      selectedFallbackSegments: modelRunSegments,
      changed: Boolean(modelRunSegments.length),
    };
  }

  const analyzedDuration = Math.max(1, endSec - startSec);
  const output = [];
  const selectedFallbackSegments = [];
  const droppedTrackerSegments = [];

  for (const trackerSegment of trackerSegments) {
    const overlapping = findOverlappingModelSegments(trackerSegment, modelRunSegments);
    const trackerIsGiant = segmentDuration(trackerSegment) / analyzedDuration >= MODEL_RUN_SEGMENT_RULES.suspiciousCoverageRatio;

    if (trackerIsGiant && overlapping.length >= 2) {
      output.push(...overlapping.map(({ segment }) => segment));
      selectedFallbackSegments.push(...overlapping.map(({ segment }) => segment));
      continue;
    }

    const support = summarizeSegmentModelSupport(analyses, trackerSegment);
    if (!overlapping.length && shouldDropUnsupportedTrackerSegment(trackerSegment, support)) {
      droppedTrackerSegments.push({ ...trackerSegment, support });
      continue;
    }

    output.push(refineTrackerSegmentWithModelEdges(trackerSegment, overlapping, analyses));
  }

  for (const modelSegment of modelRunSegments) {
    const overlapsOutput = output.some((segment) => {
      const overlapSec = segmentOverlapSec(segment, modelSegment);
      return overlapSec >= MODEL_RUN_SEGMENT_RULES.selectiveFallbackMinOverlapSec
        || overlapSec / Math.max(1, segmentDuration(modelSegment)) >= MODEL_RUN_SEGMENT_RULES.selectiveFallbackMinOverlapRatio;
    });
    if (!overlapsOutput) {
      output.push(modelSegment);
      selectedFallbackSegments.push(modelSegment);
    }
  }

  const segments = mergeSegments(output, {
    maxGapSec: GLOBAL_TRACKER_CONFIG.mergeGapSec,
    minSegmentDurationSec: resolveMinSegmentDurationSec(options.minSegmentDurationSec),
  }).map((segment) => normalizeOutputSegment(segment));

  const changed = selectedFallbackSegments.length > 0
    || droppedTrackerSegments.length > 0
    || segments.length !== trackerSegments.length
    || segments.some((segment, index) => {
      const original = trackerSegments[index];
      return !original
        || Math.abs(segment.startSec - original.startSec) > 0.001
        || Math.abs(segment.endSec - original.endSec) > 0.001;
    });

  return { segments, selectedFallbackSegments, droppedTrackerSegments, changed };
}

function buildFallbackSegmentsFromDecisions(decisions, endSec, options = {}) {
  if (!Array.isArray(decisions) || !decisions.length) return [];
  const segments = [];
  let active = null;
  let lowCount = 0;

  for (const decision of decisions) {
    const positive = decision.hasSingingAnchor
      || (decision.hasRecentAnchor && decision.hasMusicSustain && !decision.speechDominant);
    if (positive) {
      if (!active) {
        active = {
          startSec: Number.isFinite(Number(decision.startSecOverride)) ? Number(decision.startSecOverride) : decision.timeSec,
          endSec: decision.timeSec,
          confidenceTotal: 0,
          confidenceCount: 0,
        };
      }
      active.endSec = decision.timeSec + GLOBAL_SMOOTHING_HOP_SEC;
      active.confidenceTotal += clamp(Number(decision.confidence) || Number(decision.modelProbability) || 0.5, 0, 1);
      active.confidenceCount += 1;
      lowCount = 0;
    } else if (active) {
      lowCount += 1;
      if (lowCount >= GLOBAL_TRACKER_CONFIG.tailEndRequiredWindows) {
        segments.push({
          startSec: active.startSec,
          endSec: Math.min(endSec, active.endSec + GLOBAL_TRACKER_CONFIG.tailPaddingSec),
          confidence: active.confidenceTotal / Math.max(1, active.confidenceCount),
        });
        active = null;
        lowCount = 0;
      }
    }
  }

  if (active) {
    segments.push({
      startSec: active.startSec,
      endSec: Math.min(endSec, active.endSec + GLOBAL_TRACKER_CONFIG.tailPaddingSec),
      confidence: active.confidenceTotal / Math.max(1, active.confidenceCount),
    });
  }
  return mergeSegments(segments, {
    maxGapSec: GLOBAL_TRACKER_CONFIG.mergeGapSec,
    minSegmentDurationSec: resolveMinSegmentDurationSec(options.minSegmentDurationSec),
  }).map((segment) => normalizeOutputSegment(segment));
}

function normalizeOutputSegment(segment) {
  const startSec = Math.max(0, Number(segment.startSec) || 0);
  const endSec = Math.max(startSec, Number(segment.endSec) || startSec);
  return {
    startSec: roundNumber(startSec, 3),
    endSec: roundNumber(endSec, 3),
    confidence: roundNumber(clamp(Number(segment.confidence) || 0, 0, 1), 3),
    provisional: false,
  };
}

export function runDecisionTrackerSegments(analyses, endSec, options = {}) {
  const normalizedAnalyses = normalizeAnalysisFrames(analyses).filter((analysis) => analysis.ready);
  const segmentTracker = new EventSegmentTracker({
    ...GLOBAL_TRACKER_CONFIG,
    minSegmentDurationSec: resolveMinSegmentDurationSec(options.minSegmentDurationSec),
  });
  const decisionSession = {
    history: [],
    decisions: [],
    lastSingingAnchorSec: null,
    segmentTracker,
  };

  for (const analysis of normalizedAnalyses) {
    segmentTracker.update(analysis.timeSec, applyDecision(decisionSession, analysis.timeSec, analysis));
  }
  segmentTracker.finalizeAt(endSec);

  return {
    segments: segmentTracker.getFinalSegments().map((segment) => normalizeOutputSegment(segment)),
    decisions: decisionSession.decisions,
  };
}

export function smoothFireRedAnalyses(analyses, endSec, { startSec = null, minSegmentDurationSec = null } = {}) {
  const normalizedAnalyses = normalizeAnalysisFrames(analyses).filter((analysis) => analysis.ready);
  if (!normalizedAnalyses.length) {
    return {
      segments: [],
      trackerSegments: [],
      modelRunSegments: [],
      fallbackSegments: [],
      excludedMusicOnlySpans: [],
      droppedMusicOnlySegments: [],
      method: 'empty',
      smoothingVersion: GLOBAL_SMOOTHING_VERSION,
    };
  }

  const effectiveStartSec = Number.isFinite(Number(startSec))
    ? Number(startSec)
    : normalizedAnalyses[0].timeSec;
  const effectiveEndSec = Math.max(
    effectiveStartSec,
    Number.isFinite(Number(endSec))
      ? Number(endSec)
      : normalizedAnalyses[normalizedAnalyses.length - 1].timeSec
  );

  const resolvedMinSegmentDurationSec = resolveMinSegmentDurationSec(minSegmentDurationSec);
  const trackerResult = runDecisionTrackerSegments(normalizedAnalyses, effectiveEndSec, {
    minSegmentDurationSec: resolvedMinSegmentDurationSec,
  });
  const modelRunSegments = buildModelRunSegmentsFromAnalyses(normalizedAnalyses, effectiveEndSec);
  let segments = trackerResult.segments;
  let method = 'event-tracker';
  let fallbackSegments = [];
  let selectedModelFallbackSegments = [];
  let droppedTrackerSegments = [];
  let excludedMusicOnlySpans = [];
  let droppedMusicOnlySegments = [];

  if (!segments.length) {
    fallbackSegments = buildFallbackSegmentsFromDecisions(trackerResult.decisions, effectiveEndSec, {
      minSegmentDurationSec: resolvedMinSegmentDurationSec,
    });
    if (fallbackSegments.length) {
      segments = fallbackSegments;
      method = 'decision-fallback';
    }
  }

  const selectiveFallback = buildSelectiveModelFallbackSegments(
    segments,
    modelRunSegments,
    normalizedAnalyses,
    effectiveStartSec,
    effectiveEndSec,
    { minSegmentDurationSec: resolvedMinSegmentDurationSec }
  );
  if (selectiveFallback.changed) {
    segments = selectiveFallback.segments;
    selectedModelFallbackSegments = selectiveFallback.selectedFallbackSegments;
    droppedTrackerSegments = selectiveFallback.droppedTrackerSegments || [];
    method = method === 'event-tracker'
      ? 'event-tracker+selective-model-run'
      : `${method}+selective-model-run`;
  }

  const musicOnlyExclusion = applyLongMusicOnlyExclusion(
    segments,
    normalizedAnalyses,
    effectiveStartSec,
    effectiveEndSec
  );
  excludedMusicOnlySpans = musicOnlyExclusion.excludedMusicOnlySpans || [];
  droppedMusicOnlySegments = musicOnlyExclusion.droppedMusicOnlySegments || [];
  if (musicOnlyExclusion.changed) {
    segments = musicOnlyExclusion.segments;
    method = `${method}+long-music-only-drop`;
  }

  return {
    segments,
    trackerSegments: trackerResult.segments,
    modelRunSegments,
    fallbackSegments,
    selectedModelFallbackSegments,
    droppedTrackerSegments,
    excludedMusicOnlySpans,
    droppedMusicOnlySegments,
    method,
    minSegmentDurationSec: resolvedMinSegmentDurationSec,
    smoothingVersion: GLOBAL_SMOOTHING_VERSION,
  };
}
