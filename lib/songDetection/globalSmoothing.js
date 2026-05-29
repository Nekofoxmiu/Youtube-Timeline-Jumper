import { EventSegmentTracker } from './eventSegmentTracker.js';
import { clamp, roundNumber } from './common.js';
import { applySegmentFilterPredictions } from './segmentFilter.js';
import { normalizeAnalysisFrames as normalizeCanonicalAnalysisFrames } from './analysisFrame.js';
import { estimateMusicRepetition } from './musicRepetition.js';

export const GLOBAL_SMOOTHING_VERSION = 'firered-global-smoothing-v3';
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
  unsupportedMusicOnlyMaxDurationSec: 180,
  unsupportedMusicOnlyMinMusicMean: 0.75,
  unsupportedMusicOnlyMaxSingingMedian: 0.55,
  unsupportedMusicOnlyMaxSingingMean: 0.48,
  unsupportedMusicOnlyMaxSpeechMean: 0.3,
  standaloneModelFallbackMinConfidence: 0.985,
  standaloneModelFallbackMinDurationSec: 120,
  musicOnlyDropMinOverlapRatio: 0.65,
  musicOnlyDropMinOverlapSec: 60,
  musicOnlyWeakHeadDropMinOverlapSec: 45,
  musicOnlyWeakHeadDropMaxDurationSec: 180,
  musicOnlyWeakHeadDropMaxStartAfterSpanSec: 8,
  musicOnlyWeakHeadDropMaxModelRatio: 0.22,
  musicOnlyWeakHeadDropMinMusicMean: 0.72,
  musicOnlyWeakHeadDropMaxSingingMedian: 0.3,
  musicOnlyWeakHeadDropMaxSingingMean: 0.42,
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
  musicOnlyClusterMaxGapSec: 45,
  musicOnlyClusterMinSegmentDurationSec: 30,
  musicOnlyClusterMinTotalDurationSec: 180,
  musicOnlyClusterMinSpanDurationSec: 210,
  musicOnlyClusterMinCandidateRatio: 0.68,
  musicOnlyClusterMinMusicMean: 0.54,
  musicOnlyClusterMinMusicP80: 0.62,
  musicOnlyClusterMaxSingingMean: 0.24,
  musicOnlyClusterMaxSingingP90: 0.42,
  musicOnlyClusterMaxSingingRatioMean: 0.1,
  musicOnlyClusterMaxSpeechMean: 0.34,
  musicOnlyClusterMaxSpeechP90: 0.58,
  musicOnlyClusterMaxSpeechRatioMean: 0.16,
  repetitiveMusicDropMinDurationSec: 90,
  repetitiveMusicDropMinScore: 0.66,
  repetitiveMusicDropMinMatchedWindows: 3,
  repetitiveMusicDropMinMusicOnlyWindowRatio: 0.42,
  repetitiveMusicDropMaxVocalWindowRatio: 0.28,
  repetitiveMusicDropMaxSingingMean: 0.3,
  repetitiveMusicDropMaxSingingP90: 0.55,
  repetitiveMusicDropMaxTemporalMean: 0.42,
  repetitiveMusicDropMaxSpeechMean: 0.45,
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
  continuousMusicStartLookbackSec: 24,
  vocalSingingThreshold: 0.72,
  vocalSingingMeanThreshold: 0.35,
  vocalSingingRatioThreshold: 0.12,
  edgeRefineWindowSec: 90,
  edgeRefineMinOverrunSec: 8,
  postSongNonMusicRatio: 0.62,
  speechNoMusicThreshold: 0.62,
  speechResetThreshold: 0.7,
  speechResetLowSingingCeiling: 0.38,
  speechResetMusicCeiling: 0.58,
  noiseResetLowSingingCeiling: 0.36,
  noiseResetMusicCeiling: 0.52,
  tailResetMinDurationSec: 4,
  tailResetPaddingSec: 0.8,
  noiseFlatnessThreshold: 0.58,
  noiseFluxThreshold: 0.72,
  musicContinuityThreshold: 0.55,
  spectralMusicFlatnessCeiling: 0.46,
  spectralMusicMidRatioFloor: 0.42,
  fragmentedStartMinResetRatio: 0.25,
  fragmentedStartMaxContinuousMusicSec: 20,
  fragmentedStartMaxBurstSec: 18,
  fragmentedStartMinBurstCount: 2,
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

export const DEFAULT_SMOOTHING_PROFILE = 'offline-final';

function freezeSmoothingProfile({
  tracker = {},
  modelRun = {},
  decision = {},
} = {}) {
  return Object.freeze({
    tracker: Object.freeze({ ...GLOBAL_TRACKER_CONFIG, ...tracker }),
    modelRun: Object.freeze({ ...MODEL_RUN_SEGMENT_RULES, ...modelRun }),
    decision: Object.freeze({ ...DECISION_RULES, ...decision }),
  });
}

// Keep profile overrides explicit even when the current values intentionally
// match. Future tuning must update one profile at a time and pass its own gate.
const OFFLINE_FINAL_SMOOTHING_OVERRIDES = Object.freeze({
  tracker: Object.freeze({}),
  modelRun: Object.freeze({}),
  decision: Object.freeze({}),
});

const LIVE_PCM30_SMOOTHING_OVERRIDES = Object.freeze({
  tracker: Object.freeze({}),
  modelRun: Object.freeze({}),
  decision: Object.freeze({}),
});

const LIVE_REALTIME_AED60_SMOOTHING_OVERRIDES = Object.freeze({
  tracker: Object.freeze({}),
  modelRun: Object.freeze({}),
  decision: Object.freeze({}),
});

export const SMOOTHING_PROFILES = Object.freeze({
  'offline-final': freezeSmoothingProfile(OFFLINE_FINAL_SMOOTHING_OVERRIDES),
  'live-pcm30': freezeSmoothingProfile(LIVE_PCM30_SMOOTHING_OVERRIDES),
  'live-realtime-aed60': freezeSmoothingProfile(LIVE_REALTIME_AED60_SMOOTHING_OVERRIDES),
});

export function getSmoothingProfileAuditSnapshot() {
  return Object.fromEntries(Object.entries(SMOOTHING_PROFILES).map(([profile, rules]) => [
    profile,
    {
      trackerKeys: Object.keys(rules.tracker).sort(),
      modelRunKeys: Object.keys(rules.modelRun).sort(),
      decisionKeys: Object.keys(rules.decision).sort(),
      minSegmentDurationSec: rules.tracker.minSegmentDurationSec,
      modelRunMinSegmentDurationSec: rules.modelRun.minSegmentDurationSec,
      decisionHistoryWindowSec: rules.decision.historyWindowSec,
    },
  ]));
}

export function resolveSmoothingProfile(value, fallback = DEFAULT_SMOOTHING_PROFILE) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'pcm-rollover-30min') return 'live-pcm30';
  if (key === 'aed-cache-60s') return 'live-realtime-aed60';
  if (Object.prototype.hasOwnProperty.call(SMOOTHING_PROFILES, key)) return key;
  return Object.prototype.hasOwnProperty.call(SMOOTHING_PROFILES, fallback)
    ? fallback
    : DEFAULT_SMOOTHING_PROFILE;
}

let activeSmoothingProfile = DEFAULT_SMOOTHING_PROFILE;
let activeSmoothingRules = SMOOTHING_PROFILES[DEFAULT_SMOOTHING_PROFILE];

