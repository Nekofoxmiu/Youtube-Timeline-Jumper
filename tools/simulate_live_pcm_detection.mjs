import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { FireRedAedSongDetector } from '../lib/songDetection/fireredAedDetector.js';
import { smoothFireRedAnalyses } from '../lib/songDetection/globalSmoothing.js';
import {
  DEFAULT_SEGMENT_FILTER_OPTIONS,
  applySegmentFilterPredictions,
  loadEdgeTrimAdvisorModel,
  loadSegmentFilterModel,
  runSegmentFilterPipeline,
} from '../lib/songDetection/segmentFilter.js';

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_WORKLET_CHUNK_FRAMES = 2048;
const DEFAULT_HOP_SEC = 0.5;
const DEFAULT_LIVE_FINALIZE_DELAY_SEC = 180;
const DEFAULT_REPORT_STEP_SEC = 5;
const DEFAULT_MIN_SEGMENT_DURATION_SEC = 90;
const LIVE_SEGMENT_FILTER_KEEP_THRESHOLD = 0.35;
const LIVE_FILTER_DROP_PROTECTION = Object.freeze({
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

function segmentMatches(predicted, manual) {
  return manual.map((target) => {
    let best = null;
    for (const segment of predicted) {
      const overlap = overlapSeconds(segment, target);
      if (!best || overlap > best.overlapSec) {
        best = {
          overlapSec: overlap,
          predicted: segment,
          recallRatio: overlap / Math.max(1, target.endSec - target.startSec),
          predictedPrecisionRatio: overlap / Math.max(1, segment.endSec - segment.startSec),
          startDeltaSec: segment.startSec - target.startSec,
          endDeltaSec: segment.endSec - target.endSec,
        };
      }
    }
    return { manual: target, best };
  });
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
  const ortModule = await import('../lib/vendor/onnxruntime/ort.min.js');
  globalThis.ort = ortModule.default || ortModule;
  return globalThis.ort;
}

function toFileUrl(path) {
  return pathToFileURL(resolve(path)).href;
}

async function loadFinalizerRuntimes({ enabled }) {
  if (!enabled) return null;
  const ort = globalThis.ort;
  if (!ort?.InferenceSession || !ort?.Tensor) return null;
  try {
    const [segmentFilter, edgeTrimAdvisor] = await Promise.all([
      loadSegmentFilterModel({
        ort,
        modelUrl: toFileUrl('models/fireredvad/aed/segment_filter.onnx'),
        metaUrl: toFileUrl('models/fireredvad/aed/segment_filter.meta.json'),
        executionProviders: ['wasm'],
      }),
      loadEdgeTrimAdvisorModel({
        ort,
        modelUrl: toFileUrl('models/fireredvad/aed/edge_trim_advisor.onnx'),
        metaUrl: toFileUrl('models/fireredvad/aed/edge_trim_advisor.meta.json'),
        executionProviders: ['wasm'],
      }).catch(() => null),
    ]);
    return { segmentFilter, edgeTrimAdvisor };
  } catch (error) {
    console.warn('[pcm-live-sim] finalizer unavailable; using heuristic final segments.', error);
    return null;
  }
}

async function applyFinalizer(runtimes, segments, frames, smoothing, {
  currentTimeSec,
  finalCutoffSec,
  minSegmentDurationSec,
  previousFinalEndSec = null,
  finalizeAll = false,
}) {
  const normalized = uniqueSegments(segments);
  if (!runtimes?.segmentFilter || !normalized.length) {
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
  const activeRuntimes = finalizeAll
    ? runtimes
    : { segmentFilter: runtimes.segmentFilter, edgeTrimAdvisor: null };
  const options = {
    ...DEFAULT_SEGMENT_FILTER_OPTIONS,
    keepThreshold: finalizeAll
      ? Number(runtimes.segmentFilter.meta?.keepThreshold) || DEFAULT_SEGMENT_FILTER_OPTIONS.keepThreshold
      : LIVE_SEGMENT_FILTER_KEEP_THRESHOLD,
    minSegmentDurationSec,
    startSec: Number.isFinite(Number(previousFinalEndSec))
      ? Number(previousFinalEndSec)
      : (Number.isFinite(Number(firstFrame?.timeSec)) ? Number(firstFrame.timeSec) : 0),
    endSec: finalCutoffSec,
  };
  const predictions = await runSegmentFilterPipeline(activeRuntimes, normalized, frames, context, options);
  const filtered = protectLiveFilterDrops(
    normalized,
    applySegmentFilterPredictions(normalized, predictions, options),
    frames
  );
  return {
    segments: uniqueSegments(filtered.segments || []),
    adjustments: filtered.adjustments || [],
    applied: true,
    runtimeInfo: {
      segmentFilterLoaded: Boolean(runtimes.segmentFilter),
      edgeTrimAdvisorLoaded: Boolean(activeRuntimes.edgeTrimAdvisor),
      keepThreshold: options.keepThreshold,
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
  throw new Error('Usage: node tools/simulate_live_pcm_detection.mjs --audio <audio.m4a/mp4> --out <summary.json> [--manual <manual.txt>] [--start-sec 0] [--end-sec 600] [--ffmpeg ffmpeg] [--sample-rate 48000] [--chunk-frames 2048] [--report-step-sec 5] [--lookahead-sec 180] [--min-segment-duration-sec 90] [--no-segment-filter] [--include-frames] [--include-checkpoints]');
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
const manual = await loadManual(manualPath);

await loadOrtRuntime();
const detector = new FireRedAedSongDetector({ sourceSampleRate: sampleRate });
await detector.initialize();
const finalizerRuntimes = await loadFinalizerRuntimes({ enabled: segmentFilterEnabled });

const analysisStartOriginSec = computeNextIntegerSecond(startSec);
if (typeof detector.setTimeOffsetSec === 'function') {
  detector.setTimeOffsetSec(analysisStartOriginSec);
}
let absoluteSampleCursor = startSec * sampleRate;
let nextAnalyzeSec = analysisStartOriginSec;
let nextReportSec = analysisStartOriginSec + reportStepSec;
let lastProgressLogAt = Date.now();
const frames = [];
const checkpoints = [];
const finalizationBatches = [];
const finalizedState = {
  segments: [],
  adjustments: [],
  maxSourceEndSec: null,
  filterApplied: false,
};

async function analyzeUntil(currentAbsSec) {
  while (nextAnalyzeSec <= currentAbsSec + 1e-6) {
    const analysis = await detector.analyze();
    const analysisFrames = Array.isArray(analysis?.frames) && analysis.frames.length
      ? analysis.frames
      : [normalizeLiveAnalysisCacheFrame(nextAnalyzeSec, analysis)].filter(Boolean);
    for (const frame of analysisFrames) {
      const lastFrame = frames[frames.length - 1] || null;
      if (lastFrame && Math.abs(Number(lastFrame.timeSec) - Number(frame.timeSec)) < 0.05) {
        frames[frames.length - 1] = frame;
      } else {
        frames.push(frame);
      }
    }

    while (nextReportSec <= nextAnalyzeSec + 1e-6) {
      await runLiveReport(nextReportSec, false);
      nextReportSec += reportStepSec;
    }
    nextAnalyzeSec = roundNumber(nextAnalyzeSec + DEFAULT_HOP_SEC, 3);
  }
}

async function runLiveReport(nowSec, finalizeAll) {
  const availableFrames = frames.filter((frame) => Number(frame.timeSec) <= nowSec);
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

  const smoothing = smoothFireRedAnalyses(availableFrames, nowSec, {
    startSec: analysisStartOriginSec,
    minSegmentDurationSec,
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
    const count = Math.min(chunkFrames, samples.length - offset);
    const chunk = samples.subarray(offset, offset + count);
    const chunkStartSec = absoluteSampleCursor / sampleRate;
    const chunkEndSec = (absoluteSampleCursor + count) / sampleRate;

    if (chunkEndSec > analysisStartOriginSec) {
      if (chunkStartSec >= analysisStartOriginSec) {
        detector.pushAudioChunk(chunk);
      } else {
        const keepOffset = Math.max(0, Math.floor((analysisStartOriginSec - chunkStartSec) * sampleRate));
        detector.pushAudioChunk(chunk.subarray(keepOffset));
      }
    }

    absoluteSampleCursor += count;
    await analyzeUntil(absoluteSampleCursor / sampleRate);
    offset += count;
  }

  const now = Date.now();
  if (now - lastProgressLogAt > 5000) {
    lastProgressLogAt = now;
    const currentSec = absoluteSampleCursor / sampleRate;
    console.log(`[pcm-live-sim] ${formatTime(currentSec)} frames=${frames.length} finalized=${finalizedState.segments.length}`);
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

const finalNowSec = roundNumber(absoluteSampleCursor / sampleRate, 3);
await analyzeUntil(finalNowSec);
if (typeof detector.flushPendingFrames === 'function') {
  const flushedFrames = await detector.flushPendingFrames();
  for (const frame of flushedFrames) {
    const lastFrame = frames[frames.length - 1] || null;
    if (lastFrame && Math.abs(Number(lastFrame.timeSec) - Number(frame.timeSec)) < 0.05) {
      frames[frames.length - 1] = frame;
    } else {
      frames.push(frame);
    }
  }
}
await runLiveReport(finalNowSec, true);

const finalSegments = uniqueSegments(finalizedState.segments);
const frameTimes = frames.map((frame) => Number(frame.timeSec) || 0);
const predictedLabels = labelsFromSegments(frameTimes, finalSegments);
const manualLabels = labelsFromSegments(frameTimes, manual);
const rawModelLabels = frames.map((frame) => {
  const threshold = Number(frame.temporalHeadThreshold) || 0.75;
  return Number(frame.temporalHeadProbability ?? frame.songProbability) >= threshold ? 1 : 0;
});

const summary = {
  audio,
  manual: manualPath,
  params: {
    sampleRate,
    chunkFrames,
    startSec,
    endSec: Number.isFinite(endSec) ? endSec : null,
    analysisStartOriginSec,
    hopSec: DEFAULT_HOP_SEC,
    reportStepSec,
    lookaheadSec,
    minSegmentDurationSec,
    segmentFilterEnabled,
    segmentFilterLoaded: Boolean(finalizerRuntimes?.segmentFilter),
    edgeTrimAdvisorLoaded: Boolean(finalizerRuntimes?.edgeTrimAdvisor),
  },
  runtimeInfo: detector.getRuntimeInfo(),
  detectorVersion: detector.getDetectorVersion(),
  frameCount: frames.length,
  analyzedEndSec: finalNowSec,
  finalSegmentCount: finalSegments.length,
  finalSegments,
  finalizationBatches,
  filterAdjustments: finalizedState.adjustments,
  metrics: manual.length ? metrics(predictedLabels, manualLabels) : null,
  rawModelMetrics: manual.length ? metrics(rawModelLabels, manualLabels) : null,
  matches: manual.length ? segmentMatches(finalSegments, manual) : [],
  checkpoints: includeCheckpoints ? checkpoints : undefined,
  frames: includeFrames ? frames : undefined,
};

await writeFile(out, JSON.stringify(summary, null, 2), 'utf8');
console.log(`[pcm-live-sim] wrote ${out}`);
console.log(`[pcm-live-sim] frames=${frames.length} segments=${finalSegments.length} filter=${segmentFilterEnabled ? 'on' : 'off'}`);
if (summary.metrics) console.log('[pcm-live-sim] metrics', JSON.stringify(summary.metrics));
for (const segment of finalSegments) {
  console.log(`  pred ${formatTime(segment.startSec)}-${formatTime(segment.endSec)} dur=${Math.round(segment.endSec - segment.startSec)} conf=${segment.confidence}`);
}
