'use strict';

import {
  DETECTOR_MODES,
  normalizeDetectionStatus,
  normalizeDetectorMode,
  roundNumber,
  toSeconds,
} from './lib/songDetection/common.js';
import { SongSegmentTracker } from './lib/songDetection/segmentTracker.js';
import { EventSegmentTracker } from './lib/songDetection/eventSegmentTracker.js';
import { HeuristicSongDetector, HEURISTIC_DETECTOR_VERSION } from './lib/songDetection/heuristicDetector.js';
import { FireRedAedSongDetector, FIRERED_AED_DETECTOR_VERSION } from './lib/songDetection/fireredAedDetector.js';
import {
  summarizeAnalysisFrameDistribution,
  summarizeRecentAnalysisFrameDistribution,
} from './lib/songDetection/frameDiagnostics.js';
import { normalizeAnalysisFrame } from './lib/songDetection/analysisFrame.js';
import { GLOBAL_SMOOTHING_VERSION, smoothFireRedAnalyses } from './lib/songDetection/globalSmoothing.js';
import {
  DEFAULT_SEGMENT_FILTER_OPTIONS,
  SEGMENT_FILTER_VERSION,
  applySegmentFilterPredictions,
  refineLiveSegmentEndsBySpeechReset,
  loadEdgeTrimAdvisorModel,
  loadSegmentFilterModel,
  runSegmentFilterPipeline,
} from './lib/songDetection/segmentFilter.js';

const HOP_MS = 500;
const REPORT_INTERVAL_MS = 2000;
const LIVE_RUNTIME_STATUS_INTERVAL_MS = 3000;
const LIVE_RUNTIME_FRAME_DISTRIBUTION_WINDOW_SEC = 10 * 60;
const MAX_PLAYBACK_DIAGNOSTIC_EVENTS = 120;
const PLAYBACK_SNAPSHOT_TIMEOUT_MS = 700;
const PLAYBACK_SNAPSHOT_UNAVAILABLE_GRACE_MS = 3000;
const ENABLE_DEBUG_TRACE = false;
const MAX_DEBUG_TRACE_FRAMES = 24000;
const DEFAULT_DETECTOR_MODE = DETECTOR_MODES.FIRERED_AED;
const DEFAULT_MIN_SEGMENT_DURATION_SEC = 90;
const AUDIO_CAPTURE_WORKLET_NAME = 'ytj-audio-capture-worklet';
const AUDIO_CAPTURE_WORKLET_PATH = 'lib/songDetection/audioCapture.worklet.js';
const LIVE_FINALIZE_DELAY_SEC = 180;
const LIVE_RESMOOTH_INTERVAL_SEC = 5;
const LIVE_RESMOOTH_WINDOW_SEC = null;
const LIVE_SEGMENT_FILTER_ENABLED = true;
const LIVE_SEGMENT_FILTER_KEEP_THRESHOLD = 0.35;
const LIVE_FINAL_SEGMENT_FILTER_KEEP_THRESHOLD = 0.9;
const LIVE_EDGE_TRIM_DURING_STREAM = false;
const LIVE_START_EDGE_TRIM_ENABLED = true;
const LIVE_START_EDGE_TRIM_SCALE = 0.75;
const LIVE_START_EDGE_TRIM_MIN_ABS_SEC = 2;
const LIVE_LARGE_END_TRIM_THRESHOLD_SEC = 30;
const LIVE_LARGE_END_TRIM_SCALE = 1.6;
const LIVE_SEGMENT_FILTER_EXECUTION_PROVIDERS = ['wasm'];
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
const LIVE_ANALYSIS_METHODS = Object.freeze({
  AED_CACHE_60S: 'aed-cache-60s',
  PCM_ROLLOVER_30MIN: 'pcm-rollover-30min',
});
const DEFAULT_LIVE_ANALYSIS_METHOD = LIVE_ANALYSIS_METHODS.AED_CACHE_60S;
const LIVE_AED_CACHE_SEC = 60;
const LIVE_AED_CACHE_OVERLAP_SEC = 60;
const LIVE_PCM_ROLLOVER_SEC = 30 * 60;
const LIVE_PCM_OVERLAP_SEC = 120;
const MAX_ANALYSIS_CACHE_FRAMES = 12 * 60 * 60 * 2; // 12 hours at 0.5s hop.
const FIRERED_TRACKER_START_THRESHOLD = 0.54;
const FIRERED_TRACKER_END_THRESHOLD = 0.28;
const HEURISTIC_TRACKER_START_THRESHOLD = 0.6;
const HEURISTIC_TRACKER_END_THRESHOLD = 0.42;
const FIRERED_TRACKER_START_MARGIN = 0.02;
const FIRERED_TRACKER_HYSTERESIS_GAP = 0.18;
const PLAYBACK_CLOCK_SEEK_JUMP_SEC = 8;
const PLAYBACK_CLOCK_CONTINUITY_TOLERANCE_SEC = 4;
const PLAYBACK_READY_STATE_HAVE_CURRENT_DATA = 2;
const LIVE_ANALYSIS_TIME_GRID_SEC = HOP_MS / 1000;

const FIRERED_DECISION_RULES = Object.freeze({
  historyWindowSec: 45,
  shortWindowSec: 4,
  mediumWindowSec: 10,
  longWindowSec: 30,
  introLookbackSec: 45,
  anchorGraceSec: 12,
  minHistoryFrames: 2,
  singingPresentThreshold: 0.78,
  singingMeanShortThreshold: 0.5,
  singingMeanMediumThreshold: 0.52,
  singingSoftThreshold: 0.5,
  strongSingingThreshold: 0.84,
  musicPresentThreshold: 0.65,
  musicMeanMediumThreshold: 0.55,
  musicSoftThreshold: 0.55,
  speechDominantThreshold: 0.65,
  speechLowSingingCeiling: 0.35,
  bgmLowSingingRatio: 0.1,
  bgmPenaltyMax: 0.62,
  speechPenaltyMax: 0.34,
});

const sessions = new Map();
const completedDebugTraces = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeMinSegmentDurationSec(value, fallback = DEFAULT_MIN_SEGMENT_DURATION_SEC) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(15, Math.min(600, Math.round(num)));
}

function normalizePlaybackRate(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 1;
  return Math.max(0.25, Math.min(4, num));
}

function normalizeLiveAnalysisMethod(value, fallback = DEFAULT_LIVE_ANALYSIS_METHOD) {
  const key = String(value || '').trim().toLowerCase();
  if (key === LIVE_ANALYSIS_METHODS.AED_CACHE_60S) return LIVE_ANALYSIS_METHODS.AED_CACHE_60S;
  if (key === LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN) return LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN;
  return fallback;
}

function segmentFilterProfileForLiveAnalysisMethod(method) {
  return normalizeLiveAnalysisMethod(method) === LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN
    ? 'live-pcm30'
    : 'live-realtime-aed60';
}

function resolveLiveFrameBuilderConfig(method) {
  const liveAnalysisMethod = normalizeLiveAnalysisMethod(method);
  if (liveAnalysisMethod === LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN) {
    return {
      liveAnalysisMethod,
      chunkSec: LIVE_PCM_ROLLOVER_SEC,
      overlapSec: LIVE_PCM_OVERLAP_SEC,
    };
  }
  return {
    liveAnalysisMethod: LIVE_ANALYSIS_METHODS.AED_CACHE_60S,
    chunkSec: LIVE_AED_CACHE_SEC,
    overlapSec: LIVE_AED_CACHE_OVERLAP_SEC,
  };
}

function buildSignature(finalSegments, provisionalSegments, status, videoId, detectorVersion, detectorMode) {
  return JSON.stringify({
    videoId: videoId || null,
    status,
    detectorVersion,
    detectorMode,
    finalSegments,
    provisionalSegments,
  });
}

function normalizeLiveAnalysisCacheFrame(currentTimeSec, analysis) {
  if (!analysis || !analysis.ready) return null;
  return normalizeAnalysisFrame({
    ready: true,
    timeSec: roundNumber(currentTimeSec, 3),
    sourceMode: analysis.sourceMode || null,
    sourceRangeId: analysis.sourceRangeId || null,
    discontinuityBefore: Boolean(analysis.discontinuityBefore),
    discontinuityAfter: Boolean(analysis.discontinuityAfter),
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
  });
}

function appendAnalysisCacheFrame(session, currentTimeSec, analysis) {
  if (session.detectorMode !== DETECTOR_MODES.FIRERED_AED) return;
  const frame = normalizeLiveAnalysisCacheFrame(currentTimeSec, analysis);
  if (!frame) return;
  if (!Array.isArray(session.analysisCache)) session.analysisCache = [];

  const lastFrame = session.analysisCache[session.analysisCache.length - 1];
  if (lastFrame && Math.abs(lastFrame.timeSec - frame.timeSec) < 0.05) {
    session.analysisCache[session.analysisCache.length - 1] = frame;
  } else {
    session.analysisCache.push(frame);
  }
  session.liveSmoothingCache = null;

  if (session.analysisCache.length > MAX_ANALYSIS_CACHE_FRAMES) {
    session.analysisCache.splice(0, session.analysisCache.length - MAX_ANALYSIS_CACHE_FRAMES);
  }
}

function consumeFireRedAnalysisFrame(session, frame) {
  const frameTimeSec = Number(frame?.timeSec);
  if (!Number.isFinite(frameTimeSec)) {
    return { transitioned: false, status: session.segmentTracker?.isSong ? 'Detecting' : 'Listening' };
  }

  appendAnalysisCacheFrame(session, frameTimeSec, frame);
  session.lastAnalysisFrameTimeSec = frameTimeSec;

  const beforeTrackerState = getTrackerDebugState(session.segmentTracker);
  const decisionResult = applyFireRedDecisionRules(session, frameTimeSec, frame);
  const updateResult = session.segmentTracker.update(
    frameTimeSec,
    decisionResult?.trackerEvidence || {
      songProbability: decisionResult?.songProbability ?? frame.songProbability,
      hasSingingAnchor: false,
      hasRecentAnchor: false,
      hasMusicSustain: false,
      speechDominant: false,
      startSecOverride: decisionResult?.startSecOverride ?? null,
    }
  );

  appendDebugTrace(session, frameTimeSec, frame, decisionResult, updateResult, beforeTrackerState);
  return {
    transitioned: Boolean(updateResult?.transitioned),
    status: session.segmentTracker.isSong ? 'Detecting' : 'Listening',
  };
}

function consumeFireRedAnalysisFrames(session, frames) {
  let transitioned = false;
  let status = session.segmentTracker?.isSong ? 'Detecting' : 'Listening';
  let lastTimeSec = null;
  for (const frame of Array.isArray(frames) ? frames : []) {
    const result = consumeFireRedAnalysisFrame(session, frame);
    transitioned = transitioned || result.transitioned;
    status = result.status;
    if (Number.isFinite(Number(frame?.timeSec))) lastTimeSec = Number(frame.timeSec);
  }
  return { transitioned, status, lastTimeSec };
}

function buildAnalysisCacheSummary(session, refinedSegments = []) {
  const frames = Array.isArray(session.analysisCache) ? session.analysisCache : [];
  const first = frames[0] || null;
  const last = frames[frames.length - 1] || null;
  return {
    smoothingVersion: GLOBAL_SMOOTHING_VERSION,
    frameCount: frames.length,
    startSec: first ? roundNumber(first.timeSec, 3) : null,
    endSec: last ? roundNumber(last.timeSec, 3) : null,
    segmentCount: Array.isArray(refinedSegments) ? refinedSegments.length : 0,
    frameDistribution: summarizeAnalysisFrameDistribution(frames, {
      segments: refinedSegments,
    }),
  };
}

function segmentsOverlap(a, b) {
  const aStart = Number(a?.startSec);
  const aEnd = Number(a?.endSec);
  const bStart = Number(b?.startSec);
  const bEnd = Number(b?.endSec);
  if (![aStart, aEnd, bStart, bEnd].every(Number.isFinite)) return false;
  return aStart < bEnd && bStart < aEnd;
}

function sortReportSegments(segments, { provisional = null } = {}) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      ...segment,
      provisional: provisional === null ? Boolean(segment?.provisional) : Boolean(provisional),
    }))
    .filter((segment) => {
      const startSec = Number(segment?.startSec);
      const endSec = Number(segment?.endSec);
      return Number.isFinite(startSec) && Number.isFinite(endSec) && endSec >= startSec;
    })
    .sort((a, b) => Number(a.startSec) - Number(b.startSec) || Number(a.endSec) - Number(b.endSec));
}

function getLiveSmoothingFrames(frames, currentTimeSec, { finalizeAll = false } = {}) {
  if (finalizeAll) return frames;
  if (!Number.isFinite(Number(LIVE_RESMOOTH_WINDOW_SEC)) || Number(LIVE_RESMOOTH_WINDOW_SEC) <= 0) {
    return frames;
  }
  const endSec = Number(currentTimeSec) || Number(frames[frames.length - 1]?.timeSec) || 0;
  const windowStartSec = Math.max(0, endSec - Number(LIVE_RESMOOTH_WINDOW_SEC));
  return frames.filter((frame) => Number(frame.timeSec) >= windowStartSec);
}

function getCachedGlobalSmoothing(session, currentTimeSec, { finalizeAll = false } = {}) {
  if (!session || session.detectorMode !== DETECTOR_MODES.FIRERED_AED) return null;

  const frames = Array.isArray(session.analysisCache) ? session.analysisCache : [];
  if (frames.length < 20 || !frames.some((frame) => frame.temporalHeadReady)) return null;

  const smoothingFrames = getLiveSmoothingFrames(frames, currentTimeSec, { finalizeAll });
  const firstFrame = smoothingFrames[0] || frames[0] || null;
  const lastFrame = frames[frames.length - 1] || null;
  const endSec = Math.max(
    Number(currentTimeSec) || 0,
    Number(lastFrame?.timeSec) || 0
  );
  if (!finalizeAll && session.liveSmoothingCache?.result) {
    const lastComputedAtSec = Number(session.liveSmoothingCache.computedAtSec);
    if (Number.isFinite(lastComputedAtSec) && endSec - lastComputedAtSec < LIVE_RESMOOTH_INTERVAL_SEC) {
      return session.liveSmoothingCache.result;
    }
  }
  const key = [
    frames.length,
    roundNumber(Number(firstFrame?.timeSec) || 0, 1),
    roundNumber(endSec, 1),
    finalizeAll ? 'final' : 'live',
    segmentFilterProfileForLiveAnalysisMethod(session.liveAnalysisMethod),
  ].join(':');

  if (session.liveSmoothingCache && session.liveSmoothingCache.key === key) {
    return session.liveSmoothingCache.result;
  }

  const result = smoothFireRedAnalyses(smoothingFrames, endSec, {
    startSec: Number.isFinite(Number(firstFrame?.timeSec)) ? Number(firstFrame.timeSec) : null,
    minSegmentDurationSec: session.minSegmentDurationSec,
    smoothingProfile: segmentFilterProfileForLiveAnalysisMethod(session.liveAnalysisMethod),
  });

  session.liveSmoothingCache = { key, result, computedAtSec: endSec };
  return result;
}

function buildSegmentFilterRuntimeInfo(runtimes = null, error = null) {
  const segmentMeta = runtimes?.segmentFilter?.meta || {};
  const edgeMeta = runtimes?.edgeTrimAdvisor?.meta || {};
  return {
    version: SEGMENT_FILTER_VERSION,
    enabled: LIVE_SEGMENT_FILTER_ENABLED,
    executionProviders: LIVE_SEGMENT_FILTER_EXECUTION_PROVIDERS,
    segmentFilterLoaded: Boolean(runtimes?.segmentFilter),
    edgeTrimAdvisorLoaded: Boolean(runtimes?.edgeTrimAdvisor),
    requestedAssetProfile: runtimes?.segmentFilter?.requestedAssetProfile || runtimes?.edgeTrimAdvisor?.requestedAssetProfile || null,
    segmentFilterAssetProfile: runtimes?.segmentFilter?.assetProfile || null,
    segmentFilterAssetProfileFallbackUsed: Boolean(runtimes?.segmentFilter?.assetProfileFallbackUsed),
    edgeTrimAdvisorAssetProfile: runtimes?.edgeTrimAdvisor?.assetProfile || null,
    edgeTrimAdvisorAssetProfileFallbackUsed: Boolean(runtimes?.edgeTrimAdvisor?.assetProfileFallbackUsed),
    liveKeepThreshold: LIVE_SEGMENT_FILTER_KEEP_THRESHOLD,
    liveFinalKeepThreshold: resolveLiveFinalKeepThreshold(segmentMeta),
    liveEdgeTrimDuringStream: LIVE_EDGE_TRIM_DURING_STREAM,
    liveStartEdgeTrimEnabled: LIVE_START_EDGE_TRIM_ENABLED,
    keepThreshold: Number.isFinite(Number(segmentMeta.keepThreshold))
      ? Number(segmentMeta.keepThreshold)
      : DEFAULT_SEGMENT_FILTER_OPTIONS.keepThreshold,
    trimConfidenceThreshold: Number.isFinite(Number(edgeMeta.trimConfidenceThreshold))
      ? Number(edgeMeta.trimConfidenceThreshold)
      : DEFAULT_SEGMENT_FILTER_OPTIONS.trimConfidenceThreshold,
    liveEdgeTrimDisabledByModel: shouldDisableLiveEdgeTrim(edgeMeta),
    error: error ? (error?.message || String(error)) : null,
  };
}