function getTrackerConfig() {
  return activeSmoothingRules?.tracker || SMOOTHING_PROFILES[DEFAULT_SMOOTHING_PROFILE].tracker;
}

function getModelRunRules() {
  return activeSmoothingRules?.modelRun || SMOOTHING_PROFILES[DEFAULT_SMOOTHING_PROFILE].modelRun;
}

function getDecisionRules() {
  return activeSmoothingRules?.decision || SMOOTHING_PROFILES[DEFAULT_SMOOTHING_PROFILE].decision;
}

function withSmoothingProfile(profile, callback) {
  const nextProfile = resolveSmoothingProfile(profile);
  const previousProfile = activeSmoothingProfile;
  const previousRules = activeSmoothingRules;
  activeSmoothingProfile = nextProfile;
  activeSmoothingRules = SMOOTHING_PROFILES[nextProfile];
  try {
    return callback(nextProfile);
  } finally {
    activeSmoothingProfile = previousProfile;
    activeSmoothingRules = previousRules;
  }
}

function toFiniteNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveMinSegmentDurationSec(value, fallback = getTrackerConfig().minSegmentDurationSec) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return clamp(Math.round(num), 15, 600);
}

export function normalizeAnalysisFrames(frames) {
  return normalizeCanonicalAnalysisFrames(frames);
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
    if (now - frame.timeSec > getDecisionRules().mediumWindowSec) break;
    if (frame.singing >= getDecisionRules().singingPresentThreshold || frame.model >= frame.thresholds.start) {
      anchorIndex = index;
      break;
    }
  }
  if (anchorIndex < 0) return null;

  let startSec = history[anchorIndex].timeSec;
  let gapSec = 0;
  for (let index = anchorIndex; index >= 0; index -= 1) {
    const frame = history[index];
    if (now - frame.timeSec > getDecisionRules().introLookbackSec) break;
    const musicLike = frame.music >= 0.55 || frame.model >= frame.thresholds.end;
    const singingLike = frame.singing >= 0.5 || frame.model >= frame.thresholds.start;
    const speechDominant = frame.speech >= 0.68 && frame.singing < 0.28;
    if (speechDominant) break;

    if (musicLike || singingLike) {
      startSec = frame.timeSec;
      gapSec = 0;
    } else {
      gapSec += GLOBAL_SMOOTHING_HOP_SEC;
      if (gapSec > getDecisionRules().introGapToleranceSec) break;
    }
  }
  return Math.max(0, startSec);
}

function isSilentFrame(analysis) {
  const rms = Number(analysis.audioRms);
  const peak = Number(analysis.audioPeak);
  if (!Number.isFinite(rms) || !Number.isFinite(peak)) return false;
  return rms <= getModelRunRules().silenceRmsThreshold
    && peak <= getModelRunRules().silencePeakThreshold;
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
  session.history = session.history.filter((item) => item.timeSec >= timeSec - getDecisionRules().historyWindowSec);

  const shortStats = summarizeHistory(session.history, timeSec, getDecisionRules().shortWindowSec);
  const mediumStats = summarizeHistory(session.history, timeSec, getDecisionRules().mediumWindowSec);
  const trackerIsSong = Boolean(session.segmentTracker?.isSong);
  const silentFrame = isSilentFrame(analysis);
  const speechDominant = silentFrame || (
    mediumStats.speechMean >= getDecisionRules().speechDominantThreshold
    && shortStats.singingMean < getDecisionRules().speechLowSingingCeiling
  );
  const hasAcousticSingingAnchor = !speechDominant && (
    shortStats.singingMax >= getDecisionRules().singingPresentThreshold
    || shortStats.singingMean >= getDecisionRules().singingMeanShortThreshold
    || mediumStats.singingMean >= getDecisionRules().singingMeanMediumThreshold
  );
  const hasAcousticMusicSustain = !silentFrame && (
    shortStats.musicMax >= getDecisionRules().musicPresentThreshold
    || mediumStats.musicMean >= getDecisionRules().musicMeanMediumThreshold
  );
  const hasModelAnchor = temporalHeadReady && temporalHeadProbability >= thresholds.start && !speechDominant;
  const hasModelSustain = !silentFrame && temporalHeadReady && temporalHeadProbability >= thresholds.end && !speechDominant;
  const hasSingingAnchor = hasAcousticSingingAnchor || hasModelAnchor;
  const hasMusicSustain = hasAcousticMusicSustain || hasModelSustain;

  if (hasSingingAnchor) session.lastSingingAnchorSec = timeSec;
  const hasRecentAnchor = Number.isFinite(session.lastSingingAnchorSec)
    && timeSec - session.lastSingingAnchorSec <= getDecisionRules().anchorGraceSec;

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
  maxGapSec = getTrackerConfig().mergeGapSec,
  minSegmentDurationSec = getTrackerConfig().minSegmentDurationSec,
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
  return (Number(analysis.singingProbability) || 0) >= getModelRunRules().vocalSingingThreshold
    || (Number(analysis.singingMean) || 0) >= getModelRunRules().vocalSingingMeanThreshold
    || (Number(analysis.singingRatio) || 0) >= getModelRunRules().vocalSingingRatioThreshold;
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
  if (vocalFrame && rms > getModelRunRules().silenceRmsThreshold * 1.5) {
    pushLimited(active.vocalRmsSamples, rms);
    pushLimited(active.vocalPeakSamples, peak);
  }
}

function getActiveEnergyReference(active) {
  const rmsSamples = active.vocalRmsSamples.filter((value) => value > getModelRunRules().silenceRmsThreshold * 1.5);
  if (rmsSamples.length < 3) return null;
  const peakSamples = active.vocalPeakSamples.filter((value) => value > getModelRunRules().silencePeakThreshold);
  return {
    rms: median(rmsSamples),
    peak: median(peakSamples.length ? peakSamples : active.vocalPeakSamples),
  };
}

function getRecentEnergyStats(active, now) {
  const frames = active.energyFrames.filter((frame) => now - frame.timeSec <= getModelRunRules().energyTailLookbackSec);
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
  const rmsFloor = Math.max(getModelRunRules().silenceRmsThreshold * 1.25, reference.rms * getModelRunRules().energyDropRatio);
  const peakFloor = Math.max(getModelRunRules().silencePeakThreshold * 1.1, reference.peak * getModelRunRules().energyPeakDropRatio);
  const energyDrop = recent.meanRms <= rmsFloor && recent.meanPeak <= peakFloor;
  const lowFlatEnergy = recent.meanRms <= reference.rms * getModelRunRules().lowRegularityEnergyRatio
    && recent.rmsCv <= getModelRunRules().lowRegularityCvThreshold;
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
      getModelRunRules().silenceRmsThreshold * 1.25,
      noiseRms * getModelRunRules().startNoiseMultiplier,
      anchorRms * getModelRunRules().startEnergyRatio
    ),
    peak: Math.max(
      getModelRunRules().silencePeakThreshold * 1.05,
      noisePeak * getModelRunRules().startNoiseMultiplier,
      anchorPeak * getModelRunRules().startPeakRatio
    ),
  };
}

function isAdaptiveStartFrame(analysis, reference, anchorTimeSec) {
  if (!reference || isSilentFrame(analysis)) return false;
  const energyActive = getAnalysisRms(analysis) >= reference.rms
    || getAnalysisPeak(analysis) >= reference.peak;
  if (!energyActive) return false;
  if (isMusicLikeFrame(analysis)) return true;

  const nearAnchor = anchorTimeSec - analysis.timeSec <= getModelRunRules().startEnergyOnlyWindowSec;
  const speechLow = (Number(analysis.speechProbability) || 0) < 0.62
    && (Number(analysis.speechMean) || 0) < 0.42;
  return nearAnchor && speechLow;
}

