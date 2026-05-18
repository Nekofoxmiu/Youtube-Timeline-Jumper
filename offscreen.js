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
import { GLOBAL_SMOOTHING_VERSION, smoothFireRedAnalyses } from './lib/songDetection/globalSmoothing.js';

const HOP_MS = 500;
const REPORT_INTERVAL_MS = 2000;
const PLAYBACK_SNAPSHOT_TIMEOUT_MS = 700;
const ENABLE_DEBUG_TRACE = false;
const MAX_DEBUG_TRACE_FRAMES = 24000;
const DEFAULT_DETECTOR_MODE = DETECTOR_MODES.FIRERED_AED;
const DEFAULT_MIN_SEGMENT_DURATION_SEC = 90;
const AUDIO_CAPTURE_WORKLET_NAME = 'ytj-audio-capture-worklet';
const AUDIO_CAPTURE_WORKLET_PATH = 'lib/songDetection/audioCapture.worklet.js';
const LIVE_LOOKAHEAD_SEC = 12;
const MAX_ANALYSIS_CACHE_FRAMES = 12 * 60 * 60 * 2; // 12 hours at 0.5s hop.
const FIRERED_TRACKER_START_THRESHOLD = 0.54;
const FIRERED_TRACKER_END_THRESHOLD = 0.28;
const HEURISTIC_TRACKER_START_THRESHOLD = 0.6;
const HEURISTIC_TRACKER_END_THRESHOLD = 0.42;
const FIRERED_TRACKER_START_MARGIN = 0.02;
const FIRERED_TRACKER_HYSTERESIS_GAP = 0.18;
const PLAYBACK_CLOCK_SEEK_JUMP_SEC = 8;
const PLAYBACK_CLOCK_CONTINUITY_TOLERANCE_SEC = 4;

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
    analyzedAudioSec: roundNumber(Number(analysis.analyzedAudioSec) || 0, 3),
    detectorVersion: analysis.detectorVersion || null,
  };
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

function getCachedGlobalSmoothing(session, currentTimeSec, { finalizeAll = false } = {}) {
  if (!session || session.detectorMode !== DETECTOR_MODES.FIRERED_AED) return null;

  const frames = Array.isArray(session.analysisCache) ? session.analysisCache : [];
  if (frames.length < 20 || !frames.some((frame) => frame.temporalHeadReady)) return null;

  const firstFrame = frames[0] || null;
  const lastFrame = frames[frames.length - 1] || null;
  const endSec = Math.max(
    Number(currentTimeSec) || 0,
    Number(lastFrame?.timeSec) || 0
  );
  const key = [
    frames.length,
    roundNumber(endSec, 1),
    finalizeAll ? 'final' : 'live',
  ].join(':');

  if (session.liveSmoothingCache && session.liveSmoothingCache.key === key) {
    return session.liveSmoothingCache.result;
  }

  const result = smoothFireRedAnalyses(frames, endSec, {
    startSec: Number.isFinite(Number(firstFrame?.timeSec)) ? Number(firstFrame.timeSec) : null,
    minSegmentDurationSec: session.minSegmentDurationSec,
  });

  session.liveSmoothingCache = { key, result };
  return result;
}