function resolveNumberOption(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveLiveFinalKeepThreshold(segmentMeta = {}) {
  const profileThreshold = Number(segmentMeta.liveFinalKeepThreshold);
  if (Number.isFinite(profileThreshold)) {
    return Math.max(0.01, Math.min(0.99, profileThreshold));
  }
  return Math.max(
    LIVE_FINAL_SEGMENT_FILTER_KEEP_THRESHOLD,
    resolveNumberOption(segmentMeta.keepThreshold, DEFAULT_SEGMENT_FILTER_OPTIONS.keepThreshold)
  );
}

function shouldDisableLiveEdgeTrim(edgeMeta = {}) {
  return edgeMeta.disableLiveEdgeTrim === true;
}

function shouldEnableLiveEndTrimEvidenceGuard(edgeMeta = {}) {
  return edgeMeta.enableLiveEndTrimEvidenceGuard === true;
}

function buildLiveSegmentFilterOptions(session, runtimes, overrides = {}) {
  const segmentMeta = runtimes?.segmentFilter?.meta || {};
  const edgeMeta = runtimes?.edgeTrimAdvisor?.meta || {};
  return {
    ...DEFAULT_SEGMENT_FILTER_OPTIONS,
    keepThreshold: resolveNumberOption(segmentMeta.keepThreshold, DEFAULT_SEGMENT_FILTER_OPTIONS.keepThreshold),
    trimConfidenceThreshold: resolveNumberOption(edgeMeta.trimConfidenceThreshold, DEFAULT_SEGMENT_FILTER_OPTIONS.trimConfidenceThreshold),
    trimClampSec: resolveNumberOption(edgeMeta.trimClampSec, DEFAULT_SEGMENT_FILTER_OPTIONS.trimClampSec),
    trimScale: resolveNumberOption(edgeMeta.trimScale, DEFAULT_SEGMENT_FILTER_OPTIONS.trimScale),
    minSegmentDurationSec: session.minSegmentDurationSec,
    ...overrides,
  };
}

async function loadOptionalSegmentFilterRuntime(label, loadRuntime) {
  try {
    return await loadRuntime();
  } catch (error) {
    console.warn(`${label} unavailable; finalization falls back to heuristic smoothing.`, error);
    return null;
  }
}

async function getLiveSegmentFilterRuntimes(session) {
  if (!LIVE_SEGMENT_FILTER_ENABLED || !session || session.detectorMode !== DETECTOR_MODES.FIRERED_AED) {
    return null;
  }
  if (session.segmentFilterUnavailable) return null;
  if (session.segmentFilterRuntimes) return session.segmentFilterRuntimes;
  if (session.segmentFilterRuntimesPromise) return session.segmentFilterRuntimesPromise;

  const ort = globalThis.ort;
  if (!ort?.InferenceSession || !ort?.Tensor) {
    const error = new Error('ONNX Runtime Web is unavailable for live segment finalization.');
    session.segmentFilterUnavailable = true;
    session.segmentFilterLastError = error.message;
    session.segmentFilterRuntimeInfo = buildSegmentFilterRuntimeInfo(null, error);
    return null;
  }

  session.segmentFilterRuntimesPromise = (async () => {
    const assetProfile = segmentFilterProfileForLiveAnalysisMethod(session.liveAnalysisMethod);
    const [segmentFilter, edgeTrimAdvisor] = await Promise.all([
      loadOptionalSegmentFilterRuntime('Live segment filter', () => loadSegmentFilterModel({
        ort,
        assetProfile,
        requireAssetProfile: true,
        executionProviders: LIVE_SEGMENT_FILTER_EXECUTION_PROVIDERS,
      })),
      loadOptionalSegmentFilterRuntime('Live edge trim advisor', () => loadEdgeTrimAdvisorModel({
        ort,
        assetProfile,
        requireAssetProfile: true,
        executionProviders: LIVE_SEGMENT_FILTER_EXECUTION_PROVIDERS,
      })),
    ]);

    if (!segmentFilter) {
      if (edgeTrimAdvisor?.session && typeof edgeTrimAdvisor.session.release === 'function') {
        try {
          await edgeTrimAdvisor.session.release();
        } catch (error) {
          console.warn('Failed to release unused live edge trim advisor session.', error);
        }
      }
      session.segmentFilterUnavailable = true;
      session.segmentFilterLastError = 'Live segment keep filter runtime not loaded.';
      session.segmentFilterRuntimeInfo = buildSegmentFilterRuntimeInfo(null, session.segmentFilterLastError);
      return null;
    }

    session.segmentFilterRuntimes = { segmentFilter, edgeTrimAdvisor };
    session.segmentFilterRuntimeInfo = buildSegmentFilterRuntimeInfo(session.segmentFilterRuntimes);
    return session.segmentFilterRuntimes;
  })().finally(() => {
    session.segmentFilterRuntimesPromise = null;
  });

  return session.segmentFilterRuntimesPromise;
}

async function releaseLiveSegmentFilterRuntimes(session) {
  if (session?.segmentFilterRuntimesPromise) {
    try {
      await session.segmentFilterRuntimesPromise;
    } catch (error) {
      // Loading already failed; nothing to release.
    }
  }
  const runtimes = session?.segmentFilterRuntimes;
  const pendingRuns = [
    runtimes?.segmentFilter?.runQueue,
    runtimes?.edgeTrimAdvisor?.runQueue,
  ].filter((queue) => queue && typeof queue.then === 'function');
  if (pendingRuns.length) {
    let timedOut = false;
    try {
      await Promise.race([
        Promise.allSettled(pendingRuns),
        delayMs(10000).then(() => {
          timedOut = true;
        }),
      ]);
      if (timedOut) {
        console.warn('Timed out waiting for live segment filter ONNX queue before release.');
      }
    } catch (error) {
      console.warn('Failed while waiting for live segment filter ONNX queue before release.', error);
    }
  }
  const sessionsToRelease = [
    runtimes?.segmentFilter?.session,
    runtimes?.edgeTrimAdvisor?.session,
  ].filter(Boolean);
  await Promise.all(sessionsToRelease.map(async (ortSession) => {
    if (typeof ortSession.release !== 'function') return;
    try {
      await ortSession.release();
    } catch (error) {
      console.warn('Failed to release live segment filter ONNX session.', error);
    }
  }));
  if (session) {
    session.segmentFilterRuntimes = null;
    session.segmentFilterRuntimesPromise = null;
    resetLiveFinalizationState(session);
  }
}

function createLiveFinalizationState() {
  return {
    segments: [],
    sourceRanges: [],
    adjustments: [],
    filterApplied: false,
    runtimeInfo: null,
    maxSourceEndSec: null,
  };
}

function ensureLiveFinalizationState(session) {
  if (!session.liveFinalizationState) {
    session.liveFinalizationState = createLiveFinalizationState();
  }
  return session.liveFinalizationState;
}

function resetLiveFinalizationState(session) {
  if (!session) return;
  session.liveFinalizationState = createLiveFinalizationState();
}

function selectNewFinalizationCandidates(session, finalCandidates) {
  const state = ensureLiveFinalizationState(session);
  const maxSourceEndSec = Number(state.maxSourceEndSec);
  const hasMaxSourceEnd = state.maxSourceEndSec !== null && Number.isFinite(maxSourceEndSec);
  return sortReportSegments(finalCandidates, { provisional: false })
    .filter((segment) => {
      const startSec = Number(segment.startSec);
      const endSec = Number(segment.endSec);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return false;
      if (!hasMaxSourceEnd) return true;
      if (endSec <= maxSourceEndSec + 0.25) return false;
      // Once a segment has been frozen, do not let later smoothing merge back into it.
      return startSec >= maxSourceEndSec - 1;
    });
}

function appendLiveFinalizedSegments(session, sourceSegments, filteredResult) {
  const state = ensureLiveFinalizationState(session);
  const sourceRanges = sortReportSegments(sourceSegments, { provisional: false })
    .map((segment) => ({
      sourceStartSec: roundNumber(Number(segment.startSec) || 0, 3),
      sourceEndSec: roundNumber(Number(segment.endSec) || 0, 3),
    }));
  state.sourceRanges.push(...sourceRanges);
  if (sourceRanges.length) {
    state.maxSourceEndSec = Math.max(
      Number(state.maxSourceEndSec) || 0,
      ...sourceRanges.map((range) => Number(range.sourceEndSec) || 0)
    );
  }
  state.segments = mergeReportSegments(
    state.segments,
    sortReportSegments(filteredResult?.segments || [], { provisional: false })
  );
  state.adjustments.push(...(Array.isArray(filteredResult?.adjustments) ? filteredResult.adjustments : []));
  state.filterApplied = Boolean(state.filterApplied || filteredResult?.applied);
  state.runtimeInfo = filteredResult?.runtimeInfo || state.runtimeInfo;
  return state;
}

function summarizeLiveSegmentEvidence(frames, segment) {
  const startSec = Number(segment?.startSec);
  const endSec = Number(segment?.endSec);
  const sourceFrames = Array.isArray(frames) ? frames : [];
  const segmentFrames = sourceFrames.filter((frame) => {
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

function shouldProtectLiveFilterDrop(segment, frames, keepProbability = 1) {
  const probability = Number(keepProbability);
  if (Number.isFinite(probability) && probability < LIVE_FILTER_DROP_PROTECTION.minKeepProbability) return false;
  const durationSec = Number(segment?.endSec) - Number(segment?.startSec);
  const confidence = Number(segment?.confidence) || 0;
  if (durationSec < LIVE_FILTER_DROP_PROTECTION.minDurationSec) return false;
  if (confidence < LIVE_FILTER_DROP_PROTECTION.minConfidence) return false;

  const evidence = summarizeLiveSegmentEvidence(frames, segment);
  if (evidence.frameCount < 10) return false;
  const hasTemporalEvidence = evidence.temporalMean >= LIVE_FILTER_DROP_PROTECTION.minTemporalMean;
  const hasVocalEvidence = evidence.singingMean >= LIVE_FILTER_DROP_PROTECTION.minSingingMean
    || evidence.singingP90 >= LIVE_FILTER_DROP_PROTECTION.minSingingP90
    || evidence.singingRatioMean >= LIVE_FILTER_DROP_PROTECTION.minSingingRatioMean;
  const looksMusicOnly = evidence.lowSingingHighMusicRatio >= LIVE_FILTER_DROP_PROTECTION.maxLowSingingHighMusicRatio;

  return hasTemporalEvidence && hasVocalEvidence && !looksMusicOnly;
}

function protectLiveFilterDrops(originalSegments, filteredResult, frames) {
  const inputSegments = Array.isArray(originalSegments) ? originalSegments : [];
  const result = filteredResult || { segments: [], adjustments: [], changed: false };
  const adjustments = Array.isArray(result.adjustments) ? result.adjustments.map((item) => ({ ...item })) : [];
  const keptSegments = Array.isArray(result.segments) ? result.segments.slice() : [];
  let restored = false;

  for (let index = 0; index < adjustments.length; index += 1) {
    const adjustment = adjustments[index];
    if (adjustment?.action !== 'drop') continue;
    const sourceIndex = Number.isInteger(adjustment.index) ? adjustment.index : index;
    const sourceSegment = inputSegments[sourceIndex];
    if (!sourceSegment || !shouldProtectLiveFilterDrop(sourceSegment, frames, adjustment.keepProbability)) continue;

    const evidence = summarizeLiveSegmentEvidence(frames, sourceSegment);
    const normalized = {
      ...sourceSegment,
      provisional: false,
    };
    keptSegments.push(normalized);
    adjustments[index] = {
      ...adjustment,
      action: 'keep-live-protected',
      segment: normalized,
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
    segments: sortReportSegments(keptSegments, { provisional: false }),
    adjustments,
    changed: adjustments.some((item) => item.action === 'drop' || item.action === 'trim'),
  };
}

function resolveFinalizationEndBound(finalSegments, allSegments, finalCutoffSec, finalizeAll) {
  if (finalizeAll) return finalCutoffSec;
  const nextProvisionalStart = (Array.isArray(allSegments) ? allSegments : [])
    .filter((segment) => Number(segment?.endSec) > finalCutoffSec)
    .map((segment) => Number(segment?.startSec))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  if (!Number.isFinite(nextProvisionalStart)) return finalCutoffSec;
  return Math.max(
    Number(finalSegments[finalSegments.length - 1]?.startSec) || 0,
    Math.min(finalCutoffSec, nextProvisionalStart)
  );
}

async function applyLiveSegmentFilterToFinalSegments(
  session,
  finalSegments,
  smoothing,
  frames,
  currentTimeSec,
  finalCutoffSec,
  {
    finalizeAll = false,
    lowerBoundSec = null,
    skipSegmentFilter = false,
    disableEdgeTrim = false,
  } = {}
) {
  const normalizedFinalSegments = sortReportSegments(finalSegments, { provisional: false });
  if (!normalizedFinalSegments.length) {
    return {
      segments: normalizedFinalSegments,
      adjustments: [],
      applied: false,
      changed: false,
      runtimeInfo: session.segmentFilterRuntimeInfo || buildSegmentFilterRuntimeInfo(),
    };
  }
  if (skipSegmentFilter) {
    return {
      segments: normalizedFinalSegments,
      adjustments: [],
      applied: false,
      changed: false,
      runtimeInfo: session.segmentFilterRuntimeInfo || buildSegmentFilterRuntimeInfo(),
    };
  }

  const runtimes = await getLiveSegmentFilterRuntimes(session);
  if (!runtimes) {
    return {
      segments: normalizedFinalSegments,
      adjustments: [],
      applied: false,
      changed: false,
      runtimeInfo: session.segmentFilterRuntimeInfo || buildSegmentFilterRuntimeInfo(null, session.segmentFilterLastError),
    };
  }

  const finalEndBoundSec = resolveFinalizationEndBound(
    normalizedFinalSegments,
    smoothing?.segments,
    Math.max(0, Number(finalCutoffSec) || 0),
    finalizeAll
  );

  try {
    const firstFrame = frames[0] || null;
    const predictionEndSec = finalizeAll
      ? Math.max(
          Number(currentTimeSec) || 0,
          Number(frames[frames.length - 1]?.timeSec) || 0,
          finalEndBoundSec
        )
      : finalEndBoundSec;
    const predictionContext = {
      trackerSegments: smoothing?.trackerSegments || [],
      modelRunSegments: smoothing?.modelRunSegments || [],
      fallbackSegments: smoothing?.fallbackSegments || [],
      selectedModelFallbackSegments: smoothing?.selectedModelFallbackSegments || [],
      endSec: predictionEndSec,
    };
    const edgeMeta = runtimes?.edgeTrimAdvisor?.meta || {};
    const edgeTrimDisabledByModel = shouldDisableLiveEdgeTrim(edgeMeta);
    const endTrimEvidenceGuardEnabled = shouldEnableLiveEndTrimEvidenceGuard(edgeMeta);
    const activeRuntimes = !disableEdgeTrim && !edgeTrimDisabledByModel && (finalizeAll || LIVE_EDGE_TRIM_DURING_STREAM)
      ? runtimes
      : { segmentFilter: runtimes.segmentFilter, edgeTrimAdvisor: null };
    const predictionOptions = buildLiveSegmentFilterOptions(session, activeRuntimes, {
      keepThreshold: finalizeAll
        ? resolveLiveFinalKeepThreshold(runtimes?.segmentFilter?.meta || {})
        : LIVE_SEGMENT_FILTER_KEEP_THRESHOLD,
      startSec: Number.isFinite(Number(firstFrame?.timeSec)) ? Number(firstFrame.timeSec) : 0,
      endSec: predictionEndSec,
    });
    const applyOptions = {
      ...predictionOptions,
      startSec: Number.isFinite(Number(lowerBoundSec))
        ? Number(lowerBoundSec)
        : predictionOptions.startSec,
      endSec: finalEndBoundSec,
      allowStartTrim: LIVE_START_EDGE_TRIM_ENABLED,
      startTrimMode: 'extend-only',
      startTrimScale: LIVE_START_EDGE_TRIM_SCALE,
      startTrimMinAbsSec: LIVE_START_EDGE_TRIM_MIN_ABS_SEC,
      startTrimEvidenceFrames: frames,
      startTrimEvidenceMinFrames: 3,
      endTrimEvidenceFrames: endTrimEvidenceGuardEnabled ? frames : [],
      endTrimEvidenceGuard: endTrimEvidenceGuardEnabled,
      endTrimEvidenceMinFrames: 4,
      largeEndTrimThresholdSec: LIVE_LARGE_END_TRIM_THRESHOLD_SEC,
      largeEndTrimScale: LIVE_LARGE_END_TRIM_SCALE,
    };
    const predictions = await runSegmentFilterPipeline(
      activeRuntimes,
      normalizedFinalSegments,
      frames,
      predictionContext,
      predictionOptions
    );
    const filtered = protectLiveFilterDrops(
      normalizedFinalSegments,
      applySegmentFilterPredictions(normalizedFinalSegments, predictions, applyOptions),
      frames
    );
    const speechResetRefined = finalizeAll
      ? refineLiveSegmentEndsBySpeechReset(filtered.segments, frames, {
        minSegmentDurationSec: session.minSegmentDurationSec,
      })
      : { segments: filtered.segments, adjustments: [], changed: false };
    const finalSegments = speechResetRefined.segments || filtered.segments;
    return {
      segments: sortReportSegments(finalSegments, { provisional: false }),
      adjustments: [
        ...(filtered.adjustments || []),
        ...(speechResetRefined.adjustments || []),
      ],
      applied: true,
      changed: Boolean(filtered.changed || speechResetRefined.changed),
      runtimeInfo: session.segmentFilterRuntimeInfo || buildSegmentFilterRuntimeInfo(runtimes),
    };
  } catch (error) {
    console.warn('Live segment finalization filter failed; using heuristic final segments.', error);
    session.segmentFilterLastError = error?.message || String(error);
    session.segmentFilterRuntimeInfo = buildSegmentFilterRuntimeInfo(runtimes, error);
    return {
      segments: normalizedFinalSegments,
      adjustments: [],
      applied: false,
      changed: false,
      runtimeInfo: session.segmentFilterRuntimeInfo,
    };
  }
}

async function finalizeNewLiveSegments(
  session,
  finalCandidates,
  smoothing,
  frames,
  currentTimeSec,
  finalCutoffSec,
  { finalizeAll = false, skipSegmentFilter = false } = {}
) {
  const state = ensureLiveFinalizationState(session);
  const newCandidates = selectNewFinalizationCandidates(session, finalCandidates);
  if (!newCandidates.length) {
    return {
      segments: sortReportSegments(state.segments, { provisional: false }),
      adjustments: state.adjustments,
      applied: state.filterApplied,
      runtimeInfo: state.runtimeInfo || session.segmentFilterRuntimeInfo || buildSegmentFilterRuntimeInfo(),
    };
  }

  const previousFinalEndSec = state.segments.length
    ? Math.max(...state.segments.map((segment) => Number(segment.endSec) || 0))
    : null;
  const filtered = await applyLiveSegmentFilterToFinalSegments(
    session,
    newCandidates,
    smoothing,
    frames,
    currentTimeSec,
    finalCutoffSec,
    { finalizeAll, lowerBoundSec: previousFinalEndSec, skipSegmentFilter }
  );
  const nextState = appendLiveFinalizedSegments(session, newCandidates, filtered);
  return {
    segments: sortReportSegments(nextState.segments, { provisional: false }),
    adjustments: nextState.adjustments,
    applied: nextState.filterApplied,
    runtimeInfo: nextState.runtimeInfo || session.segmentFilterRuntimeInfo || buildSegmentFilterRuntimeInfo(),
  };
}

async function buildActiveReportSegments(session, currentTimeSec, { finalizeAll = false, skipSegmentFilter = false } = {}) {
  const allFinalSegments = session.segmentTracker.getFinalSegments();
  const trackerProvisionalSegments = session.segmentTracker.getProvisionalSegments(currentTimeSec);
  const hasCompletedAnalysisRanges = Array.isArray(session.completedAnalysisRanges)
    && session.completedAnalysisRanges.length > 0;
  const effectiveSkipSegmentFilter = Boolean(skipSegmentFilter || hasCompletedAnalysisRanges);

  if (session.detectorMode !== DETECTOR_MODES.FIRERED_AED) {
    return {
      finalSegments: sortReportSegments(allFinalSegments),
      provisionalSegments: sortReportSegments(trackerProvisionalSegments, { provisional: true }),
      refinedBy: null,
      smoothingMethod: null,
    };
  }

  const smoothing = getCachedGlobalSmoothing(session, currentTimeSec, { finalizeAll });
  if (smoothing && Array.isArray(smoothing.segments)) {
    const smoothingFrames = getLiveSmoothingFrames(
      Array.isArray(session.analysisCache) ? session.analysisCache : [],
      currentTimeSec,
      { finalizeAll }
    );
    if (finalizeAll) {
      const lastSmoothingFrame = smoothingFrames[smoothingFrames.length - 1] || null;
      const smoothingEndSec = Math.max(
        Number(currentTimeSec) || 0,
        Number(lastSmoothingFrame?.timeSec) || 0,
        Number(smoothing.segments[smoothing.segments.length - 1]?.endSec) || 0
      );
      const filtered = await finalizeNewLiveSegments(
        session,
        smoothing.segments,
        smoothing,
        smoothingFrames,
        currentTimeSec,
        smoothingEndSec,
        { finalizeAll, skipSegmentFilter: effectiveSkipSegmentFilter }
      );
      return {
        finalSegments: sortReportSegments(filtered.segments),
        provisionalSegments: [],
        refinedBy: filtered.applied ? `${GLOBAL_SMOOTHING_VERSION}+${SEGMENT_FILTER_VERSION}` : GLOBAL_SMOOTHING_VERSION,
        smoothingMethod: filtered.applied
          ? `${smoothing.method || 'unknown'}+segment-filter-final`
          : smoothing.method || null,
        segmentFilterAdjustments: filtered.adjustments,
        segmentFilterRuntimeInfo: filtered.runtimeInfo,
      };
    }

    const finalCutoffSec = Math.max(0, currentTimeSec - LIVE_FINALIZE_DELAY_SEC);
    const finalSegments = [];
    const provisionalSegments = [];

    for (const segment of smoothing.segments) {
      if (Number(segment.endSec) <= finalCutoffSec) {
        finalSegments.push(segment);
      } else {
        provisionalSegments.push({ ...segment, provisional: true });
      }
    }

    const filtered = await finalizeNewLiveSegments(
      session,
      finalSegments,
      smoothing,
      smoothingFrames,
      currentTimeSec,
      finalCutoffSec,
      { finalizeAll, skipSegmentFilter: effectiveSkipSegmentFilter }
    );
    const visibleProvisionalSegments = provisionalSegments
      .filter((segment) => !filtered.segments.some((knownSegment) => segmentsOverlap(knownSegment, segment)));

    for (const segment of trackerProvisionalSegments) {
      const overlapsKnownSegment = [...filtered.segments, ...visibleProvisionalSegments]
        .some((knownSegment) => segmentsOverlap(knownSegment, segment));
      if (!overlapsKnownSegment) {
        visibleProvisionalSegments.push(segment);
      }
    }

    return {
      finalSegments: sortReportSegments(filtered.segments),
      provisionalSegments: sortReportSegments(visibleProvisionalSegments, { provisional: true }),
      refinedBy: filtered.applied ? `${GLOBAL_SMOOTHING_VERSION}+${SEGMENT_FILTER_VERSION}` : GLOBAL_SMOOTHING_VERSION,
      smoothingMethod: filtered.applied
        ? `${smoothing.method || 'unknown'}+segment-filter-final`
        : smoothing.method || null,
      segmentFilterAdjustments: filtered.adjustments,
      segmentFilterRuntimeInfo: filtered.runtimeInfo,
    };
  }

  const finalCutoffSec = Math.max(0, currentTimeSec - LIVE_FINALIZE_DELAY_SEC);
  const finalizationState = ensureLiveFinalizationState(session);
  const finalSegments = sortReportSegments(finalizationState.segments, { provisional: false });
  const delayedFinalSegments = [];

  for (const segment of allFinalSegments) {
    if (Number(segment.endSec) <= finalCutoffSec) {
      const overlapsFrozen = finalSegments.some((knownSegment) => segmentsOverlap(knownSegment, segment));
      if (!overlapsFrozen) finalSegments.push(segment);
    } else {
      delayedFinalSegments.push({ ...segment, provisional: true });
    }
  }
  const visibleDelayedFinalSegments = delayedFinalSegments
    .filter((segment) => !finalSegments.some((knownSegment) => segmentsOverlap(knownSegment, segment)));

  return {
    finalSegments: sortReportSegments(finalSegments),
    provisionalSegments: sortReportSegments([...visibleDelayedFinalSegments, ...trackerProvisionalSegments], { provisional: true }),
    refinedBy: null,
    smoothingMethod: null,
  };
}

function getCompletedRangeSegments(session) {
  const ranges = Array.isArray(session.completedAnalysisRanges) ? session.completedAnalysisRanges : [];
  return ranges.flatMap((range) => Array.isArray(range.finalSegments) ? range.finalSegments : []);
}

function cloneLiveAnalysisFrameForCompletedRange(frame) {
  if (!frame || typeof frame !== 'object') return null;
  return normalizeAnalysisFrame(frame);
}

function getCompletedRangeAnalysisFrames(session) {
  const ranges = Array.isArray(session.completedAnalysisRanges) ? session.completedAnalysisRanges : [];
  return ranges
    .flatMap((range) => Array.isArray(range.analysisFrames) ? range.analysisFrames : [])
    .filter(Boolean);
}

function mergeAnalysisFramesForFinalization(...frameLists) {
  const frames = frameLists.flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((frame) => Number.isFinite(Number(frame?.timeSec)))
    .sort((a, b) => Number(a.timeSec) - Number(b.timeSec));
  const output = [];
  for (const frame of frames) {
    const previous = output[output.length - 1];
    if (previous && Math.abs(Number(previous.timeSec) - Number(frame.timeSec)) < 0.05) {
      output[output.length - 1] = frame;
    } else {
      output.push(frame);
    }
  }
  return output;
}

function mergeReportSegments(completedSegments, activeSegments) {
  return sortReportSegments([...completedSegments, ...activeSegments])
    .filter((segment, index, list) => {
      const duplicateIndex = list.findIndex((candidate) => (
        Math.abs(Number(candidate.startSec) - Number(segment.startSec)) < 0.001
        && Math.abs(Number(candidate.endSec) - Number(segment.endSec)) < 0.001
      ));
      return duplicateIndex === index;
    });
}

function summarizeCompletedAnalysisRanges(session) {
  const ranges = Array.isArray(session?.completedAnalysisRanges) ? session.completedAnalysisRanges : [];
  const reasonCounts = {};
  let frameCount = 0;
  let segmentCount = 0;

  for (const range of ranges) {
    const reason = String(range?.reason || 'unknown');
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    frameCount += Number(range?.analysisCacheSummary?.frameCount) || 0;
    segmentCount += Array.isArray(range?.finalSegments) ? range.finalSegments.length : 0;
  }

  return {
    count: ranges.length,
    frameCount,
    segmentCount,
    reasons: reasonCounts,
    ranges: ranges.slice(-40).map((range) => ({
      reason: range?.reason || null,
      startSec: Number.isFinite(Number(range?.startSec)) ? roundNumber(Number(range.startSec), 3) : null,
      endSec: Number.isFinite(Number(range?.endSec)) ? roundNumber(Number(range.endSec), 3) : null,
      frameCount: Number(range?.analysisCacheSummary?.frameCount) || 0,
      segmentCount: Array.isArray(range?.finalSegments) ? range.finalSegments.length : 0,
      smoothingMethod: range?.smoothingMethod || null,
      segmentFilterAdjustmentCount: Number(range?.segmentFilterAdjustmentCount) || 0,
    })),
  };
}

function buildCompletedRangesSummary(session, activeSummary = null) {
  const ranges = Array.isArray(session.completedAnalysisRanges) ? session.completedAnalysisRanges : [];
  if (!ranges.length) return activeSummary;

  const completedRangesSummary = summarizeCompletedAnalysisRanges(session);

  return {
    ...(activeSummary || {}),
    smoothingVersion: GLOBAL_SMOOTHING_VERSION,
    completedRangeCount: completedRangesSummary.count,
    completedFrameCount: completedRangesSummary.frameCount,
    activeFrameCount: Number(activeSummary?.frameCount) || 0,
    frameCount: completedRangesSummary.frameCount + (Number(activeSummary?.frameCount) || 0),
    segmentCount: completedRangesSummary.segmentCount + (Number(activeSummary?.segmentCount) || 0),
    discontinuities: Number(session.analysisCacheDiscontinuities) || 0,
    completedRangesSummary,
  };
}

async function buildLiveReportSegments(session, currentTimeSec, { finalizeAll = false } = {}) {
  const activeReport = await buildActiveReportSegments(session, currentTimeSec, { finalizeAll });
  const completedSegments = getCompletedRangeSegments(session);
  let finalSegments = mergeReportSegments(completedSegments, activeReport.finalSegments);
  let segmentFilterAdjustments = activeReport.segmentFilterAdjustments || [];
  let segmentFilterRuntimeInfo = activeReport.segmentFilterRuntimeInfo || null;
  let refinedBy = activeReport.refinedBy || null;
  let smoothingMethod = activeReport.smoothingMethod || null;

  if (finalizeAll && completedSegments.length && session.detectorMode === DETECTOR_MODES.FIRERED_AED) {
    const finalizationFrames = mergeAnalysisFramesForFinalization(
      getCompletedRangeAnalysisFrames(session),
      session.analysisCache
    );
    if (finalizationFrames.length >= 20 && finalSegments.length) {
      const firstFrame = finalizationFrames[0] || null;
      const lastFrame = finalizationFrames[finalizationFrames.length - 1] || null;
      const smoothingEndSec = Math.max(
        Number(currentTimeSec) || 0,
        Number(lastFrame?.timeSec) || 0,
        Number(finalSegments[finalSegments.length - 1]?.endSec) || 0
      );
      const smoothing = smoothFireRedAnalyses(finalizationFrames, smoothingEndSec, {
        startSec: Number(firstFrame?.timeSec) || 0,
        minSegmentDurationSec: session.minSegmentDurationSec,
        smoothingProfile: segmentFilterProfileForLiveAnalysisMethod(session.liveAnalysisMethod),
      });
      const filtered = await applyLiveSegmentFilterToFinalSegments(
        session,
        finalSegments,
        smoothing,
        finalizationFrames,
        currentTimeSec,
        smoothingEndSec,
        {
          finalizeAll,
          lowerBoundSec: null,
          skipSegmentFilter: false,
          disableEdgeTrim: true,
        }
      );
      finalSegments = sortReportSegments(filtered.segments, { provisional: false });
      segmentFilterAdjustments = filtered.adjustments || [];
      segmentFilterRuntimeInfo = filtered.runtimeInfo || segmentFilterRuntimeInfo;
      refinedBy = filtered.applied
        ? `${GLOBAL_SMOOTHING_VERSION}+${SEGMENT_FILTER_VERSION}`
        : refinedBy;
      smoothingMethod = filtered.applied
        ? `${smoothing.method || 'unknown'}+segment-filter-final-global`
        : smoothingMethod;
    }
  }

  return {
    ...activeReport,
    finalSegments,
    provisionalSegments: sortReportSegments(activeReport.provisionalSegments, { provisional: true }),
    refinedBy,
    smoothingMethod,
    segmentFilterAdjustments,
    segmentFilterRuntimeInfo,
  };
}

async function captureCompletedAnalysisRange(session, finalTimeSec, reason = 'discontinuity') {
  const frames = Array.isArray(session.analysisCache) ? session.analysisCache : [];
  if (session.detectorMode === DETECTOR_MODES.FIRERED_AED) {
    // Discontinuity finalization must match Stop finalization: rebuild from the
    // full active frame cache instead of preserving earlier streaming freezes.
    resetLiveFinalizationState(session);
    session.liveSmoothingCache = null;
  }
  const activeReport = await buildActiveReportSegments(session, finalTimeSec, {
    finalizeAll: true,
    skipSegmentFilter: true,
  });
  const finalSegments = sortReportSegments(activeReport.finalSegments);
  if (!frames.length && !finalSegments.length) return false;

  const firstFrame = frames[0] || null;
  const lastFrame = frames[frames.length - 1] || null;
  const analysisCacheSummary = buildAnalysisCacheSummary(session, finalSegments);
  const analysisFrames = frames
    .map(cloneLiveAnalysisFrameForCompletedRange)
    .filter(Boolean);
  const range = {
    reason,
    startSec: roundNumber(firstFrame?.timeSec ?? finalSegments[0]?.startSec ?? finalTimeSec, 3),
    endSec: roundNumber(Math.max(
      Number(finalTimeSec) || 0,
      Number(lastFrame?.timeSec) || 0,
      Number(finalSegments[finalSegments.length - 1]?.endSec) || 0
    ), 3),
    finalSegments,
    refinedBy: activeReport.refinedBy || null,
    smoothingMethod: activeReport.smoothingMethod || null,
    segmentFilterRuntimeInfo: activeReport.segmentFilterRuntimeInfo || null,
    segmentFilterAdjustmentCount: Array.isArray(activeReport.segmentFilterAdjustments)
      ? activeReport.segmentFilterAdjustments.length
      : 0,
    analysisCacheSummary,
    analysisFrames,
  };

  if (!Array.isArray(session.completedAnalysisRanges)) session.completedAnalysisRanges = [];
  session.completedAnalysisRanges.push(range);
  return true;
}

function resetActiveLiveAnalysisState(session) {
  if (!session) return;
  session.eventDecisionHistory = [];
  session.eventDecisionSnapshot = null;
  session.lastSingingAnchorSec = null;
  session.analysisCache = [];
  session.liveSmoothingCache = null;
  session.lastAnalysisFrameTimeSec = null;
  resetLiveFinalizationState(session);
  if (typeof session.detector?.resetAnalysisState === 'function') {
    session.detector.resetAnalysisState();
  }
  if (typeof session.segmentTracker?.reset === 'function') {
    session.segmentTracker.reset();
  }
}

async function closeActiveAnalysisRangeForDiscontinuity(session, currentTimeSec, reason = 'discontinuity') {
  if (!session || session.detectorMode !== DETECTOR_MODES.FIRERED_AED) return false;

  const flushedFrames = await flushDetectorPendingFrames(session);
  const lastFlushedFrame = Array.isArray(flushedFrames) ? flushedFrames[flushedFrames.length - 1] : null;
  const finalTimeSec = Math.max(
    Number(currentTimeSec) || 0,
    Number(session.lastAnalysisFrameTimeSec) || 0,
    Number(lastFlushedFrame?.timeSec) || 0
  );
  const forcedTransition = session.segmentTracker
    ? session.segmentTracker.finalizeAt(finalTimeSec)
    : false;
  const captured = await captureCompletedAnalysisRange(session, finalTimeSec, reason);

  resetActiveLiveAnalysisState(session);
  session.pendingAnalysisResumeAfterDiscontinuity = true;
  session.analysisCacheDiscontinuities = (Number(session.analysisCacheDiscontinuities) || 0) + (captured ? 1 : 0);
  return Boolean(forcedTransition || captured);
}

function computeNextIntegerSecond(currentTimeSec) {
  const current = Math.max(0, Number(currentTimeSec) || 0);
  const rounded = Math.round(current);
  if (Math.abs(current - rounded) <= 0.02) return rounded;
  return Math.ceil(current);
}

function snapLiveAnalysisTimeSec(session, currentTimeSec) {
  const current = toSeconds(currentTimeSec);
  const origin = Number.isFinite(Number(session?.analysisStartOriginSec))
    ? Number(session.analysisStartOriginSec)
    : Math.floor(current);
  const step = LIVE_ANALYSIS_TIME_GRID_SEC;
  if (!Number.isFinite(step) || step <= 0) return roundNumber(current, 3);
  if (current <= origin) return roundNumber(origin, 3);
  const steps = Math.max(0, Math.floor(((current - origin) / step) + 1e-6));
  return roundNumber(origin + (steps * step), 3);
}

function isWaitingForIntegerStart(session, currentTimeSec) {
  if (!session?.integerStartPending) return false;
  if (!Number.isFinite(Number(session.startAnalysisAtSec))) {
    session.startAnalysisAtSec = computeNextIntegerSecond(currentTimeSec);
  }
  return Number(currentTimeSec) + 0.001 < Number(session.startAnalysisAtSec);
}

function isAnalysisGateClosed(session) {
  return Boolean(session?.integerStartPending);
}

function openAnalysisGate(session, currentTimeSec) {
  const scheduledOriginSec = Number.isFinite(Number(session.startAnalysisAtSec))
    ? Number(session.startAnalysisAtSec)
    : computeNextIntegerSecond(currentTimeSec);
  const currentSec = toSeconds(currentTimeSec);
  const originSec = currentSec > scheduledOriginSec + LIVE_ANALYSIS_TIME_GRID_SEC
    ? computeNextIntegerSecond(currentSec)
    : scheduledOriginSec;
  session.integerStartPending = false;
  session.startAnalysisAtSec = null;
  session.analysisStartOriginSec = originSec;
  session.lastAnalysisFrameTimeSec = null;
  if (typeof session.detector?.setTimeOffsetSec === 'function') {
    session.detector.setTimeOffsetSec(originSec);
  }
  session.eventDecisionHistory = [];
  session.eventDecisionSnapshot = null;
  session.lastSingingAnchorSec = null;
  session.analysisCache = [];
  session.liveSmoothingCache = null;
  if (typeof session.segmentTracker?.reset === 'function') {
    session.segmentTracker.reset();
  }
  if (typeof session.detector?.resetAnalysisState === 'function') {
    session.detector.resetAnalysisState();
  }
  markPlaybackClock(session, currentTimeSec);
}

function resetIntegerStartGate(session, currentTimeSec) {
  if (!session) return;
  session.integerStartPending = true;
  session.startAnalysisAtSec = computeNextIntegerSecond(currentTimeSec);
  session.analysisStartOriginSec = null;
  session.lastAnalysisFrameTimeSec = null;
  if (typeof session.detector?.resetAnalysisState === 'function') {
    session.detector.resetAnalysisState();
  }
}

function getTrackerDebugState(tracker) {
  if (!tracker) return { state: 'idle', isSong: false };
  if (typeof tracker.getDebugState === 'function') return tracker.getDebugState();
  return {
    state: tracker.isSong ? 'song' : 'idle',
    isSong: Boolean(tracker.isSong),
    highCount: Number(tracker.highCount) || 0,
    lowCount: Number(tracker.lowCount) || 0,
    activeStartSec: tracker.activeStartSec ?? null,
  };
}

function buildDebugTracePayload(session) {
  if (!ENABLE_DEBUG_TRACE) return null;
  return {
    schemaVersion: 1,
    source: 'youtube-timeline-jumper',
    tabId: session.tabId,
    videoId: session.videoId || null,
    detectorMode: session.detectorMode,
    detectorVersion: session.detectorVersion,
    exportedAt: new Date().toISOString(),
    trackerState: getTrackerDebugState(session.segmentTracker),
    integerStart: {
      pending: Boolean(session.integerStartPending),
      startAnalysisAtSec: Number.isFinite(Number(session.startAnalysisAtSec)) ? Number(session.startAnalysisAtSec) : null,
      analysisStartOriginSec: Number.isFinite(Number(session.analysisStartOriginSec)) ? Number(session.analysisStartOriginSec) : null,
      lastAnalysisFrameTimeSec: Number.isFinite(Number(session.lastAnalysisFrameTimeSec)) ? Number(session.lastAnalysisFrameTimeSec) : null,
      gridSec: LIVE_ANALYSIS_TIME_GRID_SEC,
    },
    finalSegments: session.segmentTracker ? session.segmentTracker.getFinalSegments() : [],
    provisionalSegments: session.segmentTracker ? session.segmentTracker.getProvisionalSegments(session.lastPlaybackTimeSec || 0) : [],
    trace: Array.isArray(session.debugTrace) ? session.debugTrace.slice() : [],
  };
}

function appendDebugTrace(session, currentTimeSec, analysis, decisionResult, updateResult, beforeState) {
  if (!ENABLE_DEBUG_TRACE) return;
  if (!Array.isArray(session.debugTrace)) {
    session.debugTrace = [];
  }

  const snapshot = decisionResult?.snapshot || session.eventDecisionSnapshot || null;
  const afterState = getTrackerDebugState(session.segmentTracker);
  const entry = {
    timeSec: roundNumber(currentTimeSec, 3),
    detectorMode: session.detectorMode,
    detectorVersion: session.detectorVersion,
    beforeState: beforeState?.state || 'idle',
    afterState: afterState.state,
    decision: updateResult?.decision || snapshot?.decision || null,
    transitioned: Boolean(updateResult?.transitioned),
    songProbability: roundNumber(Number(decisionResult?.songProbability ?? analysis?.songProbability) || 0, 4),
    speechProbability: roundNumber(Number(analysis?.speechProbability ?? analysis?.speechMean) || 0, 4),
    singingProbability: roundNumber(Number(analysis?.singingProbability ?? analysis?.singingMean) || 0, 4),
    musicProbability: roundNumber(Number(analysis?.musicProbability ?? analysis?.musicMean) || 0, 4),
    speechMean: roundNumber(Number(analysis?.speechMean) || 0, 4),
    singingMean: roundNumber(Number(analysis?.singingMean) || 0, 4),
    musicMean: roundNumber(Number(analysis?.musicMean) || 0, 4),
    speechRatio: roundNumber(Number(analysis?.speechRatio) || 0, 4),
    singingRatio: roundNumber(Number(analysis?.singingRatio) || 0, 4),
    musicRatio: roundNumber(Number(analysis?.musicRatio) || 0, 4),
    signals: snapshot,
    tracker: afterState,
  };

  session.debugTrace.push(entry);
  if (session.debugTrace.length > MAX_DEBUG_TRACE_FRAMES) {
    session.debugTrace.splice(0, session.debugTrace.length - MAX_DEBUG_TRACE_FRAMES);
  }
}

function serializeStartupError(error) {
  return {
    name: error?.name || null,
    message: error?.message || String(error || ''),
    stack: error?.stack || null,
  };
}

function makeStartupDebug(phase, extra = {}) {
  return {
    source: 'offscreen',
    phase,
    timestamp: new Date().toISOString(),
    location: globalThis.location ? globalThis.location.href : null,
    userAgent: navigator?.userAgent || null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBufferAvailable: typeof globalThis.SharedArrayBuffer === 'function',
    extra,
  };
}

function buildMonoChunk(inputBuffer) {
  const channels = inputBuffer.numberOfChannels;
  const frameLength = inputBuffer.length;
  const mono = new Float32Array(frameLength);

  if (channels <= 0) return mono;

  for (let ch = 0; ch < channels; ch += 1) {
    const channelData = inputBuffer.getChannelData(ch);
    for (let i = 0; i < frameLength; i += 1) {
      mono[i] += channelData[i];
    }
  }

  const scale = 1 / channels;
  for (let i = 0; i < frameLength; i += 1) {
    mono[i] *= scale;
  }

  return mono;
}

function withTimeout(promise, timeoutMs) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  return Promise.race([promise, timeout])
    .finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function waitForAnalysisIdle(session, { timeoutMs = 5000 } = {}) {
  const startedAt = Date.now();
  while (session && (session.analysisLock || session.analysisScheduled)) {
    if (Date.now() - startedAt >= timeoutMs) return false;
    await delayMs(40);
  }
  return true;
}

async function flushDetectorPendingFrames(session, { onProgress = null } = {}) {
  if (!session || session.detectorMode !== DETECTOR_MODES.FIRERED_AED) return [];
  if (typeof session.detector?.flushPendingFrames !== 'function') return [];
  const frames = await session.detector.flushPendingFrames({ onProgress });
  consumeFireRedAnalysisFrames(session, frames);
  return frames;
}

async function requestPlaybackSnapshot(tabId) {
  try {
    const response = await withTimeout(
      chrome.runtime.sendMessage({ action: 'requestCurrentVideoTime', tabId }),
      PLAYBACK_SNAPSHOT_TIMEOUT_MS
    );
    if (!response || !response.success) return null;
    return response;
  } catch (error) {
    return null;
  }
}

function calibratePlaybackClock(session, snapshot) {
  if (!session || !snapshot || typeof snapshot.currentTime !== 'number') return;
  const currentTimeSec = toSeconds(snapshot.currentTime);
  const audioClockSec = Number(session.audioContext?.currentTime);
  const playbackRate = normalizePlaybackRate(snapshot.playbackRate);
  session.playbackRate = playbackRate;
  if (typeof session.detector?.setPlaybackRate === 'function') {
    session.detector.setPlaybackRate(playbackRate);
  }
  session.playbackClockCalibration = {
    currentTimeSec,
    audioClockSec: Number.isFinite(audioClockSec) ? audioClockSec : 0,
    wallTimeMs: Date.now(),
    playbackRate,
    videoId: snapshot.videoId || session.videoId || null,
  };
}

function estimatePlaybackSnapshot(session, options = {}) {
  const calibration = session?.playbackClockCalibration;
  if (!calibration) return null;

  const audioClockSec = Number(session.audioContext?.currentTime);
  if (!Number.isFinite(audioClockSec)) return null;

  const elapsedSec = Math.max(0, audioClockSec - calibration.audioClockSec);
  const playbackRate = Number.isFinite(Number(calibration.playbackRate)) ? calibration.playbackRate : 1;
  if (typeof session.detector?.setPlaybackRate === 'function') {
    session.detector.setPlaybackRate(playbackRate);
  }
  return {
    success: true,
    estimated: true,
    videoId: calibration.videoId || session.videoId || null,
    currentTime: Math.max(0, calibration.currentTimeSec + (elapsedSec * playbackRate)),
    playbackRate,
    paused: null,
    snapshotUnavailable: Boolean(options.snapshotUnavailable),
  };
}

async function resolvePlaybackSnapshot(session) {
  if (
    session.playbackClockCalibration
    && Number.isFinite(Number(session.nextPlaybackSnapshotRetryAt))
    && Date.now() < Number(session.nextPlaybackSnapshotRetryAt)
  ) {
    const lastRealAt = Number(session.lastRealPlaybackSnapshotAt);
    const snapshotUnavailable = !Number.isFinite(lastRealAt)
      || Date.now() - lastRealAt >= PLAYBACK_SNAPSHOT_UNAVAILABLE_GRACE_MS;
    const estimated = estimatePlaybackSnapshot(session, { snapshotUnavailable });
    recordPlaybackSnapshotDiagnostics(session, estimated, 'estimated');
    return estimated;
  }

  const snapshot = await requestPlaybackSnapshot(session.tabId);
  if (snapshot && typeof snapshot.currentTime === 'number') {
    session.playbackSnapshotFailureCount = 0;
    session.nextPlaybackSnapshotRetryAt = null;
    session.lastRealPlaybackSnapshotAt = Date.now();
    calibratePlaybackClock(session, snapshot);
    const realSnapshot = { ...snapshot, estimated: false };
    recordPlaybackSnapshotDiagnostics(session, realSnapshot, 'real');
    return realSnapshot;
  }

  session.playbackSnapshotFailureCount = (Number(session.playbackSnapshotFailureCount) || 0) + 1;
  recordPlaybackSnapshotDiagnostics(session, null, 'failure');
  session.nextPlaybackSnapshotRetryAt = Date.now() + Math.min(5000, session.playbackSnapshotFailureCount * 1000);
  const lastRealAt = Number(session.lastRealPlaybackSnapshotAt);
  const snapshotUnavailable = !Number.isFinite(lastRealAt)
    || Date.now() - lastRealAt >= PLAYBACK_SNAPSHOT_UNAVAILABLE_GRACE_MS;
  const estimated = estimatePlaybackSnapshot(session, { snapshotUnavailable });
  recordPlaybackSnapshotDiagnostics(session, estimated, 'estimated');
  return estimated;
}

async function requestCurrentVideoId(tabId) {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'requestCurrentVideoId', tabId });
    if (!response || !response.success) return null;
    return response.videoId || null;
  } catch (error) {
    return null;
  }
}

async function detectVideoBoundary(session, snapshot) {
  if (!session || snapshot?.estimated) return null;
  const knownVideoId = session.videoId || null;
  if (!knownVideoId) return null;

  const snapshotVideoId = snapshot?.videoId || null;
  if (snapshotVideoId && snapshotVideoId !== knownVideoId) {
    const diagnostics = ensurePlaybackDiagnostics(session);
    diagnostics.videoBoundaryCount += 1;
    recordPlaybackDiagnosticEvent(session, 'video-boundary', {
      reason: 'videoChanged',
      previousVideoId: knownVideoId,
      nextVideoId: snapshotVideoId,
    });
    return { reason: 'videoChanged', previousVideoId: knownVideoId, nextVideoId: snapshotVideoId };
  }

  if (!snapshotVideoId) {
    const currentVideoId = await requestCurrentVideoId(session.tabId);
    if (currentVideoId && currentVideoId !== knownVideoId) {
      const diagnostics = ensurePlaybackDiagnostics(session);
      diagnostics.videoBoundaryCount += 1;
      recordPlaybackDiagnosticEvent(session, 'video-boundary', {
        reason: 'videoChanged',
        previousVideoId: knownVideoId,
        nextVideoId: currentVideoId,
      });
      return { reason: 'videoChanged', previousVideoId: knownVideoId, nextVideoId: currentVideoId };
    }
    const currentTimeSec = Number(snapshot?.currentTime);
    const lastTimeSec = Number(session.lastPlaybackTimeSec);
    if (!currentVideoId && Number.isFinite(currentTimeSec) && Number.isFinite(lastTimeSec) && lastTimeSec > 30 && currentTimeSec < 5) {
      const diagnostics = ensurePlaybackDiagnostics(session);
      diagnostics.videoBoundaryCount += 1;
      recordPlaybackDiagnosticEvent(session, 'video-boundary', {
        reason: 'videoChangedUnknown',
        previousVideoId: knownVideoId,
        nextVideoId: null,
        currentTimeSec: roundNumber(currentTimeSec, 3),
        lastTimeSec: roundNumber(lastTimeSec, 3),
      });
      return { reason: 'videoChangedUnknown', previousVideoId: knownVideoId, nextVideoId: null };
    }
  }

  return null;
}

async function notifyStatus(session, status, extra = {}) {
  const normalized = normalizeDetectionStatus(status);
  const nextError = extra.error || null;
  const nextWarning = extra.warning || session.warning || null;
  const nextMode = extra.detectorMode || session.detectorMode;
  const nextVersion = extra.detectorVersion || session.detectorVersion;
  const hasRuntimeInfoOverride = Object.prototype.hasOwnProperty.call(extra, 'runtimeInfo');
  const nextRuntimeInfo = hasRuntimeInfoOverride
    ? extra.runtimeInfo
    : (typeof session.detector?.getRuntimeInfo === 'function'
      ? session.detector.getRuntimeInfo()
      : session.runtimeInfo || null);
  const runtimeFrameDistribution = session.detectorMode === DETECTOR_MODES.FIRERED_AED
    && Array.isArray(session.analysisCache)
    && session.analysisCache.length >= 20
    ? summarizeRecentAnalysisFrameDistribution(session.analysisCache, {
      windowSec: LIVE_RUNTIME_FRAME_DISTRIBUTION_WINDOW_SEC,
    })
    : null;
  const runtimeStatusSignature = JSON.stringify({
    mode: nextRuntimeInfo?.liveFrameBuilder?.mode || null,
    chunkSec: nextRuntimeInfo?.liveFrameBuilder?.chunkSec || null,
    playbackRate: Number(nextRuntimeInfo?.liveFrameBuilder?.bufferedPcm?.playbackRate) || 1,
    captureSuspended: Boolean(session.audioCaptureSuspended),
    captureSuspendedReason: session.audioCaptureSuspendedReason || null,
    skippedAudioSecBucket: Math.floor((Number(session.suspendedAudioSec) || 0) / 5),
    frameDistributionFrameBucket: Math.floor((Number(runtimeFrameDistribution?.frameCount) || 0) / 20),
    modelHighRatioBucket: Math.floor((Number(runtimeFrameDistribution?.modelHighRatio) || 0) * 20),
    singingHighRatioBucket: Math.floor((Number(runtimeFrameDistribution?.singingHighRatio) || 0) * 20),
    musicOnlyRatioBucket: Math.floor((Number(runtimeFrameDistribution?.musicOnlyLowVocalRatio) || 0) * 20),
    chunkProgressSecBucket: Math.floor((Number(
      nextRuntimeInfo?.liveFrameBuilder?.bufferedPcm?.chunkProgressSec
      ?? nextRuntimeInfo?.liveFrameBuilder?.bufferedPcm?.bufferedSec
    ) || 0) / 5),
    totalAnalyzedSecBucket: Math.floor((Number(nextRuntimeInfo?.liveFrameBuilder?.bufferedPcm?.totalAnalyzedSec) || 0) / 5),
  });
  const shouldReportRuntimeProgress = runtimeStatusSignature !== session.lastRuntimeStatusSignature
    && Date.now() - (Number(session.lastRuntimeStatusAt) || 0) >= LIVE_RUNTIME_STATUS_INTERVAL_MS;

  if (
    session.status === normalized
    && session.error === nextError
    && session.warning === nextWarning
    && session.detectorMode === nextMode
    && session.detectorVersion === nextVersion
    && !shouldReportRuntimeProgress
  ) {
    return;
  }

  session.status = normalized;
  session.error = nextError;
  session.warning = nextWarning;
  session.detectorMode = nextMode;
  session.detectorVersion = nextVersion;
  session.runtimeInfo = nextRuntimeInfo;
  if (session.runtimeInfo?.liveFrameBuilder) {
    session.runtimeInfo.liveFrameBuilder.captureSuspended = Boolean(session.audioCaptureSuspended);
    session.runtimeInfo.liveFrameBuilder.captureSuspendedReason = session.audioCaptureSuspendedReason || null;
    session.runtimeInfo.liveFrameBuilder.captureSuspensionStats = buildCaptureSuspensionStats(session);
    session.runtimeInfo.liveFrameBuilder.frameDistribution = runtimeFrameDistribution;
  }
  if (Number.isFinite(Number(session.playbackRate)) && session.runtimeInfo?.liveFrameBuilder?.bufferedPcm) {
    session.runtimeInfo.liveFrameBuilder.bufferedPcm.playbackRate = roundNumber(session.playbackRate, 3);
    const bufferedPcm = session.runtimeInfo.liveFrameBuilder.bufferedPcm;
    if (!Number.isFinite(Number(bufferedPcm.videoChunkProgressSec)) && Number.isFinite(Number(bufferedPcm.chunkProgressSec))) {
      bufferedPcm.videoChunkProgressSec = roundNumber(Number(bufferedPcm.chunkProgressSec) * session.playbackRate, 3);
    }
    if (!Number.isFinite(Number(bufferedPcm.videoTotalCapturedSec)) && Number.isFinite(Number(bufferedPcm.totalCapturedSec))) {
      bufferedPcm.videoTotalCapturedSec = roundNumber(Number(bufferedPcm.totalCapturedSec) * session.playbackRate, 3);
    }
    if (!Number.isFinite(Number(bufferedPcm.videoTotalAnalyzedSec)) && Number.isFinite(Number(bufferedPcm.totalAnalyzedSec))) {
      bufferedPcm.videoTotalAnalyzedSec = roundNumber(Number(bufferedPcm.totalAnalyzedSec) * session.playbackRate, 3);
    }
  }
  session.lastRuntimeStatusSignature = runtimeStatusSignature;
  session.lastRuntimeStatusAt = Date.now();

  try {
    await chrome.runtime.sendMessage({
      action: 'songDetectionStatusChanged',
      tabId: session.tabId,
      videoId: session.videoId || null,
      status: normalized,
      error: nextError,
      warning: nextWarning,
      detectorMode: nextMode,
      liveAnalysisMethod: session.liveAnalysisMethod || DEFAULT_LIVE_ANALYSIS_METHOD,
      detectorVersion: nextVersion,
      runtimeInfo: nextRuntimeInfo,
      minSegmentDurationSec: session.minSegmentDurationSec,
    });
  } catch (error) {
    // Background service worker may be restarting; the next tick reports again.
  }
}

async function maybeReport(session, currentTimeSec, { force = false, finalizeAll = false } = {}) {
  if (finalizeAll && session.detectorMode === DETECTOR_MODES.FIRERED_AED) {
    // Streaming reports freeze old final segments for UI stability. On Stop, rebuild
    // from the full AED cache so final timestamps can still be corrected globally.
    resetLiveFinalizationState(session);
    session.liveSmoothingCache = null;
  }

  const {
    finalSegments,
    provisionalSegments,
    refinedBy = null,
    smoothingMethod = null,
    segmentFilterAdjustments = [],
    segmentFilterRuntimeInfo = null,
  } = await buildLiveReportSegments(session, currentTimeSec, { finalizeAll });
  const status = finalizeAll
    ? 'Stopped'
    : ((session.segmentTracker.isSong || provisionalSegments.length > 0)
      ? 'Detecting'
      : 'Listening');
  let activeSummary = finalizeAll && session.detectorMode === DETECTOR_MODES.FIRERED_AED
    ? buildAnalysisCacheSummary(session, finalSegments)
    : null;
  if (activeSummary) {
    activeSummary.liveFinalizationDiagnostics = buildLiveFinalizationDiagnostics(session, {
      currentTimeSec,
      finalSegments,
      provisionalSegments,
      segmentFilterAdjustments,
      segmentFilterRuntimeInfo,
    });
  }
  const analysisCacheSummary = finalizeAll
    ? buildCompletedRangesSummary(session, activeSummary)
    : null;
  const signature = buildSignature(
    finalSegments,
    provisionalSegments,
    status,
    session.videoId,
    session.detectorVersion,
    session.detectorMode
  );

  const now = Date.now();
  if (!force && signature === session.lastReportSignature && (now - session.lastReportAt) < REPORT_INTERVAL_MS) {
    return;
  }

  session.lastReportSignature = signature;
  session.lastReportAt = now;
  if (!session.videoId) return;

  try {
    await chrome.runtime.sendMessage({
      action: 'songSegmentsUpdated',
      tabId: session.tabId,
      videoId: session.videoId,
      status,
      detectorMode: session.detectorMode,
      liveAnalysisMethod: session.liveAnalysisMethod || DEFAULT_LIVE_ANALYSIS_METHOD,
      smoothingProfile: session.detectorMode === DETECTOR_MODES.FIRERED_AED
        ? segmentFilterProfileForLiveAnalysisMethod(session.liveAnalysisMethod)
        : null,
      detectorVersion: session.detectorVersion,
      finalSegments,
      provisionalSegments,
      currentTimeSec: roundNumber(currentTimeSec, 3),
      warning: session.warning || null,
      liveLookaheadSec: session.detectorMode === DETECTOR_MODES.FIRERED_AED ? LIVE_FINALIZE_DELAY_SEC : null,
      liveFinalizeDelaySec: session.detectorMode === DETECTOR_MODES.FIRERED_AED ? LIVE_FINALIZE_DELAY_SEC : null,
      liveResmoothWindowSec: session.detectorMode === DETECTOR_MODES.FIRERED_AED ? LIVE_RESMOOTH_WINDOW_SEC : null,
      liveResmoothIntervalSec: session.detectorMode === DETECTOR_MODES.FIRERED_AED ? LIVE_RESMOOTH_INTERVAL_SEC : null,
      refinedBy: finalizeAll ? refinedBy : null,
      smoothingMethod: finalizeAll ? smoothingMethod : null,
      segmentFilterRuntimeInfo: segmentFilterRuntimeInfo || null,
      segmentFilterAdjustmentCount: finalizeAll && Array.isArray(segmentFilterAdjustments)
        ? segmentFilterAdjustments.length
        : 0,
      analysisCacheSummary,
      minSegmentDurationSec: session.minSegmentDurationSec,
    });
  } catch (error) {
    // Ignore; the next reporting tick can retry.
  }
}

async function createTabAudioStream(streamId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
}

function normalizeThreshold(value, fallback, { min = 0.05, max = 0.95 } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function resolveTrackerThresholds(detectorMode, songThreshold = null) {
  if (detectorMode !== DETECTOR_MODES.FIRERED_AED) {
    return {
      start: HEURISTIC_TRACKER_START_THRESHOLD,
      end: HEURISTIC_TRACKER_END_THRESHOLD,
    };
  }

  const calibratedThreshold = normalizeThreshold(songThreshold, FIRERED_TRACKER_START_THRESHOLD, {
    min: 0.05,
    max: 0.95,
  });
  const start = normalizeThreshold(calibratedThreshold - FIRERED_TRACKER_START_MARGIN, FIRERED_TRACKER_START_THRESHOLD, {
    min: 0.08,
    max: 0.9,
  });
  const maxEnd = Math.max(0.05, start - 0.02);
  const end = normalizeThreshold(start - FIRERED_TRACKER_HYSTERESIS_GAP, FIRERED_TRACKER_END_THRESHOLD, {
    min: 0.05,
    max: maxEnd,
  });

  return { start, end };
}

function normalizeEventDecisionFrame(timeSec, analysis) {
  return {
    timeSec: toSeconds(timeSec),
    modelProbability: clamp(Number(analysis?.songProbability) || 0, 0, 1),
    singingProbability: clamp(Number(analysis?.singingProbability ?? analysis?.singingMean) || 0, 0, 1),
    musicProbability: clamp(Number(analysis?.musicProbability ?? analysis?.musicMean) || 0, 0, 1),
    speechProbability: clamp(Number(analysis?.speechProbability ?? analysis?.speechMean) || 0, 0, 1),
    singingRatio: clamp(Number(analysis?.singingRatio) || 0, 0, 1),
    musicRatio: clamp(Number(analysis?.musicRatio) || 0, 0, 1),
    speechRatio: clamp(Number(analysis?.speechRatio) || 0, 0, 1),
  };
}

function appendEventDecisionFrame(session, frame) {
  if (!Array.isArray(session.eventDecisionHistory)) {
    session.eventDecisionHistory = [];
  }

  session.eventDecisionHistory.push(frame);
  const minTimeSec = Math.max(0, frame.timeSec - FIRERED_DECISION_RULES.historyWindowSec);
  session.eventDecisionHistory = session.eventDecisionHistory.filter((item) => item.timeSec >= minTimeSec);
  return session.eventDecisionHistory;
}

function getWindowFrames(history, now, windowSec) {
  if (!Array.isArray(history) || !history.length) return [];
  const minTimeSec = Math.max(0, now - windowSec);
  return history.filter((frame) => frame.timeSec >= minTimeSec);
}

function summarizeEventFrames(frames) {
  const count = Array.isArray(frames) ? frames.length : 0;
  if (!count) {
    return {
      count: 0,
      modelMean: 0,
      singingMean: 0,
      singingMax: 0,
      singingRatio: 0,
      musicMean: 0,
      musicMax: 0,
      musicRatio: 0,
      speechMean: 0,
      speechMax: 0,
      speechRatio: 0,
      bgmRatio: 0,
      speechDominantRatio: 0,
    };
  }

  let modelTotal = 0;
  let singingTotal = 0;
  let musicTotal = 0;
  let speechTotal = 0;
  let singingMax = 0;
  let musicMax = 0;
  let speechMax = 0;
  let singingWindows = 0;
  let musicWindows = 0;
  let speechWindows = 0;
  let bgmWindows = 0;
  let speechDominantWindows = 0;

  for (const frame of frames) {
    modelTotal += frame.modelProbability;
    singingTotal += frame.singingProbability;
    musicTotal += frame.musicProbability;
    speechTotal += frame.speechProbability;
    singingMax = Math.max(singingMax, frame.singingProbability);
    musicMax = Math.max(musicMax, frame.musicProbability);
    speechMax = Math.max(speechMax, frame.speechProbability);

    if (frame.singingProbability >= FIRERED_DECISION_RULES.singingPresentThreshold || frame.singingRatio >= 0.18) {
      singingWindows += 1;
    }
    if (frame.musicProbability >= FIRERED_DECISION_RULES.musicPresentThreshold || frame.musicRatio >= 0.35) {
      musicWindows += 1;
    }
    if (frame.speechProbability >= FIRERED_DECISION_RULES.speechDominantThreshold || frame.speechRatio >= 0.35) {
      speechWindows += 1;
    }
    if (
      frame.musicProbability >= FIRERED_DECISION_RULES.musicPresentThreshold
      && frame.singingProbability <= FIRERED_DECISION_RULES.singingSoftThreshold
      && frame.singingRatio <= FIRERED_DECISION_RULES.bgmLowSingingRatio
    ) {
      bgmWindows += 1;
    }
    if (
      frame.speechProbability >= FIRERED_DECISION_RULES.speechDominantThreshold
      && frame.singingProbability <= FIRERED_DECISION_RULES.speechLowSingingCeiling
    ) {
      speechDominantWindows += 1;
    }
  }

  return {
    count,
    modelMean: modelTotal / count,
    singingMean: singingTotal / count,
    singingMax,
    singingRatio: singingWindows / count,
    musicMean: musicTotal / count,
    musicMax,
    musicRatio: musicWindows / count,
    speechMean: speechTotal / count,
    speechMax,
    speechRatio: speechWindows / count,
    bgmRatio: bgmWindows / count,
    speechDominantRatio: speechDominantWindows / count,
  };
}

function computeFireRedSingingSupport(shortStats, mediumStats, longStats) {
  const strongSinging = shortStats.singingMax >= FIRERED_DECISION_RULES.strongSingingThreshold ? 1 : 0;
  return clamp(
    (shortStats.singingRatio * 0.34)
      + (mediumStats.singingRatio * 0.32)
      + (longStats.singingRatio * 0.14)
      + (clamp(shortStats.singingMax / 0.85, 0, 1) * 0.14)
      + (strongSinging * 0.06),
    0,
    1
  );
}

function computeFireRedMusicSupport(shortStats, mediumStats, longStats) {
  return clamp(
    (shortStats.musicRatio * 0.32)
      + (mediumStats.musicRatio * 0.34)
      + (longStats.musicRatio * 0.16)
      + (clamp(shortStats.musicMean / 0.75, 0, 1) * 0.18),
    0,
    1
  );
}

function findSingingAnchoredStartSec(history, now) {
  if (!Array.isArray(history) || !history.length) return null;

  let anchorIndex = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const frame = history[i];
    if (now - frame.timeSec > FIRERED_DECISION_RULES.mediumWindowSec) break;
    if (
      frame.singingProbability >= FIRERED_DECISION_RULES.singingPresentThreshold
      || frame.singingRatio >= 0.18
    ) {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex < 0) return null;

  let startSec = history[anchorIndex].timeSec;
  for (let i = anchorIndex; i >= 0; i -= 1) {
    const frame = history[i];
    if (now - frame.timeSec > FIRERED_DECISION_RULES.introLookbackSec) break;

    const musicLike = frame.musicProbability >= FIRERED_DECISION_RULES.musicSoftThreshold || frame.musicRatio >= 0.2;
    const singingLike = frame.singingProbability >= FIRERED_DECISION_RULES.singingSoftThreshold || frame.singingRatio >= 0.08;
    const speechDominant = frame.speechProbability >= 0.68 && frame.singingProbability < 0.28;
    if (!musicLike && !singingLike) break;
    if (speechDominant) break;
    startSec = frame.timeSec;
  }

  return Math.max(0, startSec);
}

function applyFireRedDecisionRules(session, currentTimeSec, analysis) {
  const frame = normalizeEventDecisionFrame(currentTimeSec, analysis);
  const history = appendEventDecisionFrame(session, frame);
  const shortStats = summarizeEventFrames(getWindowFrames(history, frame.timeSec, FIRERED_DECISION_RULES.shortWindowSec));
  const mediumStats = summarizeEventFrames(getWindowFrames(history, frame.timeSec, FIRERED_DECISION_RULES.mediumWindowSec));
  const longStats = summarizeEventFrames(getWindowFrames(history, frame.timeSec, FIRERED_DECISION_RULES.longWindowSec));
  const trackerIsSong = Boolean(session?.segmentTracker?.isSong);
  const thresholds = session?.trackerThresholds || {};
  const startThreshold = Number.isFinite(thresholds.start) ? thresholds.start : FIRERED_TRACKER_START_THRESHOLD;
  const endThreshold = Number.isFinite(thresholds.end) ? thresholds.end : FIRERED_TRACKER_END_THRESHOLD;
  const temporalHeadReady = Boolean(analysis?.temporalHeadReady);
  const temporalHeadProbability = clamp(Number(analysis?.temporalHeadProbability ?? analysis?.songProbability) || 0, 0, 1);

  const singingSupport = computeFireRedSingingSupport(shortStats, mediumStats, longStats);
  const musicSupport = computeFireRedMusicSupport(shortStats, mediumStats, longStats);
  const speechEvidence = Math.max(shortStats.speechDominantRatio, mediumStats.speechDominantRatio * 0.85);
  const bgmEvidence = Math.max(shortStats.bgmRatio, mediumStats.bgmRatio * 0.9, longStats.bgmRatio * 0.75);
  const speechDominant = mediumStats.speechMean >= FIRERED_DECISION_RULES.speechDominantThreshold
    && shortStats.singingMean < FIRERED_DECISION_RULES.speechLowSingingCeiling;
  const hasAcousticSingingAnchor = !speechDominant && (
    shortStats.singingMax >= FIRERED_DECISION_RULES.singingPresentThreshold
    || shortStats.singingMean >= FIRERED_DECISION_RULES.singingMeanShortThreshold
    || mediumStats.singingMean >= FIRERED_DECISION_RULES.singingMeanMediumThreshold
    || shortStats.singingMax >= FIRERED_DECISION_RULES.strongSingingThreshold
  );
  const hasAcousticMusicSustain = shortStats.musicMax >= FIRERED_DECISION_RULES.musicPresentThreshold
    || mediumStats.musicMean >= FIRERED_DECISION_RULES.musicMeanMediumThreshold;
  const hasModelAnchor = temporalHeadReady && temporalHeadProbability >= startThreshold && !speechDominant;
  const hasModelSustain = temporalHeadReady && temporalHeadProbability >= endThreshold && !speechDominant;
  const hasSingingAnchor = hasAcousticSingingAnchor || hasModelAnchor;
  const hasMusicSustain = hasAcousticMusicSustain || hasModelSustain;

  if (hasSingingAnchor) {
    session.lastSingingAnchorSec = frame.timeSec;
  }

  const hasRecentAnchor = Number.isFinite(session.lastSingingAnchorSec)
    && (frame.timeSec - session.lastSingingAnchorSec) <= FIRERED_DECISION_RULES.anchorGraceSec;

  let adjusted;
  let startSecOverride = null;

  let decision = 'reject';

  if (trackerIsSong) {
    if (hasSingingAnchor) {
      adjusted = temporalHeadReady ? Math.max(temporalHeadProbability, startThreshold + 0.08) : startThreshold + 0.08;
      decision = 'active-anchor';
    } else if ((hasRecentAnchor || hasModelSustain) && hasMusicSustain && !speechDominant) {
      adjusted = temporalHeadReady
        ? Math.max(temporalHeadProbability, endThreshold + 0.08, 0.38)
        : Math.max(endThreshold + 0.08, 0.38);
      decision = 'active-music-sustain';
    } else {
      adjusted = 0;
      decision = speechDominant ? 'active-reject-speech' : 'active-low-evidence';
    }
  } else if (hasSingingAnchor) {
    adjusted = temporalHeadReady ? Math.max(temporalHeadProbability, startThreshold + 0.08) : startThreshold + 0.08;
    startSecOverride = findSingingAnchoredStartSec(history, frame.timeSec);
    decision = 'candidate-anchor';
  } else {
    adjusted = 0;
    decision = speechDominant ? 'reject-speech' : (hasMusicSustain ? 'reject-music-no-singing' : 'reject-low-evidence');
  }

  if (!hasSingingAnchor && !hasRecentAnchor && bgmEvidence > 0.24) {
    const penalty = Math.min(FIRERED_DECISION_RULES.bgmPenaltyMax, (bgmEvidence - 0.24) * 0.85);
    adjusted *= 1 - penalty;
  }

  session.eventDecisionSnapshot = {
    at: roundNumber(frame.timeSec, 3),
    raw: roundNumber(frame.modelProbability, 4),
    final: roundNumber(clamp(adjusted, 0, 1), 4),
    temporalHeadReady,
    temporalHeadProbability: roundNumber(temporalHeadProbability, 4),
    baseSongProbability: roundNumber(Number(analysis?.baseSongProbability) || frame.modelProbability, 4),
    singingSupport: roundNumber(singingSupport, 4),
    musicSupport: roundNumber(musicSupport, 4),
    speechEvidence: roundNumber(speechEvidence, 4),
    bgmEvidence: roundNumber(bgmEvidence, 4),
    hasAcousticSingingAnchor,
    hasAcousticMusicSustain,
    hasModelAnchor,
    hasModelSustain,
    hasSingingAnchor,
    hasRecentAnchor,
    hasMusicSustain,
    speechDominant,
    decision,
    startSecOverride: startSecOverride === null ? null : roundNumber(startSecOverride, 3),
  };

  return {
    songProbability: history.length < FIRERED_DECISION_RULES.minHistoryFrames
      ? frame.modelProbability
      : clamp(adjusted, 0, 1),
    startSecOverride,
    trackerEvidence: {
      songProbability: clamp(adjusted, 0, 1),
      confidence: clamp(adjusted, 0, 1),
      hasSingingAnchor,
      hasRecentAnchor: hasRecentAnchor || (trackerIsSong && hasModelSustain),
      hasMusicSustain,
      speechDominant,
      startSecOverride,
    },
    snapshot: session.eventDecisionSnapshot,
  };
}

function markPlaybackClock(session, currentTimeSec) {
  session.lastPlaybackTimeSec = toSeconds(currentTimeSec);
  session.lastPlaybackWallMs = Date.now();
  const audioClockSec = Number(session.audioContext?.currentTime);
  session.lastPlaybackAudioClockSec = Number.isFinite(audioClockSec) ? audioClockSec : null;
}

function setAudioCaptureSuspended(session, suspended, reason = null) {
  if (!session) return;
  const nextSuspended = Boolean(suspended);
  const nextReason = nextSuspended ? (reason || 'playback-not-advancing') : null;
  if (nextSuspended && (!session.audioCaptureSuspended || session.audioCaptureSuspendedReason !== nextReason)) {
    session.audioCaptureSuspensionCount = (Number(session.audioCaptureSuspensionCount) || 0) + 1;
    const diagnostics = ensurePlaybackDiagnostics(session);
    diagnostics.suspensionReasons[nextReason] = (Number(diagnostics.suspensionReasons[nextReason]) || 0) + 1;
    recordPlaybackDiagnosticEvent(session, 'capture-suspended', { reason: nextReason });
  } else if (!nextSuspended && session.audioCaptureSuspended) {
    recordPlaybackDiagnosticEvent(session, 'capture-resumed', {
      previousReason: session.audioCaptureSuspendedReason || null,
    });
  }
  session.audioCaptureSuspended = nextSuspended;
  session.audioCaptureSuspendedReason = nextReason;
}

function recordSuspendedAudioChunk(session, samples) {
  if (!session || !samples || !samples.length) return;
  const sampleRate = Math.max(1, Number(session.audioContext?.sampleRate) || 48000);
  const skippedSec = samples.length / sampleRate;
  const reason = session.audioCaptureSuspendedReason || 'unknown';
  session.suspendedAudioChunkCount = (Number(session.suspendedAudioChunkCount) || 0) + 1;
  session.suspendedAudioSec = (Number(session.suspendedAudioSec) || 0) + skippedSec;
  if (!session.suspendedAudioReasons || typeof session.suspendedAudioReasons !== 'object') {
    session.suspendedAudioReasons = {};
  }
  session.suspendedAudioReasons[reason] = (Number(session.suspendedAudioReasons[reason]) || 0) + skippedSec;
}

function buildCaptureSuspensionStats(session) {
  const reasons = {};
  const rawReasons = session?.suspendedAudioReasons || {};
  for (const [reason, seconds] of Object.entries(rawReasons)) {
    reasons[reason] = roundNumber(seconds, 3);
  }
  const lastRealSnapshotAt = Number(session?.lastRealPlaybackSnapshotAt);
  return {
    suspended: Boolean(session?.audioCaptureSuspended),
    reason: session?.audioCaptureSuspendedReason || null,
    skippedAudioSec: roundNumber(Number(session?.suspendedAudioSec) || 0, 3),
    skippedChunkCount: Math.max(0, Math.floor(Number(session?.suspendedAudioChunkCount) || 0)),
    suspensionCount: Math.max(0, Math.floor(Number(session?.audioCaptureSuspensionCount) || 0)),
    snapshotFailureCount: Math.max(0, Math.floor(Number(session?.playbackSnapshotFailureCount) || 0)),
    lastRealSnapshotAgeSec: Number.isFinite(lastRealSnapshotAt)
      ? roundNumber((Date.now() - lastRealSnapshotAt) / 1000, 3)
      : null,
    reasons,
  };
}

function createPlaybackDiagnostics() {
  return {
    events: [],
    counts: {},
    snapshot: {
      realCount: 0,
      estimatedCount: 0,
      failureCount: 0,
      unavailableCount: 0,
      lastRealAt: null,
      lastFailureAt: null,
      lastSnapshot: null,
    },
    suspensionReasons: {},
    seekCount: 0,
    videoBoundaryCount: 0,
  };
}

function ensurePlaybackDiagnostics(session) {
  if (!session.playbackDiagnostics || typeof session.playbackDiagnostics !== 'object') {
    session.playbackDiagnostics = createPlaybackDiagnostics();
  }
  if (!Array.isArray(session.playbackDiagnostics.events)) {
    session.playbackDiagnostics.events = [];
  }
  if (!session.playbackDiagnostics.counts || typeof session.playbackDiagnostics.counts !== 'object') {
    session.playbackDiagnostics.counts = {};
  }
  if (!session.playbackDiagnostics.snapshot || typeof session.playbackDiagnostics.snapshot !== 'object') {
    session.playbackDiagnostics.snapshot = createPlaybackDiagnostics().snapshot;
  }
  if (!session.playbackDiagnostics.suspensionReasons || typeof session.playbackDiagnostics.suspensionReasons !== 'object') {
    session.playbackDiagnostics.suspensionReasons = {};
  }
  return session.playbackDiagnostics;
}

function recordPlaybackDiagnosticEvent(session, type, details = {}) {
  if (!session) return;
  const diagnostics = ensurePlaybackDiagnostics(session);
  const eventType = String(type || 'unknown');
  diagnostics.counts[eventType] = (Number(diagnostics.counts[eventType]) || 0) + 1;
  const audioClockSec = Number(session.audioContext?.currentTime);
  diagnostics.events.push({
    at: new Date().toISOString(),
    type: eventType,
    playbackTimeSec: Number.isFinite(Number(session.lastPlaybackTimeSec))
      ? roundNumber(Number(session.lastPlaybackTimeSec), 3)
      : null,
    audioClockSec: Number.isFinite(audioClockSec) ? roundNumber(audioClockSec, 3) : null,
    ...details,
  });
  if (diagnostics.events.length > MAX_PLAYBACK_DIAGNOSTIC_EVENTS) {
    diagnostics.events.splice(0, diagnostics.events.length - MAX_PLAYBACK_DIAGNOSTIC_EVENTS);
  }
}

function recordPlaybackSnapshotDiagnostics(session, snapshot, kind) {
  if (!session) return;
  const diagnostics = ensurePlaybackDiagnostics(session);
  const normalizedKind = String(kind || 'unknown');
  if (normalizedKind === 'real') {
    diagnostics.snapshot.realCount += 1;
    diagnostics.snapshot.lastRealAt = new Date().toISOString();
  } else if (normalizedKind === 'estimated') {
    diagnostics.snapshot.estimatedCount += 1;
  } else if (normalizedKind === 'failure') {
    diagnostics.snapshot.failureCount += 1;
    diagnostics.snapshot.lastFailureAt = new Date().toISOString();
  }
  if (snapshot?.snapshotUnavailable) {
    diagnostics.snapshot.unavailableCount += 1;
  }
  if (snapshot && typeof snapshot.currentTime === 'number') {
    diagnostics.snapshot.lastSnapshot = {
      kind: normalizedKind,
      videoId: snapshot.videoId || session.videoId || null,
      currentTimeSec: roundNumber(Number(snapshot.currentTime) || 0, 3),
      playbackRate: roundNumber(normalizePlaybackRate(snapshot.playbackRate), 3),
      paused: typeof snapshot.paused === 'boolean' ? snapshot.paused : null,
      ended: typeof snapshot.ended === 'boolean' ? snapshot.ended : null,
      seeking: typeof snapshot.seeking === 'boolean' ? snapshot.seeking : null,
      readyState: Number.isFinite(Number(snapshot.readyState)) ? Number(snapshot.readyState) : null,
      networkState: Number.isFinite(Number(snapshot.networkState)) ? Number(snapshot.networkState) : null,
      estimated: Boolean(snapshot.estimated),
      snapshotUnavailable: Boolean(snapshot.snapshotUnavailable),
    };
  }
}

function summarizePlaybackDiagnostics(session) {
  const diagnostics = ensurePlaybackDiagnostics(session);
  return {
    counts: { ...diagnostics.counts },
    snapshot: { ...diagnostics.snapshot },
    suspensionReasons: { ...diagnostics.suspensionReasons },
    seekCount: Math.max(0, Math.floor(Number(diagnostics.seekCount) || 0)),
    videoBoundaryCount: Math.max(0, Math.floor(Number(diagnostics.videoBoundaryCount) || 0)),
    recentEvents: diagnostics.events.slice(-40),
  };
}

function summarizeDiagnosticSegment(segment) {
  const startSec = Number(segment?.startSec);
  const endSec = Number(segment?.endSec);
  return {
    startSec: roundNumber(Number.isFinite(startSec) ? startSec : 0, 3),
    endSec: roundNumber(Number.isFinite(endSec) ? endSec : 0, 3),
    durationSec: roundNumber(
      Number.isFinite(startSec) && Number.isFinite(endSec) ? Math.max(0, endSec - startSec) : 0,
      3
    ),
    confidence: roundNumber(Number(segment?.confidence) || 0, 4),
  };
}

function summarizeSegmentFilterAdjustments(adjustments = []) {
  const source = Array.isArray(adjustments) ? adjustments : [];
  const counts = {};
  const keepProbabilities = [];
  const notable = [];

  for (const adjustment of source) {
    const action = String(adjustment?.action || 'unknown');
    counts[action] = (counts[action] || 0) + 1;
    if (Number.isFinite(Number(adjustment?.keepProbability))) {
      keepProbabilities.push(Number(adjustment.keepProbability));
    }
    if (
      notable.length < 20
      && (action === 'drop' || action === 'trim' || action === 'keep-live-protected')
    ) {
      notable.push({
        index: Number.isInteger(adjustment.index) ? adjustment.index : null,
        action,
        keepProbability: Number.isFinite(Number(adjustment.keepProbability))
          ? roundNumber(Number(adjustment.keepProbability), 4)
          : null,
        original: adjustment.original ? summarizeDiagnosticSegment(adjustment.original) : null,
        segment: adjustment.segment ? summarizeDiagnosticSegment(adjustment.segment) : null,
        evidence: adjustment.evidence || null,
      });
    }
  }

  const probabilityMean = keepProbabilities.length
    ? keepProbabilities.reduce((sum, value) => sum + value, 0) / keepProbabilities.length
    : null;
  return {
    total: source.length,
    counts,
    keepProbabilityMean: probabilityMean === null ? null : roundNumber(probabilityMean, 4),
    notable,
  };
}

function buildLiveFinalizationDiagnostics(session, options = {}) {
  const finalSegments = Array.isArray(options.finalSegments) ? options.finalSegments : [];
  const provisionalSegments = Array.isArray(options.provisionalSegments) ? options.provisionalSegments : [];
  const state = ensureLiveFinalizationState(session);
  const runtimeInfo = options.segmentFilterRuntimeInfo || session.segmentFilterRuntimeInfo || null;
  const completedRangesSummary = summarizeCompletedAnalysisRanges(session);
  return {
    generatedAt: new Date().toISOString(),
    currentTimeSec: roundNumber(Number(options.currentTimeSec) || 0, 3),
    liveAnalysisMethod: session.liveAnalysisMethod || DEFAULT_LIVE_ANALYSIS_METHOD,
    smoothingProfile: segmentFilterProfileForLiveAnalysisMethod(session.liveAnalysisMethod),
    finalSegmentCount: finalSegments.length,
    provisionalSegmentCount: provisionalSegments.length,
    finalSegments: finalSegments.slice(0, 40).map(summarizeDiagnosticSegment),
    finalizationState: {
      sourceRangeCount: Array.isArray(state.sourceRanges) ? state.sourceRanges.length : 0,
      maxSourceEndSec: Number.isFinite(Number(state.maxSourceEndSec))
        ? roundNumber(Number(state.maxSourceEndSec), 3)
        : null,
      filterApplied: Boolean(state.filterApplied),
    },
    segmentFilter: {
      runtimeInfo,
      adjustmentSummary: summarizeSegmentFilterAdjustments(options.segmentFilterAdjustments),
    },
    completedAnalysisRanges: completedRangesSummary,
    playbackDiagnostics: summarizePlaybackDiagnostics(session),
    captureSuspensionStats: buildCaptureSuspensionStats(session),
  };
}

function getPlaybackSuspensionReason(snapshot = {}) {
  if (snapshot?.estimated) {
    return snapshot.snapshotUnavailable ? 'snapshot-unavailable' : null;
  }
  if (snapshot.ended === true) return 'ended';
  if (snapshot.paused === true) return 'paused';
  if (snapshot.seeking === true) return 'seeking';
  const readyState = Number(snapshot.readyState);
  if (Number.isFinite(readyState) && readyState < PLAYBACK_READY_STATE_HAVE_CURRENT_DATA) {
    return 'buffering';
  }
  return null;
}

function isContinuousPlaybackJump(session, delta, snapshot = {}) {
  if (snapshot?.estimated) return true;

  const wallDeltaSec = Number.isFinite(Number(session.lastPlaybackWallMs))
    ? (Date.now() - Number(session.lastPlaybackWallMs)) / 1000
    : null;
  const audioClockSec = Number(session.audioContext?.currentTime);
  const audioDeltaSec = Number.isFinite(audioClockSec) && Number.isFinite(Number(session.lastPlaybackAudioClockSec))
    ? audioClockSec - Number(session.lastPlaybackAudioClockSec)
    : null;

  const matchesWallClock = Number.isFinite(wallDeltaSec)
    && Math.abs(delta - wallDeltaSec) <= PLAYBACK_CLOCK_CONTINUITY_TOLERANCE_SEC;
  const matchesAudioClock = Number.isFinite(audioDeltaSec)
    && Math.abs(delta - audioDeltaSec) <= PLAYBACK_CLOCK_CONTINUITY_TOLERANCE_SEC;

  return matchesWallClock || matchesAudioClock;
}

async function reconcilePlaybackClock(session, currentTimeSec, snapshot = {}) {
  const current = toSeconds(currentTimeSec);
  const last = Number(session.lastPlaybackTimeSec);
  const suspensionReason = getPlaybackSuspensionReason(snapshot);
  const previousSuspensionReason = session.audioCaptureSuspendedReason || null;
  let resumedAfterSnapshotUnavailable = false;

  if (
    session.pendingAnalysisResumeAfterDiscontinuity
    && !snapshot?.estimated
    && suspensionReason !== 'snapshot-unavailable'
  ) {
    session.pendingAnalysisResumeAfterDiscontinuity = false;
    resetIntegerStartGate(session, current);
    resumedAfterSnapshotUnavailable = true;
  }

  if (suspensionReason) {
    session.playbackStallCount = 0;
    let forcedTransition = resumedAfterSnapshotUnavailable;
    setAudioCaptureSuspended(session, true, suspensionReason);
    if (suspensionReason === 'snapshot-unavailable' && previousSuspensionReason !== 'snapshot-unavailable') {
      forcedTransition = await closeActiveAnalysisRangeForDiscontinuity(session, current, 'snapshot-unavailable');
    }
    recordPlaybackDiagnosticEvent(session, 'playback-not-analyzable', {
      reason: suspensionReason,
      currentTimeSec: roundNumber(current, 3),
      readyState: Number.isFinite(Number(snapshot.readyState)) ? Number(snapshot.readyState) : null,
      paused: typeof snapshot.paused === 'boolean' ? snapshot.paused : null,
      seeking: typeof snapshot.seeking === 'boolean' ? snapshot.seeking : null,
    });
    markPlaybackClock(session, current);
    return { shouldAnalyze: false, forcedTransition };
  }

  if (previousSuspensionReason === 'snapshot-unavailable' || resumedAfterSnapshotUnavailable) {
    session.playbackStallCount = 0;
    setAudioCaptureSuspended(session, false);
    if (!resumedAfterSnapshotUnavailable) {
      resetIntegerStartGate(session, current);
    }
    markPlaybackClock(session, current);
    return { shouldAnalyze: false, forcedTransition: true };
  }

  if (!Number.isFinite(last)) {
    setAudioCaptureSuspended(session, false);
    markPlaybackClock(session, current);
    return { shouldAnalyze: true, forcedTransition: false };
  }

  const delta = current - last;
  const looksLikeSeek = delta < -2
    || (delta > PLAYBACK_CLOCK_SEEK_JUMP_SEC && !isContinuousPlaybackJump(session, delta, snapshot));
  if (looksLikeSeek) {
    const diagnostics = ensurePlaybackDiagnostics(session);
    diagnostics.seekCount += 1;
    recordPlaybackDiagnosticEvent(session, 'playback-seek', {
      direction: delta < 0 ? 'backward' : 'forward',
      deltaSec: roundNumber(delta, 3),
      previousTimeSec: roundNumber(Number.isFinite(last) ? last : 0, 3),
      currentTimeSec: roundNumber(current, 3),
      estimatedSnapshot: Boolean(snapshot?.estimated),
    });
    const forcedTransition = session.segmentTracker
      ? session.segmentTracker.finalizeAt(Math.max(0, last))
      : false;
    await captureCompletedAnalysisRange(session, Math.max(0, last), delta < 0 ? 'seek-backward' : 'seek-forward');
    session.eventDecisionHistory = [];
    session.eventDecisionSnapshot = null;
    session.lastSingingAnchorSec = null;
    session.analysisCache = [];
    session.liveSmoothingCache = null;
    resetLiveFinalizationState(session);
    session.analysisCacheDiscontinuities = (Number(session.analysisCacheDiscontinuities) || 0) + 1;
    if (typeof session.detector?.resetAnalysisState === 'function') {
      session.detector.resetAnalysisState();
    }
    if (typeof session.segmentTracker?.reset === 'function') {
      session.segmentTracker.reset();
    }
    session.playbackStallCount = 0;
    setAudioCaptureSuspended(session, true, delta < 0 ? 'seek-backward' : 'seek-forward');
    resetIntegerStartGate(session, current);
    markPlaybackClock(session, current);
    return { shouldAnalyze: false, forcedTransition };
  }

  if (delta < 0.05) {
    session.playbackStallCount = (Number(session.playbackStallCount) || 0) + 1;
    if (session.playbackStallCount >= 2) {
      if (!session.audioCaptureSuspended || session.audioCaptureSuspendedReason !== 'stalled') {
        recordPlaybackDiagnosticEvent(session, 'playback-stalled', {
          currentTimeSec: roundNumber(current, 3),
          stallCount: session.playbackStallCount,
          estimatedSnapshot: Boolean(snapshot?.estimated),
        });
      }
      setAudioCaptureSuspended(session, true, 'stalled');
    }
    markPlaybackClock(session, current);
    return { shouldAnalyze: false, forcedTransition: false };
  }

  session.playbackStallCount = 0;
  setAudioCaptureSuspended(session, false);
  markPlaybackClock(session, current);
  return { shouldAnalyze: true, forcedTransition: false };
}

function createHeuristicDetector(session, warning = null) {
  const heuristic = new HeuristicSongDetector();
  heuristic.attachAnalyser(session.analyser);
  return {
    detector: heuristic,
    detectorMode: DETECTOR_MODES.HEURISTIC,
    detectorVersion: HEURISTIC_DETECTOR_VERSION,
    warning,
    songThreshold: null,
    runtimeInfo: null,
  };
}

async function createDetectorForSession(session, requestedMode, requestedLiveAnalysisMethod = DEFAULT_LIVE_ANALYSIS_METHOD) {
  const normalizedMode = normalizeDetectorMode(requestedMode, DEFAULT_DETECTOR_MODE);

  if (normalizedMode === DETECTOR_MODES.FIRERED_AED) {
    try {
      const liveConfig = resolveLiveFrameBuilderConfig(requestedLiveAnalysisMethod);
      const detector = new FireRedAedSongDetector({
        sourceSampleRate: session.audioContext.sampleRate,
        chunkSec: liveConfig.chunkSec,
        overlapSec: liveConfig.overlapSec,
        liveAnalysisMethod: liveConfig.liveAnalysisMethod,
      });
      await detector.initialize();
      return {
        detector,
        detectorMode: DETECTOR_MODES.FIRERED_AED,
        liveAnalysisMethod: liveConfig.liveAnalysisMethod,
        detectorVersion: detector.getDetectorVersion ? detector.getDetectorVersion() : FIRERED_AED_DETECTOR_VERSION,
        warning: null,
        songThreshold: detector.getSongThreshold ? detector.getSongThreshold() : null,
        runtimeInfo: detector.getRuntimeInfo ? detector.getRuntimeInfo() : null,
      };
    } catch (error) {
      console.warn('FireRed AED initialization failed.', error);
      throw error;
    }
  }

  throw new Error('Only FireRed AED detector is supported.');
}

function scheduleAnalyzeSession(tabId, { force = false } = {}) {
  const session = sessions.get(tabId);
  if (!session || session.stopping || session.analysisLock || session.analysisScheduled) return;

  const audioClockSec = Number(session.audioContext?.currentTime);
  if (!force && Number.isFinite(audioClockSec) && Number.isFinite(Number(session.lastAnalysisAudioClockSec))) {
    const elapsedSec = audioClockSec - Number(session.lastAnalysisAudioClockSec);
    if (elapsedSec < HOP_MS / 1000) return;
  }

  session.analysisScheduled = true;
  Promise.resolve().then(async () => {
    const latest = sessions.get(tabId);
    if (!latest || latest.stopping) return;
    try {
      const nextAudioClockSec = Number(latest.audioContext?.currentTime);
      if (Number.isFinite(nextAudioClockSec)) {
        latest.lastAnalysisAudioClockSec = nextAudioClockSec;
      }
      await analyzeSession(tabId);
    } finally {
      const finalSession = sessions.get(tabId);
      if (finalSession) finalSession.analysisScheduled = false;
    }
  });
}

async function analyzeSession(tabId) {
  const session = sessions.get(tabId);
  if (!session || session.analysisLock || session.stopping) return;

  session.analysisLock = true;

  try {
    const playbackSnapshot = await resolvePlaybackSnapshot(session);
    if (session.stopping) return;
    if (!playbackSnapshot || typeof playbackSnapshot.currentTime !== 'number') {
      await notifyStatus(session, 'Listening');
      return;
    }

    const videoBoundary = await detectVideoBoundary(session, playbackSnapshot);
    if (videoBoundary) {
      session.videoBoundaryReason = videoBoundary.reason;
      await notifyStatus(session, 'PostProcessing', {
        warning: videoBoundary.nextVideoId
          ? `Video changed to ${videoBoundary.nextVideoId}; stopping detection for ${videoBoundary.previousVideoId}.`
          : 'Video changed; stopping detection for the previous video.',
      });
      await stopSession(tabId, {
        emitStopped: true,
        skipWaitForAnalysisIdle: true,
        stopReason: videoBoundary.reason,
      });
      return;
    }

    session.videoId = playbackSnapshot.videoId || session.videoId || null;
    const currentTimeSec = toSeconds(playbackSnapshot.currentTime);
    if (playbackSnapshot.ended === true) {
      await notifyStatus(session, 'PostProcessing');
      await stopSession(tabId, {
        emitStopped: true,
        skipWaitForAnalysisIdle: true,
        stopReason: 'videoEnded',
      });
      return;
    }

    if (isWaitingForIntegerStart(session, currentTimeSec)) {
      markPlaybackClock(session, currentTimeSec);
      await notifyStatus(session, 'Listening');
      return;
    }
    if (isAnalysisGateClosed(session)) {
      openAnalysisGate(session, currentTimeSec);
      await notifyStatus(session, 'Listening');
      return;
    }

    const clockState = await reconcilePlaybackClock(session, currentTimeSec, playbackSnapshot);
    if (!clockState.shouldAnalyze) {
      if (clockState.forcedTransition) {
        await maybeReport(session, currentTimeSec, { force: true });
      }
      await notifyStatus(session, session.segmentTracker.isSong ? 'Detecting' : 'Listening');
      return;
    }

    const analysisTimeSec = snapLiveAnalysisTimeSec(session, currentTimeSec);
    if (
      !clockState.forcedTransition
      && Number.isFinite(Number(session.lastAnalysisFrameTimeSec))
      && analysisTimeSec <= Number(session.lastAnalysisFrameTimeSec) + 0.001
    ) {
      await notifyStatus(session, session.segmentTracker.isSong ? 'Detecting' : 'Listening');
      return;
    }

    const analysis = session.detectorMode === DETECTOR_MODES.FIRERED_AED
      ? await session.detector.analyze()
      : await session.detector.analyze(session.audioContext.sampleRate);
    if (session.stopping) return;

    if (!analysis.ready) {
      if (clockState.forcedTransition) {
        await maybeReport(session, currentTimeSec, { force: true });
      }
      await notifyStatus(session, 'Listening');
      return;
    }

    if (session.detectorMode === DETECTOR_MODES.FIRERED_AED) {
      const frames = Array.isArray(analysis.frames) ? analysis.frames : [analysis];
      const consumed = consumeFireRedAnalysisFrames(session, frames);
      const reportTimeSec = Number.isFinite(Number(consumed.lastTimeSec)) ? consumed.lastTimeSec : analysisTimeSec;
      await notifyStatus(session, consumed.status);
      await maybeReport(session, reportTimeSec, { force: consumed.transitioned || clockState.forcedTransition || frames.length > 1 });
      return;
    }

    session.lastAnalysisFrameTimeSec = analysisTimeSec;
    appendAnalysisCacheFrame(session, analysisTimeSec, analysis);
    const effectiveSongProbability = analysis.songProbability;
    const updateOptions = {};
    const beforeTrackerState = getTrackerDebugState(session.segmentTracker);
    const rawTransitioned = session.segmentTracker.update(analysisTimeSec, effectiveSongProbability, updateOptions);
    const updateResult = {
      transitioned: rawTransitioned,
      decision: rawTransitioned ? 'transition' : (session.segmentTracker.isSong ? 'song' : 'idle'),
      state: session.segmentTracker.isSong ? 'song' : 'idle',
    };
    const decisionResult = {
      songProbability: effectiveSongProbability,
      snapshot: null,
    };
    const transitioned = Boolean(updateResult?.transitioned) || clockState.forcedTransition;
    const nextStatus = session.segmentTracker.isSong ? 'Detecting' : 'Listening';

    appendDebugTrace(session, analysisTimeSec, analysis, decisionResult, updateResult, beforeTrackerState);
    await notifyStatus(session, nextStatus);
    await maybeReport(session, analysisTimeSec, { force: transitioned });
  } catch (error) {
    await notifyStatus(session, 'Stopped', {
      error: error?.message || String(error),
    });
    await stopSession(tabId, { emitStopped: false, skipWaitForAnalysisIdle: true });
  } finally {
    const latest = sessions.get(tabId);
    if (latest) latest.analysisLock = false;
  }
}

function buildTrackerConfig(session) {
  const trackerThresholds = resolveTrackerThresholds(session.detectorMode, session.songThreshold);
  session.trackerThresholds = trackerThresholds;

  if (session.detectorMode === DETECTOR_MODES.FIRERED_AED) {
    return {
      hopSeconds: HOP_MS / 1000,
      candidateMinDurationSec: 18,
      candidateMaxDurationSec: 75,
      minCandidateAnchors: 5,
      minCandidateAnchorSpanSec: 4,
      candidateGapSec: 8,
      tailStartRequiredWindows: 4,
      tailEndRequiredWindows: 4,
      tailMaxDurationSec: 40,
      tailSpeechGraceSec: 6,
      tailPaddingSec: 40,
      minSegmentDurationSec: normalizeMinSegmentDurationSec(session.minSegmentDurationSec),
      mergeGapSec: 8,
      provisionalMinDurationSec: 12,
    };
  }

  return {
    hopSeconds: HOP_MS / 1000,
    startProbabilityThreshold: trackerThresholds.start,
    endProbabilityThreshold: trackerThresholds.end,
    startRequiredWindows: 3,
    endRequiredWindows: 3,
    minSegmentDurationSec: 8,
    mergeGapSec: 4,
    provisionalMinDurationSec: 2,
  };
}

async function startSession({
  tabId,
  streamId,
  videoId,
  detectorMode,
  liveAnalysisMethod,
  minSegmentDurationSec,
  startupDebugTrace,
}) {
  const debugTrace = Array.isArray(startupDebugTrace) ? startupDebugTrace.slice() : [];
  await stopSession(tabId, { emitStopped: false, skipFinalReport: true });

  let stream = null;
  try {
    stream = await createTabAudioStream(streamId);
  } catch (error) {
    const debug = makeStartupDebug('offscreen-createTabAudioStream-failed', {
      tabId,
      hasStreamId: Boolean(streamId),
      error: serializeStartupError(error),
    });
    debugTrace.push(debug);
    console.warn('[song-detection] offscreen getUserMedia failed', debug);
    error.debugTrace = debugTrace;
    throw error;
  }

  let audioContext = null;
  try {
    audioContext = new AudioContext();
    await audioContext.resume();
  } catch (error) {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    const debug = makeStartupDebug('offscreen-audio-context-failed', {
      tabId,
      error: serializeStartupError(error),
    });
    debugTrace.push(debug);
    console.warn('[song-detection] offscreen AudioContext failed', debug);
    error.debugTrace = debugTrace;
    throw error;
  }

  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();

  source.connect(analyser);

  const monitorGain = audioContext.createGain();
  monitorGain.gain.value = 1;
  source.connect(monitorGain);
  monitorGain.connect(audioContext.destination);

  const currentVideoId = videoId || (await requestCurrentVideoId(tabId));

  const session = {
    tabId,
    stream,
    audioContext,
    source,
    analyser,
    monitorGain,
    captureNode: null,
    captureNodeType: null,
    captureSinkGain: null,
    detector: null,
    detectorMode: DEFAULT_DETECTOR_MODE,
    liveAnalysisMethod: normalizeLiveAnalysisMethod(liveAnalysisMethod),
    detectorVersion: FIRERED_AED_DETECTOR_VERSION,
    segmentTracker: null,
    analysisTimer: null,
    analysisLock: false,
    analysisScheduled: false,
    stopping: false,
    status: null,
    error: null,
    warning: null,
    eventDecisionHistory: [],
    eventDecisionSnapshot: null,
    lastSingingAnchorSec: null,
    analysisCache: [],
    liveSmoothingCache: null,
    liveFinalizationState: createLiveFinalizationState(),
    segmentFilterRuntimes: null,
    segmentFilterRuntimesPromise: null,
    segmentFilterUnavailable: false,
    segmentFilterLastError: null,
    segmentFilterRuntimeInfo: buildSegmentFilterRuntimeInfo(),
    completedAnalysisRanges: [],
    analysisCacheDiscontinuities: 0,
    debugTrace,
    trackerThresholds: null,
    songThreshold: null,
    runtimeInfo: null,
    minSegmentDurationSec: normalizeMinSegmentDurationSec(minSegmentDurationSec),
    lastPlaybackTimeSec: null,
    lastPlaybackWallMs: null,
    lastPlaybackAudioClockSec: null,
    lastAnalysisAudioClockSec: null,
    lastAudioChunkAudioClockSec: null,
    audioCaptureSuspended: false,
    audioCaptureSuspendedReason: null,
    audioCaptureSuspensionCount: 0,
    suspendedAudioSec: 0,
    suspendedAudioChunkCount: 0,
    suspendedAudioReasons: {},
    playbackStallCount: 0,
    playbackClockCalibration: null,
    playbackSnapshotFailureCount: 0,
    nextPlaybackSnapshotRetryAt: null,
    lastRealPlaybackSnapshotAt: null,
    playbackDiagnostics: createPlaybackDiagnostics(),
    integerStartPending: true,
    startAnalysisAtSec: null,
    analysisStartOriginSec: null,
    lastAnalysisFrameTimeSec: null,
    videoId: currentVideoId || null,
    lastReportSignature: '',
    lastReportAt: 0,
  };

  const initialPlaybackSnapshot = await requestPlaybackSnapshot(tabId);
  if (initialPlaybackSnapshot && typeof initialPlaybackSnapshot.currentTime === 'number') {
    session.videoId = initialPlaybackSnapshot.videoId || session.videoId || null;
    session.lastRealPlaybackSnapshotAt = Date.now();
    calibratePlaybackClock(session, initialPlaybackSnapshot);
    markPlaybackClock(session, initialPlaybackSnapshot.currentTime);
    session.startAnalysisAtSec = computeNextIntegerSecond(initialPlaybackSnapshot.currentTime);
  }

  const captureNodes = await createCaptureTap(audioContext, source, (monoChunk) => {
    const liveSession = sessions.get(tabId);
    if (!liveSession || liveSession.stopping || !liveSession.detector) return;
    if (isAnalysisGateClosed(liveSession)) return;
    if (liveSession.audioCaptureSuspended) {
      recordSuspendedAudioChunk(liveSession, monoChunk);
      return;
    }
    if (typeof liveSession.detector.pushAudioChunk !== 'function') return;
    liveSession.detector.pushAudioChunk(monoChunk);
    const audioClockSec = Number(liveSession.audioContext?.currentTime);
    if (Number.isFinite(audioClockSec)) {
      liveSession.lastAudioChunkAudioClockSec = audioClockSec;
    }
    scheduleAnalyzeSession(tabId);
  });

  session.captureNode = captureNodes.captureNode;
  session.captureNodeType = captureNodes.captureNodeType;
  session.captureSinkGain = captureNodes.captureSinkGain;

  const resolvedDetector = await createDetectorForSession(session, detectorMode, session.liveAnalysisMethod);
  session.detector = resolvedDetector.detector;
  session.detectorMode = resolvedDetector.detectorMode;
  session.liveAnalysisMethod = resolvedDetector.liveAnalysisMethod || session.liveAnalysisMethod;
  session.detectorVersion = resolvedDetector.detectorVersion;
  session.warning = resolvedDetector.warning;
  session.songThreshold = resolvedDetector.songThreshold;
  session.runtimeInfo = resolvedDetector.runtimeInfo || null;
  session.segmentTracker = session.detectorMode === DETECTOR_MODES.FIRERED_AED
    ? new EventSegmentTracker(buildTrackerConfig(session))
    : new SongSegmentTracker(buildTrackerConfig(session));

  session.analysisTimer = setInterval(() => {
    scheduleAnalyzeSession(tabId, { force: true });
  }, HOP_MS);

  sessions.set(tabId, session);
  if (session.detectorMode === DETECTOR_MODES.FIRERED_AED) {
    void getLiveSegmentFilterRuntimes(session).catch((error) => {
      console.warn('Live segment finalization preload failed.', error);
    });
  }

  await notifyStatus(session, 'Listening', {
    detectorMode: session.detectorMode,
    liveAnalysisMethod: session.liveAnalysisMethod,
    detectorVersion: session.detectorVersion,
    warning: session.warning,
    runtimeInfo: session.runtimeInfo,
    minSegmentDurationSec: session.minSegmentDurationSec,
  });

  scheduleAnalyzeSession(tabId, { force: true });

  return {
    status: 'Listening',
    detectorMode: session.detectorMode,
    liveAnalysisMethod: session.liveAnalysisMethod,
    detectorVersion: session.detectorVersion,
    warning: session.warning,
    runtimeInfo: session.runtimeInfo,
    minSegmentDurationSec: session.minSegmentDurationSec,
    debugTrace: session.debugTrace,
  };
}

async function stopSession(tabId, options = {}) {
  const {
    emitStopped = true,
    skipFinalReport = false,
    skipWaitForAnalysisIdle = false,
    stopReason = null,
  } = options;
  const session = sessions.get(tabId);
  if (!session) return false;

  if (session.stopping) {
    return { stopped: false, stopping: true, debugTrace: buildDebugTracePayload(session) };
  }

  session.stopping = true;

  if (session.analysisTimer) {
    clearInterval(session.analysisTimer);
    session.analysisTimer = null;
  }

  stopSessionCaptureResources(session);

  if (!skipWaitForAnalysisIdle) {
    await waitForAnalysisIdle(session);
  }

  if (!skipFinalReport) {
    await notifyStatus(session, 'PostProcessing');
  }

  if (!skipFinalReport) {
    await flushDetectorPendingFrames(session);
  }

  const finalTime = Math.max(
    toSeconds(session.segmentTracker.lastTimeSec),
    Number.isFinite(Number(session.lastAnalysisFrameTimeSec)) ? Number(session.lastAnalysisFrameTimeSec) : 0
  );
  session.segmentTracker.finalizeAt(finalTime);

  if (!skipFinalReport) {
    await maybeReport(session, finalTime, { force: true, finalizeAll: true });
  }

  const debugTrace = buildDebugTracePayload(session);
  if (debugTrace) completedDebugTraces.set(tabId, debugTrace);

  await releaseLiveSegmentFilterRuntimes(session);

  sessions.delete(tabId);

  if (emitStopped) {
    try {
      await chrome.runtime.sendMessage({
        action: 'songDetectionStatusChanged',
        tabId,
        videoId: session.videoId || null,
        status: 'Stopped',
        reason: stopReason || session.videoBoundaryReason || null,
        detectorMode: session.detectorMode,
        liveAnalysisMethod: session.liveAnalysisMethod || DEFAULT_LIVE_ANALYSIS_METHOD,
        detectorVersion: session.detectorVersion,
      });
    } catch (error) {
      // ignore
    }
  }

  return { stopped: true, debugTrace };
}

function stopSessionCaptureResources(session) {
  if (!session || session.captureResourcesStopped) return;
  session.captureResourcesStopped = true;

  try { session.source.disconnect(); } catch (error) { /* ignore */ }
  try { session.monitorGain.disconnect(); } catch (error) { /* ignore */ }
  try { session.captureNode.disconnect(); } catch (error) { /* ignore */ }

  if (session.captureNodeType === 'script-processor' && session.captureNode) {
    try { session.captureNode.onaudioprocess = null; } catch (error) { /* ignore */ }
  }

  try { session.captureSinkGain.disconnect(); } catch (error) { /* ignore */ }
  try { session.stream.getTracks().forEach((track) => track.stop()); } catch (error) { /* ignore */ }
  try {
    if (session.audioContext && session.audioContext.state !== 'closed') {
      void session.audioContext.close().catch(() => {});
    }
  } catch (error) {
    // ignore
  }
}

async function createCaptureTap(audioContext, source, onMonoChunk) {
  const captureSinkGain = audioContext.createGain();
  captureSinkGain.gain.value = 0;

  if (audioContext.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    const workletUrl = chrome.runtime.getURL(AUDIO_CAPTURE_WORKLET_PATH);
    await audioContext.audioWorklet.addModule(workletUrl);

    const captureNode = new AudioWorkletNode(audioContext, AUDIO_CAPTURE_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { chunkSize: 2048 },
    });

    captureNode.port.onmessage = (event) => {
      const payload = event.data;
      if (!payload || payload.type !== 'audio' || !payload.samples) return;
      onMonoChunk(payload.samples);
    };

    source.connect(captureNode);
    captureNode.connect(captureSinkGain);
    captureSinkGain.connect(audioContext.destination);

    return { captureNode, captureSinkGain, captureNodeType: 'audio-worklet' };
  }

  const captureNode = audioContext.createScriptProcessor(2048, 2, 1);
  captureNode.onaudioprocess = (event) => {
    const monoChunk = buildMonoChunk(event.inputBuffer);
    onMonoChunk(monoChunk);
  };

  source.connect(captureNode);
  captureNode.connect(captureSinkGain);
  captureSinkGain.connect(audioContext.destination);

  return { captureNode, captureSinkGain, captureNodeType: 'script-processor' };
}

const OFFSCREEN_ACTIONS = new Set([
  'offscreenStartSongDetection',
  'offscreenStopSongDetection',
  'offscreenStopAllSongDetection',
]);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !OFFSCREEN_ACTIONS.has(request.action)) {
    return false;
  }

  (async () => {
    try {
      if (request.action === 'offscreenStartSongDetection') {
        const {
          tabId,
          streamId,
          videoId,
          detectorMode,
          liveAnalysisMethod,
          minSegmentDurationSec,
        } = request;
        if (typeof tabId !== 'number' || !streamId) {
          sendResponse({ success: false, message: 'Invalid offscreen start payload.' });
          return;
        }

        const startResult = await startSession({
          tabId,
          streamId,
          videoId,
          detectorMode,
          liveAnalysisMethod,
          minSegmentDurationSec,
          startupDebugTrace: request.debugTrace,
        });
        sendResponse({
          success: true,
          status: startResult.status,
          detectorMode: startResult.detectorMode,
          liveAnalysisMethod: startResult.liveAnalysisMethod,
          detectorVersion: startResult.detectorVersion,
          warning: startResult.warning,
          runtimeInfo: startResult.runtimeInfo,
          debugTrace: startResult.debugTrace || null,
        });
        return;
      }

      if (request.action === 'offscreenStopSongDetection') {
        const { tabId } = request;
        if (typeof tabId !== 'number') {
          sendResponse({ success: false, message: 'Invalid tabId for stop.' });
          return;
        }

        const stopResult = await stopSession(tabId, { emitStopped: false, skipFinalReport: false });
        sendResponse({
          success: true,
          stopped: Boolean(stopResult && stopResult.stopped),
          stopping: Boolean(stopResult && stopResult.stopping),
          debugTrace: stopResult ? stopResult.debugTrace : null,
        });
        return;
      }

      if (request.action === 'offscreenStopAllSongDetection') {
        const tabIds = Array.from(sessions.keys());
        for (const tabId of tabIds) {
          await stopSession(tabId, { emitStopped: true, skipFinalReport: false });
        }
        sendResponse({ success: true, count: tabIds.length });
        return;
      }

    } catch (error) {
      const debugTrace = Array.isArray(error?.debugTrace) ? error.debugTrace : [
        makeStartupDebug('offscreen-unhandled-error', {
          error: serializeStartupError(error),
        }),
      ];
      console.warn('[song-detection] offscreen message failed', debugTrace);
      sendResponse({
        success: false,
        message: error?.message || String(error),
        debugTrace,
      });
    }
  })();

  return true;
});