function findAdaptiveStartSec(preRollFrames, anchorAnalysis) {
  const fallbackStart = Math.max(0, anchorAnalysis.timeSec - GLOBAL_SMOOTHING_HOP_SEC - getModelRunRules().introPaddingSec);
  const minTimeSec = Math.max(0, anchorAnalysis.timeSec - getModelRunRules().startLookbackSec);
  const frames = preRollFrames
    .filter((frame) => frame.timeSec >= minTimeSec && frame.timeSec <= anchorAnalysis.timeSec)
    .sort((a, b) => a.timeSec - b.timeSec);
  if (frames.length < 2) return fallbackStart;

  const reference = estimateStartEnergyReference(frames, anchorAnalysis.timeSec);
  if (!reference) return fallbackStart;

  let earliest = anchorAnalysis.timeSec;
  let gapSec = 0;
  let stoppedByGap = false;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (isAdaptiveStartFrame(frame, reference, anchorAnalysis.timeSec)) {
      earliest = Math.max(0, frame.timeSec - GLOBAL_SMOOTHING_HOP_SEC);
      gapSec = 0;
      continue;
    }

    gapSec += GLOBAL_SMOOTHING_HOP_SEC;
    if (gapSec > getModelRunRules().startGapToleranceSec) {
      stoppedByGap = true;
      break;
    }
  }

  if (!stoppedByGap && anchorAnalysis.timeSec - earliest > getModelRunRules().continuousMusicStartLookbackSec) {
    earliest = Math.max(0, anchorAnalysis.timeSec - getModelRunRules().continuousMusicStartLookbackSec);
  }

  const runDuration = anchorAnalysis.timeSec - earliest;
  if (runDuration < getModelRunRules().startMinRunSec) return fallbackStart;
  return Math.max(0, earliest - getModelRunRules().startPaddingSec);
}