function buildLiveReportSegments(session, currentTimeSec, { finalizeAll = false } = {}) {
  const allFinalSegments = session.segmentTracker.getFinalSegments();
  const trackerProvisionalSegments = session.segmentTracker.getProvisionalSegments(currentTimeSec);

  if (session.detectorMode !== DETECTOR_MODES.FIRERED_AED) {
    return {
      finalSegments: allFinalSegments,
      provisionalSegments: trackerProvisionalSegments,
      refinedBy: null,
      smoothingMethod: null,
    };
  }

  const smoothing = getCachedGlobalSmoothing(session, currentTimeSec, { finalizeAll });
  if (smoothing && Array.isArray(smoothing.segments)) {
    if (finalizeAll) {
      return {
        finalSegments: smoothing.segments,
        provisionalSegments: [],
        refinedBy: GLOBAL_SMOOTHING_VERSION,
        smoothingMethod: smoothing.method || null,
      };
    }

    const finalCutoffSec = Math.max(0, currentTimeSec - LIVE_LOOKAHEAD_SEC);
    const finalSegments = [];
    const provisionalSegments = [];

    for (const segment of smoothing.segments) {
      if (Number(segment.endSec) <= finalCutoffSec) {
        finalSegments.push(segment);
      } else {
        provisionalSegments.push({ ...segment, provisional: true });
      }
    }

    for (const segment of trackerProvisionalSegments) {
      const overlapsKnownSegment = [...finalSegments, ...provisionalSegments]
        .some((knownSegment) => segmentsOverlap(knownSegment, segment));
      if (!overlapsKnownSegment) {
        provisionalSegments.push(segment);
      }
    }

    return {
      finalSegments,
      provisionalSegments,
      refinedBy: GLOBAL_SMOOTHING_VERSION,
      smoothingMethod: smoothing.method || null,
    };
  }

  const finalCutoffSec = Math.max(0, currentTimeSec - LIVE_LOOKAHEAD_SEC);
  const finalSegments = [];
  const delayedFinalSegments = [];

  for (const segment of allFinalSegments) {
    if (Number(segment.endSec) <= finalCutoffSec) {
      finalSegments.push(segment);
    } else {
      delayedFinalSegments.push({ ...segment, provisional: true });
    }
  }

  return {
    finalSegments,
    provisionalSegments: [...delayedFinalSegments, ...trackerProvisionalSegments],
    refinedBy: null,
    smoothingMethod: null,
  };
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
  session.playbackClockCalibration = {
    currentTimeSec,
    audioClockSec: Number.isFinite(audioClockSec) ? audioClockSec : 0,
    wallTimeMs: Date.now(),
    playbackRate: Number.isFinite(Number(snapshot.playbackRate)) ? Math.max(0, Number(snapshot.playbackRate)) : 1,
    videoId: snapshot.videoId || session.videoId || null,
  };
}

function estimatePlaybackSnapshot(session) {
  const calibration = session?.playbackClockCalibration;
  if (!calibration) return null;

  const audioClockSec = Number(session.audioContext?.currentTime);
  if (!Number.isFinite(audioClockSec)) return null;

  const elapsedSec = Math.max(0, audioClockSec - calibration.audioClockSec);
  const playbackRate = Number.isFinite(Number(calibration.playbackRate)) ? calibration.playbackRate : 1;
  return {
    success: true,
    estimated: true,
    videoId: calibration.videoId || session.videoId || null,
    currentTime: Math.max(0, calibration.currentTimeSec + (elapsedSec * playbackRate)),
    playbackRate,
    paused: null,
  };
}

