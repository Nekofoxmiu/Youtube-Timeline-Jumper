/* global importScripts */

importScripts('../vendor/onnxruntime/ort.min.js');

const DEFAULT_CHUNK_SEC = 20;
const DEFAULT_MIN_SEGMENT_DURATION_SEC = 90;

let modulesPromise = null;

function loadModules() {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import('./fireredAedDetector.js'),
      import('./globalSmoothing.js'),
      import('./boundaryDetector.js'),
    ]).then(([firered, smoothing, boundary]) => ({
      FireRedAedOfflineAnalyzer: firered.FireRedAedOfflineAnalyzer,
      smoothFireRedAnalyses: smoothing.smoothFireRedAnalyses,
      splitSongSegmentsByBoundaries: boundary.splitSongSegmentsByBoundaries,
    }));
  }
  return modulesPromise;
}

function post(jobId, type, payload = {}) {
  self.postMessage({ jobId, type, ...payload });
}

function createAudioBufferLike(audio) {
  const channels = (Array.isArray(audio?.channels) ? audio.channels : [])
    .map((channel) => channel instanceof Float32Array ? channel : new Float32Array(channel || 0));
  const length = Math.max(0, Math.floor(Number(audio?.length) || channels[0]?.length || 0));
  const sampleRate = Math.max(8000, Number(audio?.sampleRate) || 48000);

  return {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    getChannelData(channelIndex) {
      return channels[channelIndex] || new Float32Array(length);
    },
  };
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    stack: error?.stack || null,
  };
}

function normalizeMinSegmentDurationSec(value, fallback = DEFAULT_MIN_SEGMENT_DURATION_SEC) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(15, Math.min(600, Math.round(num)));
}

async function analyzeOfflineAudio(jobId, payload) {
  const {
    FireRedAedOfflineAnalyzer,
    smoothFireRedAnalyses,
    splitSongSegmentsByBoundaries,
  } = await loadModules();

  const audioBuffer = createAudioBufferLike(payload.audio);
  const startSec = Math.max(0, Number(payload.startSec) || 0);
  const endSec = Math.max(startSec, Number(payload.endSec) || startSec + (audioBuffer.length / audioBuffer.sampleRate));
  const splitMedley = Boolean(payload.splitMedley);
  const minSegmentDurationSec = normalizeMinSegmentDurationSec(payload.minSegmentDurationSec);

  post(jobId, 'model-status', { message: 'Model: loading FireRed AED' });
  const detector = new FireRedAedOfflineAnalyzer({
    chunkSec: Math.max(5, Number(payload.chunkSec) || DEFAULT_CHUNK_SEC),
  });
  await detector.initialize();
  post(jobId, 'model-status', { message: 'Model: FireRed AED ready' });
  post(jobId, 'status', { message: `Analyzing audio (${payload.rangeLabel || ''})...` });

  const analyses = await detector.analyzeAudioBuffer(audioBuffer, {
    startFrame: 0,
    endFrame: audioBuffer.length,
    timeOffsetSec: startSec,
    onProgress: ({ phase, ratio }) => {
      const clampedRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
      const phaseLabel = phase === 'temporal-head' ? 'Temporal head' : 'AED';
      const progressRatio = phase === 'temporal-head'
        ? 0.85 + (clampedRatio * 0.1)
        : clampedRatio * 0.85;
      post(jobId, 'progress', {
        phase,
        ratio: progressRatio,
        message: `${phaseLabel}... ${Math.round(clampedRatio * 100)}%`,
      });
    },
  });

  post(jobId, 'status', { message: `Smoothing ${analyses.length} analysis windows...` });
  let smoothing = smoothFireRedAnalyses(analyses, endSec, { startSec, minSegmentDurationSec });
  let segments = smoothing.segments;
  let boundarySplit = null;

  if (splitMedley) {
    post(jobId, 'status', { message: `Splitting medley candidates in ${segments.length} segment(s)...` });
    boundarySplit = splitSongSegmentsByBoundaries(segments, analyses);
    segments = boundarySplit.segments;
  }

  post(jobId, 'progress', { ratio: 1, message: 'Done.' });
  post(jobId, 'complete', {
    result: {
      segments,
      boundarySplit,
      analysesLength: analyses.length,
      minSegmentDurationSec,
      runtimeInfo: detector.getRuntimeInfo ? detector.getRuntimeInfo() : null,
      detectorVersion: detector.getDetectorVersion ? detector.getDetectorVersion() : null,
    },
  });

  smoothing = null;
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type !== 'analyze-offline-audio') return;
  const jobId = message.jobId || `offline-${Date.now()}`;
  analyzeOfflineAudio(jobId, message.payload || {}).catch((error) => {
    post(jobId, 'error', { error: serializeError(error) });
  });
};