function finalizeModelRunSegment(active, endSec, endSecOverride = null) {
  const anchorEndSec = Number.isFinite(active.lastVocalSec) ? active.lastVocalSec : active.lastPositiveSec;
  const boundedEndSec = Number.isFinite(Number(endSecOverride))
    ? Number(endSecOverride)
    : anchorEndSec + getModelRunRules().tailPaddingSec;
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
  const maxPreRollFrames = Math.max(1, Math.round(getModelRunRules().preRollSec / GLOBAL_SMOOTHING_HOP_SEC));

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
          ? getModelRunRules().silenceMinDurationSec
          : getModelRunRules().energyDropMinDurationSec;
        const paddingSec = silentFrame
          ? getModelRunRules().silenceEndPaddingSec
          : getModelRunRules().energyEndPaddingSec;
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
      if (Number.isFinite(active.lastVocalSec) && analysis.timeSec - active.lastVocalSec > getModelRunRules().maxModelOnlyTailSec) {
        segments.push(finalizeModelRunSegment(active, endSec));
        active = null;
      }
    } else if (active) {
      if (!Number.isFinite(active.modelDropStartSec)) {
        active.modelDropStartSec = analysis.timeSec;
      }
      if (analysis.timeSec - active.modelDropStartSec <= getModelRunRules().modelDropMaxGapSec) {
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
    maxGapSec: getModelRunRules().mergeGapSec,
    minSegmentDurationSec: getModelRunRules().minSegmentDurationSec,
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
      return overlapSec >= getModelRunRules().selectiveFallbackMinOverlapSec
        || overlapSec / modelDuration >= getModelRunRules().selectiveFallbackMinOverlapRatio;
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
  if (frames.length < getModelRunRules().edgeTrimMinFrames) return false;
  const nonSongCount = frames.filter(isNonSongEdgeFrame).length;
  return nonSongCount / frames.length >= getModelRunRules().edgeTrimNonSongRatio;
}

function summarizeSegmentModelSupport(analyses, segment) {
  const frames = analyses.filter((analysis) => analysis.timeSec >= segment.startSec && analysis.timeSec < segment.endSec);
  if (!frames.length) {
    return {
      frameCount: 0,
      modelAboveRatio: 0,
      singingMedian: 0,
      singingMean: 0,
      musicMean: 0,
      speechMean: 0,
    };
  }
  const modelAboveCount = frames.filter((analysis) => {
    const thresholds = resolveTrackerThresholds(analysis);
    const modelProbability = Number(analysis.temporalHeadProbability ?? analysis.songProbability) || 0;
    return analysis.temporalHeadReady && modelProbability >= thresholds.start;
  }).length;
  const singingValues = frames.map((analysis) => Number(analysis.singingProbability ?? analysis.singingMean) || 0);
  const musicValues = frames.map(frameMusicValue);
  const speechValues = frames.map(frameSpeechValue);
  return {
    frameCount: frames.length,
    modelAboveRatio: modelAboveCount / frames.length,
    singingMedian: median(singingValues),
    singingMean: mean(singingValues),
    musicMean: mean(musicValues),
    speechMean: mean(speechValues),
  };
}

function shouldDropUnsupportedTrackerSegment(segment, support) {
  if (support.frameCount < getModelRunRules().unsupportedTrackerMinFrames) return false;
  const weakModel = support.modelAboveRatio < getModelRunRules().unsupportedTrackerMaxModelRatio;
  const weakVocal = support.singingMedian < getModelRunRules().unsupportedTrackerMinSingingMedian
    && support.singingMean < getModelRunRules().unsupportedTrackerMinSingingMean;
  const durationSec = segmentDuration(segment);
  const unsupportedByWeakModel = weakModel
    && weakVocal
    && durationSec < getModelRunRules().maxModelOnlyTailSec * 5;
  const unsupportedMusicOnly = durationSec <= getModelRunRules().unsupportedMusicOnlyMaxDurationSec
    && support.musicMean >= getModelRunRules().unsupportedMusicOnlyMinMusicMean
    && support.singingMedian <= getModelRunRules().unsupportedMusicOnlyMaxSingingMedian
    && support.singingMean <= getModelRunRules().unsupportedMusicOnlyMaxSingingMean
    && support.speechMean <= getModelRunRules().unsupportedMusicOnlyMaxSpeechMean;
  return unsupportedByWeakModel || unsupportedMusicOnly;
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

function frameModelValue(analysis) {
  return clamp(Number(analysis?.temporalHeadProbability ?? analysis?.songProbability) || 0, 0, 1);
}

function hasSpectralMusicContinuity(analysis) {
  if (!analysis) return false;
  const flatness = Number(analysis.spectralFlatness) || 0;
  const midRatio = Number(analysis.midEnergyRatio) || 0;
  const flux = Number(analysis.spectralFlux) || 0;
  return midRatio >= getModelRunRules().spectralMusicMidRatioFloor
    && flatness > 0
    && flatness <= getModelRunRules().spectralMusicFlatnessCeiling
    && flux <= getModelRunRules().noiseFluxThreshold;
}

function hasAcousticMusicContinuity(analysis) {
  return isVocalFrame(analysis)
    || frameMusicValue(analysis) >= getModelRunRules().musicContinuityThreshold
    || hasSpectralMusicContinuity(analysis);
}

function isSpeechResetFrame(analysis) {
  if (!analysis || isSilentFrame(analysis)) return false;
  return frameSpeechValue(analysis) >= getModelRunRules().speechResetThreshold
    && frameSingingValue(analysis) < getModelRunRules().speechResetLowSingingCeiling
    && frameMusicValue(analysis) < getModelRunRules().speechResetMusicCeiling
    && !hasSpectralMusicContinuity(analysis);
}

function isNoiseResetFrame(analysis) {
  if (!analysis || isSilentFrame(analysis)) return false;
  const flatness = Number(analysis.spectralFlatness) || 0;
  const flux = Number(analysis.spectralFlux) || 0;
  const highRatio = Number(analysis.highEnergyRatio) || 0;
  const lowSinging = frameSingingValue(analysis) < getModelRunRules().noiseResetLowSingingCeiling;
  const lowMusic = frameMusicValue(analysis) < getModelRunRules().noiseResetMusicCeiling
    && !hasSpectralMusicContinuity(analysis);
  return lowSinging && lowMusic && (
    flatness >= getModelRunRules().noiseFlatnessThreshold
    || (flux >= getModelRunRules().noiseFluxThreshold && highRatio >= 0.22)
  );
}

function isHardResetFrame(analysis) {
  return isSilentFrame(analysis)
    || isSpeechResetFrame(analysis);
}

function hasMusicContinuity(analysis) {
  if (!analysis || isSilentFrame(analysis)) return false;
  if (isSpeechResetFrame(analysis) || isNoiseResetFrame(analysis)) return false;
  const thresholds = resolveTrackerThresholds(analysis);
  const acousticContinuity = hasAcousticMusicContinuity(analysis);
  return acousticContinuity || (
    frameModelValue(analysis) >= thresholds.end
    && (
      frameMusicValue(analysis) >= getModelRunRules().speechResetMusicCeiling
      || frameSingingValue(analysis) >= getModelRunRules().speechResetLowSingingCeiling
      || hasSpectralMusicContinuity(analysis)
    )
  );
}

function isSpeechWithoutMusicContinuity(analysis) {
  if (!analysis || hasMusicContinuity(analysis)) return false;
  return isSpeechResetFrame(analysis)
    || (frameSpeechValue(analysis) >= getModelRunRules().speechNoMusicThreshold
      && frameSingingValue(analysis) < 0.36);
}

function isNoiseWithoutMusicContinuity(analysis) {
  if (!analysis || hasMusicContinuity(analysis)) return false;
  if (isNoiseResetFrame(analysis)) return true;
  const flatness = Number(analysis.spectralFlatness) || 0;
  const flux = Number(analysis.spectralFlux) || 0;
  const highRatio = Number(analysis.highEnergyRatio) || 0;
  return (flatness >= getModelRunRules().noiseFlatnessThreshold && frameMusicValue(analysis) < 0.5)
    || (flux >= getModelRunRules().noiseFluxThreshold && highRatio >= 0.22 && frameSingingValue(analysis) < 0.36);
}

function isLowConfidenceSpeechWithoutMusicContinuity(analysis) {
  if (!analysis || hasMusicContinuity(analysis)) return false;
  return frameSpeechValue(analysis) >= 0.38
    && frameSingingValue(analysis) < 0.32
    && frameMusicValue(analysis) < getModelRunRules().speechResetMusicCeiling
    && !hasSpectralMusicContinuity(analysis);
}

function isPostSongNonMusicFrame(analysis) {
  return isHardResetFrame(analysis)
    || isSpeechWithoutMusicContinuity(analysis)
    || isLowConfidenceSpeechWithoutMusicContinuity(analysis);
}

function summarizeContinuityRuns(frames, predicate) {
  let count = 0;
  let currentDurationSec = 0;
  let totalDurationSec = 0;
  let maxDurationSec = 0;
  for (const frame of frames) {
    if (predicate(frame)) {
      currentDurationSec += GLOBAL_SMOOTHING_HOP_SEC;
      totalDurationSec += GLOBAL_SMOOTHING_HOP_SEC;
      maxDurationSec = Math.max(maxDurationSec, currentDurationSec);
      continue;
    }
    if (currentDurationSec > 0) count += 1;
    currentDurationSec = 0;
  }
  if (currentDurationSec > 0) count += 1;
  return { count, totalDurationSec, maxDurationSec };
}

function findSustainedResetStartSec(frames, minDurationSec) {
  let runStartSec = null;
  for (const frame of frames) {
    if (isPostSongNonMusicFrame(frame)) {
      if (!Number.isFinite(runStartSec)) {
        runStartSec = Math.max(0, frame.timeSec - GLOBAL_SMOOTHING_HOP_SEC);
      }
      if (frame.timeSec - runStartSec >= minDurationSec) return runStartSec;
      continue;
    }
    runStartSec = null;
  }
  return null;
}

function summarizeMusicPropertyChange(songFrames, edgeFrames) {
  if (!songFrames.length || !edgeFrames.length) {
    return { pass: false, reason: 'insufficient-frames' };
  }
  const songMusicMean = mean(songFrames.map(frameMusicValue));
  const edgeMusicMean = mean(edgeFrames.map(frameMusicValue));
  const songSingingMean = mean(songFrames.map(frameSingingValue));
  const edgeSingingMean = mean(edgeFrames.map(frameSingingValue));
  const songModelMean = mean(songFrames.map(frameModelValue));
  const edgeModelMean = mean(edgeFrames.map(frameModelValue));
  const songRmsMean = mean(songFrames.map(getAnalysisRms));
  const edgeRmsMean = mean(edgeFrames.map(getAnalysisRms));
  const songFlatnessMean = mean(songFrames.map((frame) => Number(frame.spectralFlatness) || 0));
  const edgeFlatnessMean = mean(edgeFrames.map((frame) => Number(frame.spectralFlatness) || 0));
  const songFluxMean = mean(songFrames.map((frame) => Number(frame.spectralFlux) || 0));
  const edgeFluxMean = mean(edgeFrames.map((frame) => Number(frame.spectralFlux) || 0));
  const songSideStrong = songMusicMean >= 0.55 || songSingingMean >= 0.42 || songModelMean >= 0.55;
  const edgeSideWeak = edgeMusicMean <= 0.48 && edgeSingingMean <= 0.34 && edgeModelMean <= 0.5;
  const probabilityChange = Math.max(
    Math.abs(songMusicMean - edgeMusicMean),
    Math.abs(songSingingMean - edgeSingingMean),
    Math.abs(songModelMean - edgeModelMean)
  );
  const spectralChange = Math.max(
    Math.abs(songFlatnessMean - edgeFlatnessMean),
    Math.abs(songFluxMean - edgeFluxMean)
  );
  const energyChange = Math.abs(songRmsMean - edgeRmsMean) / Math.max(0.01, songRmsMean, edgeRmsMean);
  const pass = songSideStrong
    && edgeSideWeak
    && Math.max(probabilityChange, spectralChange, energyChange * 0.5) >= 0.28;
  return {
    pass,
    reason: pass ? 'music-property-change' : 'ambiguous-non-music-edge',
    songMusicMean: roundNumber(songMusicMean, 3),
    edgeMusicMean: roundNumber(edgeMusicMean, 3),
    songSingingMean: roundNumber(songSingingMean, 3),
    edgeSingingMean: roundNumber(edgeSingingMean, 3),
    songModelMean: roundNumber(songModelMean, 3),
    edgeModelMean: roundNumber(edgeModelMean, 3),
    probabilityChange: roundNumber(probabilityChange, 3),
    spectralChange: roundNumber(spectralChange, 3),
    energyChange: roundNumber(energyChange, 3),
  };
}

function trimSegmentTailWithSpectralCues(segment, analyses) {
  const frames = analyses
    .filter((analysis) => analysis.timeSec >= segment.startSec && analysis.timeSec <= segment.endSec)
    .sort((a, b) => a.timeSec - b.timeSec);
  if (frames.length < getModelRunRules().edgeTrimMinFrames) return null;

  let lastSongLikeSec = null;
  for (const frame of frames) {
    if (hasMusicContinuity(frame)) {
      lastSongLikeSec = frame.timeSec;
    }
  }
  if (!Number.isFinite(lastSongLikeSec)) return null;

  const resetFrames = frames.filter((frame) => frame.timeSec >= lastSongLikeSec);
  const resetStartSec = findSustainedResetStartSec(resetFrames, getModelRunRules().tailResetMinDurationSec);
  const proposedEndSec = Math.min(
    segment.endSec,
    Number.isFinite(resetStartSec)
      ? resetStartSec + getModelRunRules().tailResetPaddingSec
      : lastSongLikeSec + GLOBAL_SMOOTHING_HOP_SEC
  );
  if (segment.endSec - proposedEndSec < getModelRunRules().edgeRefineMinOverrunSec) return null;

  const tailFrames = frames.filter((frame) => frame.timeSec >= proposedEndSec && frame.timeSec <= segment.endSec);
  if (tailFrames.length < getModelRunRules().edgeTrimMinFrames) return null;
  const nonMusicRatio = tailFrames.filter(isPostSongNonMusicFrame).length / tailFrames.length;
  const songSideWindowSec = Math.max(getModelRunRules().edgeRefineWindowSec / 3, segment.endSec - proposedEndSec);
  const songSideFrames = frames.filter((frame) => frame.timeSec >= proposedEndSec - songSideWindowSec && frame.timeSec < proposedEndSec);
  const musicChange = summarizeMusicPropertyChange(songSideFrames, tailFrames);
  const hardResetTail = Number.isFinite(resetStartSec) || nonMusicRatio >= getModelRunRules().postSongNonMusicRatio;
  const speechOrSilenceRatio = tailFrames.filter((frame) => (
    isSilentFrame(frame) || isSpeechResetFrame(frame) || isSpeechWithoutMusicContinuity(frame)
  )).length / tailFrames.length;
  const lowConfidenceSpeechRatio = tailFrames.filter(isLowConfidenceSpeechWithoutMusicContinuity).length / tailFrames.length;
  const noiseRatio = tailFrames.filter(isNoiseWithoutMusicContinuity).length / tailFrames.length;
  const trimDurationSec = segment.endSec - proposedEndSec;
  const resetEvidenceTail = speechOrSilenceRatio >= 0.18
    || lowConfidenceSpeechRatio >= 0.45
    || musicChange.pass;
  const longAmbiguousMusicChangeTrim = trimDurationSec > 25
    && musicChange.pass
    && speechOrSilenceRatio < 0.18
    && lowConfidenceSpeechRatio < 0.35;
  if (!hardResetTail || !resetEvidenceTail) return null;
  if (longAmbiguousMusicChangeTrim) return null;

  return {
    startSec: segment.startSec,
    endSec: Math.max(segment.startSec, proposedEndSec),
    reason: Number.isFinite(resetStartSec)
      ? 'spectral-tail-reset'
      : (musicChange.pass ? 'spectral-tail-music-change' : 'spectral-tail-non-music'),
    nonMusicRatio: roundNumber(nonMusicRatio, 3),
    speechOrSilenceRatio: roundNumber(speechOrSilenceRatio, 3),
    lowConfidenceSpeechRatio: roundNumber(lowConfidenceSpeechRatio, 3),
    noiseRatio: roundNumber(noiseRatio, 3),
    trimDurationSec: roundNumber(trimDurationSec, 3),
    resetStartSec: Number.isFinite(resetStartSec) ? roundNumber(resetStartSec, 3) : null,
    musicChange,
  };
}

function trimSegmentStartWithSpectralCues(segment, analyses) {
  const maxWindowEnd = Math.min(segment.endSec, segment.startSec + getModelRunRules().edgeRefineWindowSec);
  const frames = analyses
    .filter((analysis) => analysis.timeSec >= segment.startSec && analysis.timeSec <= maxWindowEnd)
    .sort((a, b) => a.timeSec - b.timeSec);
  if (frames.length < getModelRunRules().edgeTrimMinFrames) return null;

  let sustainedStartSec = null;
  for (let index = 0; index < frames.length; index += 1) {
    const windowEnd = frames[index].timeSec + 12;
    const windowFrames = frames.filter((frame) => frame.timeSec >= frames[index].timeSec && frame.timeSec <= windowEnd);
    if (windowFrames.length < 8) continue;
    const musicRatio = windowFrames.filter(hasMusicContinuity).length / windowFrames.length;
    const vocalRatio = windowFrames.filter(isVocalFrame).length / windowFrames.length;
    if (musicRatio >= 0.7 || vocalRatio >= 0.35) {
      sustainedStartSec = Math.max(segment.startSec, frames[index].timeSec - GLOBAL_SMOOTHING_HOP_SEC);
      break;
    }
  }
  if (!Number.isFinite(sustainedStartSec)) return null;
  if (sustainedStartSec - segment.startSec < Math.max(getModelRunRules().suspiciousStartOverrunSec, 18)) return null;

  const leadingFrames = frames.filter((frame) => frame.timeSec >= segment.startSec && frame.timeSec < sustainedStartSec);
  if (leadingFrames.length < getModelRunRules().edgeTrimMinFrames) return null;
  const resetRatio = leadingFrames.filter((frame) => isSpeechWithoutMusicContinuity(frame) || isSilentFrame(frame)).length / leadingFrames.length;
  const songSideFrames = frames.filter((frame) => frame.timeSec >= sustainedStartSec && frame.timeSec <= Math.min(segment.endSec, sustainedStartSec + Math.max(12, leadingFrames.length * GLOBAL_SMOOTHING_HOP_SEC)));
  const musicChange = summarizeMusicPropertyChange(songSideFrames, leadingFrames);
  const musicRuns = summarizeContinuityRuns(leadingFrames, hasMusicContinuity);
  const fragmentedPractice = musicRuns.count >= getModelRunRules().fragmentedStartMinBurstCount
    && musicRuns.maxDurationSec <= getModelRunRules().fragmentedStartMaxBurstSec
    && resetRatio >= 0.18;
  if (resetRatio < getModelRunRules().fragmentedStartMinResetRatio && !fragmentedPractice) return null;
  if (musicRuns.totalDurationSec > 24 && !fragmentedPractice) return null;
  if (musicRuns.maxDurationSec > getModelRunRules().fragmentedStartMaxContinuousMusicSec && resetRatio < 0.45) return null;

  return {
    startSec: sustainedStartSec,
    endSec: segment.endSec,
    reason: fragmentedPractice
      ? 'spectral-start-fragmented-practice'
      : (musicChange.pass ? 'spectral-start-music-change' : 'spectral-start-reset'),
    resetRatio: roundNumber(resetRatio, 3),
    shortMusicBurstsSec: roundNumber(musicRuns.totalDurationSec, 3),
    musicBurstCount: musicRuns.count,
    maxMusicBurstSec: roundNumber(musicRuns.maxDurationSec, 3),
    musicChange,
  };
}

function refineSegmentsWithSpectralEdges(segments, analyses) {
  const refinements = [];
  const output = segments.map((segment) => {
    let next = { ...segment };
    const startTrim = trimSegmentStartWithSpectralCues(next, analyses);
    if (startTrim) {
      refinements.push({
        original: normalizeOutputSegment(next),
        refined: normalizeOutputSegment({ ...next, startSec: startTrim.startSec }),
        reason: startTrim.reason,
        stats: {
          resetRatio: startTrim.resetRatio,
          shortMusicBurstsSec: startTrim.shortMusicBurstsSec,
          musicBurstCount: startTrim.musicBurstCount,
          maxMusicBurstSec: startTrim.maxMusicBurstSec,
          musicChange: startTrim.musicChange || null,
        },
      });
      next = { ...next, startSec: startTrim.startSec };
    }

    const tailTrim = trimSegmentTailWithSpectralCues(next, analyses);
    if (tailTrim) {
      refinements.push({
        original: normalizeOutputSegment(next),
        refined: normalizeOutputSegment({ ...next, endSec: tailTrim.endSec }),
        reason: tailTrim.reason,
        stats: {
          nonMusicRatio: tailTrim.nonMusicRatio,
          resetStartSec: tailTrim.resetStartSec,
          musicChange: tailTrim.musicChange || null,
        },
      });
      next = { ...next, endSec: tailTrim.endSec };
    }
    return next;
  });

  return {
    segments: output
      .map((segment) => normalizeOutputSegment(segment))
      .filter((segment) => segmentDuration(segment) >= getModelRunRules().minSegmentDurationSec),
    refinements,
    changed: refinements.length > 0,
  };
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

function buildMusicOnlySpanStats(frames, startSec, endSec, candidateCount, minDurationSec = 0) {
  const durationSec = Math.max(0, endSec - startSec);
  const spanFrames = frames.filter((frame) => frame.timeSec >= startSec && frame.timeSec <= endSec);
  const frameCount = spanFrames.length;
  if (!frameCount || durationSec < minDurationSec) return null;

  const musicValues = spanFrames.map(frameMusicValue);
  const singingValues = spanFrames.map(frameSingingValue);
  const speechValues = spanFrames.map(frameSpeechValue);
  const temporalValues = spanFrames.map((frame) => Number(frame.temporalHeadProbability ?? frame.songProbability) || 0);
  const singingRatioValues = spanFrames.map((frame) => Number(frame.singingRatio) || 0);
  const speechRatioValues = spanFrames.map((frame) => Number(frame.speechRatio) || 0);
  const repetition = estimateMusicRepetition(spanFrames, { startSec, endSec });
  return {
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
    temporalMean: mean(temporalValues),
    repetition,
    repetitionScore: Number(repetition.score) || 0,
    repetitionMatchedWindowCount: Number(repetition.matchedWindowCount) || 0,
    repetitionMusicOnlyWindowRatio: Number(repetition.musicOnlyWindowRatio) || 0,
    repetitionVocalWindowRatio: Number(repetition.vocalWindowRatio) || 0,
  };
}

function musicOnlyStatsPass(stats, thresholds) {
  if (!stats) return false;
  const musicSustained = stats.candidateRatio >= thresholds.minCandidateRatio
    && stats.musicMean >= thresholds.minMusicMean
    && stats.musicP80 >= thresholds.minMusicP80;
  const singingLow = stats.singingMean <= thresholds.maxSingingMean
    && stats.singingP90 <= thresholds.maxSingingP90
    && stats.singingRatioMean <= thresholds.maxSingingRatioMean;
  const speechLow = stats.speechMean <= thresholds.maxSpeechMean
    && stats.speechP90 <= thresholds.maxSpeechP90
    && stats.speechRatioMean <= thresholds.maxSpeechRatioMean;
  return musicSustained && singingLow && speechLow;
}

function repetitiveMusicStatsPass(stats) {
  if (!stats) return false;
  const rules = getModelRunRules();
  return stats.durationSec >= rules.repetitiveMusicDropMinDurationSec
    && stats.repetitionScore >= rules.repetitiveMusicDropMinScore
    && stats.repetitionMatchedWindowCount >= rules.repetitiveMusicDropMinMatchedWindows
    && stats.repetitionMusicOnlyWindowRatio >= rules.repetitiveMusicDropMinMusicOnlyWindowRatio
    && stats.repetitionVocalWindowRatio <= rules.repetitiveMusicDropMaxVocalWindowRatio
    && stats.singingMean <= rules.repetitiveMusicDropMaxSingingMean
    && stats.singingP90 <= rules.repetitiveMusicDropMaxSingingP90
    && stats.temporalMean <= rules.repetitiveMusicDropMaxTemporalMean
    && stats.speechMean <= rules.repetitiveMusicDropMaxSpeechMean;
}

function formatMusicOnlyExclusionSpan(stats, reason) {
  return {
    startSec: roundNumber(stats.startSec, 3),
    endSec: roundNumber(stats.endSec, 3),
    durationSec: roundNumber(stats.durationSec, 3),
    reason,
    stats: {
      frameCount: stats.frameCount,
      candidateRatio: roundNumber(stats.candidateRatio, 3),
      musicMean: roundNumber(stats.musicMean, 3),
      musicP80: roundNumber(stats.musicP80, 3),
      singingMean: roundNumber(stats.singingMean, 3),
      singingP90: roundNumber(stats.singingP90, 3),
      singingRatioMean: roundNumber(stats.singingRatioMean, 3),
      speechMean: roundNumber(stats.speechMean, 3),
      speechP90: roundNumber(stats.speechP90, 3),
      speechRatioMean: roundNumber(stats.speechRatioMean, 3),
      temporalMean: roundNumber(stats.temporalMean, 3),
      repetitionScore: roundNumber(stats.repetitionScore, 3),
      repetitionMatchedWindowCount: stats.repetitionMatchedWindowCount,
      repetitionMusicOnlyWindowRatio: roundNumber(stats.repetitionMusicOnlyWindowRatio, 3),
      repetitionVocalWindowRatio: roundNumber(stats.repetitionVocalWindowRatio, 3),
      repetition: stats.repetition,
    },
  };
}

function summarizeMusicOnlySpan(frames, startSec, endSec, candidateCount) {
  const stats = buildMusicOnlySpanStats(
    frames,
    startSec,
    endSec,
    candidateCount,
    getModelRunRules().musicOnlyExcludeMinDurationSec
  );
  const pass = musicOnlyStatsPass(stats, {
    minCandidateRatio: getModelRunRules().musicOnlyMinCandidateRatio,
    minMusicMean: getModelRunRules().musicOnlyMinMusicMean,
    minMusicP80: getModelRunRules().musicOnlyMinMusicP80,
    maxSingingMean: getModelRunRules().musicOnlyMaxSingingMean,
    maxSingingP90: getModelRunRules().musicOnlyMaxSingingP90,
    maxSingingRatioMean: getModelRunRules().musicOnlyMaxSingingRatioMean,
    maxSpeechMean: getModelRunRules().musicOnlyMaxSpeechMean,
    maxSpeechP90: getModelRunRules().musicOnlyMaxSpeechP90,
    maxSpeechRatioMean: getModelRunRules().musicOnlyMaxSpeechRatioMean,
  });
  if (pass) return formatMusicOnlyExclusionSpan(stats, 'long-music-only-low-vocal');
  return repetitiveMusicStatsPass(stats)
    ? formatMusicOnlyExclusionSpan(stats, 'repetitive-music-low-vocal')
    : null;
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
    if (toleratedGapSec <= getModelRunRules().musicOnlyCandidateGapSec) {
      active.frames.push(frame);
      continue;
    }
    closeActive(active.lastCandidateEndSec);
  }

  if (active) closeActive(active.lastCandidateEndSec);
  return spans;
}

function getClusterMusicOnlyThresholds() {
  return {
    minCandidateRatio: getModelRunRules().musicOnlyClusterMinCandidateRatio,
    minMusicMean: getModelRunRules().musicOnlyClusterMinMusicMean,
    minMusicP80: getModelRunRules().musicOnlyClusterMinMusicP80,
    maxSingingMean: getModelRunRules().musicOnlyClusterMaxSingingMean,
    maxSingingP90: getModelRunRules().musicOnlyClusterMaxSingingP90,
    maxSingingRatioMean: getModelRunRules().musicOnlyClusterMaxSingingRatioMean,
    maxSpeechMean: getModelRunRules().musicOnlyClusterMaxSpeechMean,
    maxSpeechP90: getModelRunRules().musicOnlyClusterMaxSpeechP90,
    maxSpeechRatioMean: getModelRunRules().musicOnlyClusterMaxSpeechRatioMean,
  };
}

function summarizeSegmentMusicOnlyCandidate(analyses, segment) {
  const normalizedSegment = normalizeOutputSegment(segment);
  const durationSec = segmentDuration(normalizedSegment);
  if (durationSec < getModelRunRules().musicOnlyClusterMinSegmentDurationSec) return null;

  const frames = analyses.filter((analysis) => (
    analysis.timeSec >= normalizedSegment.startSec
    && analysis.timeSec <= normalizedSegment.endSec
  ));
  if (!frames.length) return null;

  const candidateCount = frames.filter(isMusicOnlyCandidateFrame).length;
  const stats = buildMusicOnlySpanStats(
    frames,
    normalizedSegment.startSec,
    normalizedSegment.endSec,
    candidateCount,
    0
  );
  if (!musicOnlyStatsPass(stats, getClusterMusicOnlyThresholds())) return null;
  return { segment: normalizedSegment, stats };
}

function summarizeClusterMusicOnlySpan(analyses, cluster) {
  const startSec = cluster.startSec;
  const endSec = cluster.endSec;
  const spanDurationSec = Math.max(0, endSec - startSec);
  const totalSegmentDurationSec = cluster.segments
    .reduce((total, segment) => total + segmentDuration(segment), 0);
  const enoughDuration = totalSegmentDurationSec >= getModelRunRules().musicOnlyClusterMinTotalDurationSec
    || (
      spanDurationSec >= getModelRunRules().musicOnlyClusterMinSpanDurationSec
      && totalSegmentDurationSec >= getModelRunRules().musicOnlyClusterMinTotalDurationSec * 0.82
    );
  if (!enoughDuration) return null;

  const frames = analyses.filter((analysis) => analysis.timeSec >= startSec && analysis.timeSec <= endSec);
  if (!frames.length) return null;
  const candidateCount = frames.filter(isMusicOnlyCandidateFrame).length;
  const stats = buildMusicOnlySpanStats(frames, startSec, endSec, candidateCount, 0);
  if (!musicOnlyStatsPass(stats, getClusterMusicOnlyThresholds()) && !repetitiveMusicStatsPass(stats)) return null;
  return {
    ...formatMusicOnlyExclusionSpan(stats, 'clustered-music-only-low-vocal'),
    segmentCount: cluster.segments.length,
    segmentTotalDurationSec: roundNumber(totalSegmentDurationSec, 3),
  };
}

function findClusteredMusicOnlySpans(segments, analyses) {
  const candidates = (Array.isArray(segments) ? segments : [])
    .map((segment) => normalizeOutputSegment(segment))
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
    .map((segment) => summarizeSegmentMusicOnlyCandidate(analyses, segment))
    .filter(Boolean);
  const spans = [];
  let active = null;

  function closeActive() {
    if (!active) return;
    const span = summarizeClusterMusicOnlySpan(analyses, active);
    if (span) spans.push(span);
    active = null;
  }

  for (const candidate of candidates) {
    const segment = candidate.segment;
    if (!active) {
      active = {
        startSec: segment.startSec,
        endSec: segment.endSec,
        segments: [segment],
      };
      continue;
    }

    const gapSec = Math.max(0, segment.startSec - active.endSec);
    if (gapSec <= getModelRunRules().musicOnlyClusterMaxGapSec) {
      active.endSec = Math.max(active.endSec, segment.endSec);
      active.segments.push(segment);
      continue;
    }

    closeActive();
    active = {
      startSec: segment.startSec,
      endSec: segment.endSec,
      segments: [segment],
    };
  }

  closeActive();
  return spans;
}

function findRepetitiveMusicOnlySpans(segments, analyses) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => {
      const normalizedSegment = normalizeOutputSegment(segment);
      const frames = analyses.filter((analysis) => (
        analysis.timeSec >= normalizedSegment.startSec
        && analysis.timeSec <= normalizedSegment.endSec
      ));
      if (!frames.length) return null;
      const candidateCount = frames.filter(isMusicOnlyCandidateFrame).length;
      const stats = buildMusicOnlySpanStats(
        frames,
        normalizedSegment.startSec,
        normalizedSegment.endSec,
        candidateCount,
        getModelRunRules().repetitiveMusicDropMinDurationSec
      );
      return repetitiveMusicStatsPass(stats)
        ? formatMusicOnlyExclusionSpan(stats, 'repetitive-music-low-vocal')
        : null;
    })
    .filter(Boolean);
}