async function resolvePlaybackSnapshot(session) {
  if (
    session.playbackClockCalibration
    && Number.isFinite(Number(session.nextPlaybackSnapshotRetryAt))
    && Date.now() < Number(session.nextPlaybackSnapshotRetryAt)
  ) {
    return estimatePlaybackSnapshot(session);
  }

  const snapshot = await requestPlaybackSnapshot(session.tabId);
  if (snapshot && typeof snapshot.currentTime === 'number') {
    session.playbackSnapshotFailureCount = 0;
    session.nextPlaybackSnapshotRetryAt = null;
    calibratePlaybackClock(session, snapshot);
    return { ...snapshot, estimated: false };
  }

  session.playbackSnapshotFailureCount = (Number(session.playbackSnapshotFailureCount) || 0) + 1;
  session.nextPlaybackSnapshotRetryAt = Date.now() + Math.min(5000, session.playbackSnapshotFailureCount * 1000);
  return estimatePlaybackSnapshot(session);
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

async function notifyStatus(session, status, extra = {}) {
  const normalized = normalizeDetectionStatus(status);
  const nextError = extra.error || null;
  const nextWarning = extra.warning || session.warning || null;
  const nextMode = extra.detectorMode || session.detectorMode;
  const nextVersion = extra.detectorVersion || session.detectorVersion;
  const nextRuntimeInfo = extra.runtimeInfo || session.runtimeInfo || null;

  if (
    session.status === normalized
    && session.error === nextError
    && session.warning === nextWarning
    && session.detectorMode === nextMode
    && session.detectorVersion === nextVersion
  ) {
    return;
  }

  session.status = normalized;
  session.error = nextError;
  session.warning = nextWarning;
  session.detectorMode = nextMode;
  session.detectorVersion = nextVersion;
  session.runtimeInfo = nextRuntimeInfo;

  try {
    await chrome.runtime.sendMessage({
      action: 'songDetectionStatusChanged',
      tabId: session.tabId,
      videoId: session.videoId || null,
      status: normalized,
      error: nextError,
      warning: nextWarning,
      detectorMode: nextMode,
      detectorVersion: nextVersion,
      runtimeInfo: nextRuntimeInfo,
      minSegmentDurationSec: session.minSegmentDurationSec,
    });
  } catch (error) {
    // Background service worker may be restarting; the next tick reports again.
  }
}

async function maybeReport(session, currentTimeSec, { force = false, finalizeAll = false } = {}) {
  const {
    finalSegments,
    provisionalSegments,
    refinedBy = null,
    smoothingMethod = null,
  } = buildLiveReportSegments(session, currentTimeSec, { finalizeAll });
  const status = (session.segmentTracker.isSong || provisionalSegments.length > 0)
    ? 'Detecting'
    : 'Listening';
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
      detectorVersion: session.detectorVersion,
      finalSegments,
      provisionalSegments,
      currentTimeSec: roundNumber(currentTimeSec, 3),
      warning: session.warning || null,
      liveLookaheadSec: session.detectorMode === DETECTOR_MODES.FIRERED_AED ? LIVE_LOOKAHEAD_SEC : null,
      refinedBy: finalizeAll ? refinedBy : null,
      smoothingMethod: finalizeAll ? smoothingMethod : null,
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

function reconcilePlaybackClock(session, currentTimeSec, snapshot = {}) {
  const current = toSeconds(currentTimeSec);
  const last = Number(session.lastPlaybackTimeSec);

  if (!Number.isFinite(last)) {
    markPlaybackClock(session, current);
    return { shouldAnalyze: true, forcedTransition: false };
  }

  const delta = current - last;
  const looksLikeSeek = delta < -2
    || (delta > PLAYBACK_CLOCK_SEEK_JUMP_SEC && !isContinuousPlaybackJump(session, delta, snapshot));
  if (looksLikeSeek) {
    session.eventDecisionHistory = [];
    session.eventDecisionSnapshot = null;
    session.lastSingingAnchorSec = null;
    session.analysisCache = [];
    session.liveSmoothingCache = null;
    session.analysisCacheDiscontinuities = (Number(session.analysisCacheDiscontinuities) || 0) + 1;
    if (typeof session.detector?.resetAnalysisState === 'function') {
      session.detector.resetAnalysisState();
    }
    const forcedTransition = session.segmentTracker
      ? session.segmentTracker.finalizeAt(Math.max(0, last))
      : false;
    markPlaybackClock(session, current);
    return { shouldAnalyze: true, forcedTransition };
  }

  if (delta < 0.05) {
    markPlaybackClock(session, current);
    return { shouldAnalyze: false, forcedTransition: false };
  }

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

async function createDetectorForSession(session, requestedMode) {
  const normalizedMode = normalizeDetectorMode(requestedMode, DEFAULT_DETECTOR_MODE);

  if (normalizedMode === DETECTOR_MODES.FIRERED_AED) {
    try {
      const detector = new FireRedAedSongDetector({
        sourceSampleRate: session.audioContext.sampleRate,
      });
      await detector.initialize();
      return {
        detector,
        detectorMode: DETECTOR_MODES.FIRERED_AED,
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
    if (!playbackSnapshot || typeof playbackSnapshot.currentTime !== 'number') {
      await notifyStatus(session, 'Listening');
      return;
    }

    session.videoId = playbackSnapshot.videoId || session.videoId || null;
    const currentTimeSec = toSeconds(playbackSnapshot.currentTime);
    const clockState = reconcilePlaybackClock(session, currentTimeSec, playbackSnapshot);
    if (!clockState.shouldAnalyze) {
      await notifyStatus(session, session.segmentTracker.isSong ? 'Detecting' : 'Listening');
      return;
    }

    const analysis = session.detectorMode === DETECTOR_MODES.FIRERED_AED
      ? await session.detector.analyze()
      : await session.detector.analyze(session.audioContext.sampleRate);

    if (!analysis.ready) {
      if (clockState.forcedTransition) {
        await maybeReport(session, currentTimeSec, { force: true });
      }
      await notifyStatus(session, 'Listening');
      return;
    }

    appendAnalysisCacheFrame(session, currentTimeSec, analysis);

    let effectiveSongProbability = analysis.songProbability;
    let updateOptions = {};
    let decisionResult = null;
    let updateResult = null;
    const beforeTrackerState = getTrackerDebugState(session.segmentTracker);

    if (session.detectorMode === DETECTOR_MODES.FIRERED_AED) {
      const ruled = applyFireRedDecisionRules(session, currentTimeSec, analysis);
      decisionResult = ruled;
      effectiveSongProbability = ruled.songProbability;
      updateOptions = { startSecOverride: ruled.startSecOverride };
    }

    if (session.detectorMode === DETECTOR_MODES.FIRERED_AED) {
      updateResult = session.segmentTracker.update(
        currentTimeSec,
        decisionResult?.trackerEvidence || {
          songProbability: effectiveSongProbability,
          hasSingingAnchor: effectiveSongProbability >= (session.trackerThresholds?.start || FIRERED_TRACKER_START_THRESHOLD),
          hasRecentAnchor: false,
          hasMusicSustain: false,
          speechDominant: false,
          startSecOverride: updateOptions.startSecOverride,
        }
      );
    } else {
      const transitioned = session.segmentTracker.update(currentTimeSec, effectiveSongProbability, updateOptions);
      updateResult = {
        transitioned,
        decision: transitioned ? 'transition' : (session.segmentTracker.isSong ? 'song' : 'idle'),
        state: session.segmentTracker.isSong ? 'song' : 'idle',
      };
      decisionResult = {
        songProbability: effectiveSongProbability,
        snapshot: null,
      };
    }

    const transitioned = Boolean(updateResult?.transitioned) || clockState.forcedTransition;
    const nextStatus = session.segmentTracker.isSong ? 'Detecting' : 'Listening';

    appendDebugTrace(session, currentTimeSec, analysis, decisionResult, updateResult, beforeTrackerState);
    await notifyStatus(session, nextStatus);
    await maybeReport(session, currentTimeSec, { force: transitioned });
  } catch (error) {
    await notifyStatus(session, 'Stopped', {
      error: error?.message || String(error),
    });
    await stopSession(tabId, { emitStopped: false });
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

async function startSession({ tabId, streamId, videoId, detectorMode, minSegmentDurationSec }) {
  await stopSession(tabId, { emitStopped: false, skipFinalReport: true });

  const stream = await createTabAudioStream(streamId);
  const audioContext = new AudioContext();
  await audioContext.resume();

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
    analysisCacheDiscontinuities: 0,
    debugTrace: [],
    trackerThresholds: null,
    songThreshold: null,
    runtimeInfo: null,
    minSegmentDurationSec: normalizeMinSegmentDurationSec(minSegmentDurationSec),
    lastPlaybackTimeSec: null,
    lastPlaybackWallMs: null,
    lastPlaybackAudioClockSec: null,
    lastAnalysisAudioClockSec: null,
    lastAudioChunkAudioClockSec: null,
    playbackClockCalibration: null,
    playbackSnapshotFailureCount: 0,
    nextPlaybackSnapshotRetryAt: null,
    videoId: currentVideoId || null,
    lastReportSignature: '',
    lastReportAt: 0,
  };

  const initialPlaybackSnapshot = await requestPlaybackSnapshot(tabId);
  if (initialPlaybackSnapshot && typeof initialPlaybackSnapshot.currentTime === 'number') {
    session.videoId = initialPlaybackSnapshot.videoId || session.videoId || null;
    calibratePlaybackClock(session, initialPlaybackSnapshot);
    markPlaybackClock(session, initialPlaybackSnapshot.currentTime);
  }

  const captureNodes = await createCaptureTap(audioContext, source, (monoChunk) => {
    const liveSession = sessions.get(tabId);
    if (!liveSession || liveSession.stopping || !liveSession.detector) return;
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

  const resolvedDetector = await createDetectorForSession(session, detectorMode);
  session.detector = resolvedDetector.detector;
  session.detectorMode = resolvedDetector.detectorMode;
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

  await notifyStatus(session, 'Listening', {
    detectorMode: session.detectorMode,
    detectorVersion: session.detectorVersion,
    warning: session.warning,
    runtimeInfo: session.runtimeInfo,
    minSegmentDurationSec: session.minSegmentDurationSec,
  });

  await maybeReport(session, 0, { force: true });

  return {
    status: 'Listening',
    detectorMode: session.detectorMode,
    detectorVersion: session.detectorVersion,
    warning: session.warning,
    runtimeInfo: session.runtimeInfo,
    minSegmentDurationSec: session.minSegmentDurationSec,
  };
}

function buildRefinedLiveSegments(session, finalTimeSec) {
  if (session.detectorMode !== DETECTOR_MODES.FIRERED_AED) return null;
  const cache = Array.isArray(session.analysisCache) ? session.analysisCache : [];
  if (cache.length < 20 || !cache.some((frame) => frame.temporalHeadReady)) return null;

  const firstFrame = cache[0];
  const lastFrame = cache[cache.length - 1];
  const endSec = Math.max(
    Number(finalTimeSec) || 0,
    Number(lastFrame?.timeSec) || 0
  );
  const smoothing = smoothFireRedAnalyses(cache, endSec, {
    startSec: Number(firstFrame?.timeSec) || 0,
    minSegmentDurationSec: session.minSegmentDurationSec,
  });

  return {
    ...smoothing,
    analysisCacheSummary: buildAnalysisCacheSummary(session, smoothing.segments),
  };
}

async function reportRefinedLiveSegments(session, finalTimeSec, refinedResult) {
  if (!session.videoId || !refinedResult) return false;

  const finalSegments = Array.isArray(refinedResult.segments) ? refinedResult.segments : [];
  const reportStatus = session.segmentTracker.isSong ? 'Detecting' : 'Listening';
  const signature = buildSignature(
    finalSegments,
    [],
    reportStatus,
    session.videoId,
    session.detectorVersion,
    session.detectorMode
  );

  session.lastReportSignature = signature;
  session.lastReportAt = Date.now();

  try {
    await chrome.runtime.sendMessage({
      action: 'songSegmentsUpdated',
      tabId: session.tabId,
      videoId: session.videoId,
      status: reportStatus,
      detectorMode: session.detectorMode,
      detectorVersion: session.detectorVersion,
      finalSegments,
      provisionalSegments: [],
      currentTimeSec: roundNumber(finalTimeSec, 3),
      warning: session.warning || null,
      refinedBy: GLOBAL_SMOOTHING_VERSION,
      smoothingMethod: refinedResult.method || null,
      analysisCacheSummary: refinedResult.analysisCacheSummary || buildAnalysisCacheSummary(session, finalSegments),
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function stopSession(tabId, options = {}) {
  const { emitStopped = true, skipFinalReport = false } = options;
  const session = sessions.get(tabId);
  if (!session) return false;

  session.stopping = true;

  if (session.analysisTimer) {
    clearInterval(session.analysisTimer);
  }

  const finalTime = toSeconds(session.segmentTracker.lastTimeSec);
  session.segmentTracker.finalizeAt(finalTime);

  if (!skipFinalReport) {
    const refinedResult = buildRefinedLiveSegments(session, finalTime);
    const refinedReported = refinedResult
      ? await reportRefinedLiveSegments(session, finalTime, refinedResult)
      : false;
    if (!refinedReported) {
      await maybeReport(session, finalTime, { force: true, finalizeAll: true });
    }
  }

  const debugTrace = buildDebugTracePayload(session);
  if (debugTrace) completedDebugTraces.set(tabId, debugTrace);

  try { session.source.disconnect(); } catch (error) { /* ignore */ }
  try { session.monitorGain.disconnect(); } catch (error) { /* ignore */ }
  try { session.captureNode.disconnect(); } catch (error) { /* ignore */ }

  if (session.captureNodeType === 'script-processor' && session.captureNode) {
    try { session.captureNode.onaudioprocess = null; } catch (error) { /* ignore */ }
  }

  try { session.captureSinkGain.disconnect(); } catch (error) { /* ignore */ }
  try { session.stream.getTracks().forEach((track) => track.stop()); } catch (error) { /* ignore */ }
  try { await session.audioContext.close(); } catch (error) { /* ignore */ }

  sessions.delete(tabId);

  if (emitStopped) {
    try {
      await chrome.runtime.sendMessage({
        action: 'songDetectionStatusChanged',
        tabId,
        videoId: session.videoId || null,
        status: 'Stopped',
        detectorMode: session.detectorMode,
        detectorVersion: session.detectorVersion,
      });
    } catch (error) {
      // ignore
    }
  }

  return { stopped: true, debugTrace };
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
        const { tabId, streamId, videoId, detectorMode, minSegmentDurationSec } = request;
        if (typeof tabId !== 'number' || !streamId) {
          sendResponse({ success: false, message: 'Invalid offscreen start payload.' });
          return;
        }

        const startResult = await startSession({ tabId, streamId, videoId, detectorMode, minSegmentDurationSec });
        sendResponse({
          success: true,
          status: startResult.status,
          detectorMode: startResult.detectorMode,
          detectorVersion: startResult.detectorVersion,
          warning: startResult.warning,
          runtimeInfo: startResult.runtimeInfo,
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
      sendResponse({ success: false, message: error?.message || String(error) });
    }
  })();

  return true;
});