function segmentLooksLikeWeakHeadMusicOnly(segment, matchedSpan, analyses, overlapSec) {
  const normalizedSegment = normalizeOutputSegment(segment);
  const durationSec = segmentDuration(normalizedSegment);
  if (durationSec <= 0 || durationSec > getModelRunRules().musicOnlyWeakHeadDropMaxDurationSec) {
    return false;
  }
  if (overlapSec < getModelRunRules().musicOnlyWeakHeadDropMinOverlapSec) {
    return false;
  }
  const startsInsideOrNearSpan = normalizedSegment.startSec <= (
    Number(matchedSpan.endSec) + getModelRunRules().musicOnlyWeakHeadDropMaxStartAfterSpanSec
  );
  if (!startsInsideOrNearSpan) return false;

  const support = summarizeSegmentModelSupport(analyses, normalizedSegment);
  return support.frameCount >= getModelRunRules().unsupportedTrackerMinFrames
    && support.modelAboveRatio <= getModelRunRules().musicOnlyWeakHeadDropMaxModelRatio
    && support.musicMean >= getModelRunRules().musicOnlyWeakHeadDropMinMusicMean
    && support.singingMedian <= getModelRunRules().musicOnlyWeakHeadDropMaxSingingMedian
    && support.singingMean <= getModelRunRules().musicOnlyWeakHeadDropMaxSingingMean;
}

function applyLongMusicOnlyExclusion(segments, analyses, startSec, endSec) {
  const excludedMusicOnlySpans = [
    ...findLongMusicOnlySpans(analyses, startSec, endSec),
    ...findRepetitiveMusicOnlySpans(segments, analyses),
    ...findClusteredMusicOnlySpans(segments, analyses),
  ].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  if (!excludedMusicOnlySpans.length) {
    return { segments, excludedMusicOnlySpans, droppedMusicOnlySegments: [], changed: false };
  }

  const droppedMusicOnlySegments = [];
  const output = [];
  for (const segment of segments) {
    const normalizedSegment = normalizeOutputSegment(segment);
    const matchedSpan = excludedMusicOnlySpans.find((span) => {
      const overlapSec = segmentOverlapSec(normalizedSegment, span);
      if (overlapSec <= 0) return false;
      const overlapRatio = overlapSec / Math.max(1, segmentDuration(normalizedSegment));
      return overlapRatio >= getModelRunRules().musicOnlyDropMinOverlapRatio
        || overlapSec >= getModelRunRules().musicOnlyDropMinOverlapSec
        || segmentLooksLikeWeakHeadMusicOnly(normalizedSegment, span, analyses, overlapSec);
    });
    if (matchedSpan) {
      droppedMusicOnlySegments.push({
        ...normalizedSegment,
        reason: matchedSpan.reason,
        exclusionSpan: matchedSpan,
      });
      continue;
    }

    const leadingSpan = excludedMusicOnlySpans.find((span) => (
      span.startSec <= normalizedSegment.startSec + GLOBAL_SMOOTHING_HOP_SEC
      && span.endSec > normalizedSegment.startSec
      && span.endSec < normalizedSegment.endSec - getTrackerConfig().minSegmentDurationSec
    ));
    if (leadingSpan) {
      output.push(normalizeOutputSegment({
        ...normalizedSegment,
        startSec: Math.max(normalizedSegment.startSec, leadingSpan.endSec),
      }));
      continue;
    }

    output.push(normalizedSegment);
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
    modelSegment.startSec - segment.startSec > getModelRunRules().suspiciousStartOverrunSec
    && edgeLooksNonSong(analyses, segment.startSec, modelSegment.startSec)
  ) {
    startSec = modelSegment.startSec;
  }
  if (
    segment.endSec - modelSegment.endSec > getModelRunRules().suspiciousTailOverrunSec
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
    const output = [];
    const droppedTrackerSegments = [];
    for (const trackerSegment of trackerSegments) {
      const support = summarizeSegmentModelSupport(analyses, trackerSegment);
      if (shouldDropUnsupportedTrackerSegment(trackerSegment, support)) {
        droppedTrackerSegments.push({ ...trackerSegment, support });
        continue;
      }
      output.push(trackerSegment);
    }
    return {
      segments: output,
      selectedFallbackSegments: [],
      droppedTrackerSegments,
      changed: output.length !== trackerSegments.length,
    };
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
    const trackerIsGiant = segmentDuration(trackerSegment) / analyzedDuration >= getModelRunRules().suspiciousCoverageRatio;

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
      return overlapSec >= getModelRunRules().selectiveFallbackMinOverlapSec
        || overlapSec / Math.max(1, segmentDuration(modelSegment)) >= getModelRunRules().selectiveFallbackMinOverlapRatio;
    });
    if (!overlapsOutput) {
      const support = summarizeSegmentModelSupport(analyses, modelSegment);
      const strongStandaloneModel = (Number(modelSegment.confidence) || 0) >= getModelRunRules().standaloneModelFallbackMinConfidence
        && segmentDuration(modelSegment) >= getModelRunRules().standaloneModelFallbackMinDurationSec
        && support.singingMean >= getModelRunRules().unsupportedMusicOnlyMaxSingingMean;
      if (!strongStandaloneModel) continue;
      output.push(modelSegment);
      selectedFallbackSegments.push(modelSegment);
    }
  }

  const segments = mergeSegments(output, {
    maxGapSec: getTrackerConfig().mergeGapSec,
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
      if (lowCount >= getTrackerConfig().tailEndRequiredWindows) {
        segments.push({
          startSec: active.startSec,
          endSec: Math.min(endSec, active.endSec + getTrackerConfig().tailPaddingSec),
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
      endSec: Math.min(endSec, active.endSec + getTrackerConfig().tailPaddingSec),
      confidence: active.confidenceTotal / Math.max(1, active.confidenceCount),
    });
  }
  return mergeSegments(segments, {
    maxGapSec: getTrackerConfig().mergeGapSec,
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
  return withSmoothingProfile(options.smoothingProfile, () => runDecisionTrackerSegmentsWithActiveProfile(analyses, endSec, options));
}

function runDecisionTrackerSegmentsWithActiveProfile(analyses, endSec, options = {}) {
  const normalizedAnalyses = normalizeAnalysisFrames(analyses).filter((analysis) => analysis.ready);
  const segmentTracker = new EventSegmentTracker({
    ...getTrackerConfig(),
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

export function smoothFireRedAnalyses(
  analyses,
  endSec,
  options = {}
) {
  const profile = resolveSmoothingProfile(options.smoothingProfile);
  return withSmoothingProfile(profile, () => smoothFireRedAnalysesWithActiveProfile(analyses, endSec, options, profile));
}

function smoothFireRedAnalysesWithActiveProfile(
  analyses,
  endSec,
  {
    startSec = null,
    minSegmentDurationSec = null,
    segmentFilterEnabled = false,
    segmentFilterPredictions = null,
    segmentFilterOptions = null,
  } = {},
  smoothingProfile = DEFAULT_SMOOTHING_PROFILE
) {
  const normalizedAnalyses = normalizeAnalysisFrames(analyses).filter((analysis) => analysis.ready);
  if (!normalizedAnalyses.length) {
    return {
      segments: [],
      trackerSegments: [],
      modelRunSegments: [],
      fallbackSegments: [],
      excludedMusicOnlySpans: [],
      droppedMusicOnlySegments: [],
      spectralEdgeRefinements: [],
      method: 'empty',
      smoothingProfile,
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
    smoothingProfile,
  });
  const modelRunSegments = buildModelRunSegmentsFromAnalyses(normalizedAnalyses, effectiveEndSec);
  let segments = trackerResult.segments;
  let method = 'event-tracker';
  let fallbackSegments = [];
  let selectedModelFallbackSegments = [];
  let droppedTrackerSegments = [];
  let excludedMusicOnlySpans = [];
  let droppedMusicOnlySegments = [];
  let spectralEdgeRefinements = [];
  let segmentFilterAdjustments = [];

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

  const spectralEdges = refineSegmentsWithSpectralEdges(segments, normalizedAnalyses);
  spectralEdgeRefinements = spectralEdges.refinements || [];
  if (spectralEdges.changed) {
    segments = mergeSegments(spectralEdges.segments, {
      maxGapSec: getTrackerConfig().mergeGapSec,
      minSegmentDurationSec: resolvedMinSegmentDurationSec,
    }).map((segment) => normalizeOutputSegment(segment));
    method = `${method}+spectral-edge-refine`;
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

  if (segmentFilterEnabled && Array.isArray(segmentFilterPredictions) && segmentFilterPredictions.length) {
    const filtered = applySegmentFilterPredictions(segments, segmentFilterPredictions, {
      minSegmentDurationSec: resolvedMinSegmentDurationSec,
      startSec: effectiveStartSec,
      endSec: effectiveEndSec,
      ...(segmentFilterOptions || {}),
    });
    segmentFilterAdjustments = filtered.adjustments || [];
    if (filtered.changed) {
      segments = filtered.segments;
      method = `${method}+segment-filter`;
    }
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
    spectralEdgeRefinements,
    segmentFilterAdjustments,
    method,
    minSegmentDurationSec: resolvedMinSegmentDurationSec,
    smoothingProfile,
    smoothingVersion: GLOBAL_SMOOTHING_VERSION,
  };
}
