import { readFile, writeFile } from 'node:fs/promises';
import { smoothFireRedAnalyses } from '../lib/songDetection/globalSmoothing.js';
import { splitSongSegmentsByBoundaries } from '../lib/songDetection/boundaryDetector.js';

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function toSeconds(value) {
  if (typeof value === 'number') return Math.max(0, value);
  const parts = String(value || '').trim().split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  return Math.max(0, Number(value) || 0);
}

function formatTime(seconds) {
  const sec = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function loadManual(path) {
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

function normalizeIgnoreRange(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') {
    const startSec = toSeconds(raw.startSec ?? raw.start_sec ?? raw.start ?? raw.from);
    const endSec = toSeconds(raw.endSec ?? raw.end_sec ?? raw.end ?? raw.to);
    if (endSec <= startSec) return null;
    return {
      startSec,
      endSec,
      reason: String(raw.reason || raw.title || raw.label || '').trim(),
    };
  }
  const text = String(raw || '').trim();
  if (!text) return null;
  let parts = null;
  for (const separator of ['~', '-', ',']) {
    if (text.includes(separator)) {
      parts = text.split(separator, 2);
      break;
    }
  }
  if (!parts && text.split(':').length === 2) parts = text.split(':', 2);
  if (!parts || parts.length < 2) return null;
  const startSec = toSeconds(parts[0]);
  const endSec = toSeconds(parts[1]);
  return endSec > startSec ? { startSec, endSec, reason: '' } : null;
}

function collectIgnoreRanges(args, framesPayload) {
  const params = framesPayload?.params && typeof framesPayload.params === 'object' ? framesPayload.params : {};
  const rawGroups = [
    args['ignore-ranges'] ? String(args['ignore-ranges']).split(',') : null,
    framesPayload.ignoreRanges,
    framesPayload.ignore,
    framesPayload.evaluationIgnoreRanges,
    params.ignoreRanges,
    params.ignore,
    params.evaluationIgnoreRanges,
  ];
  const output = [];
  const seen = new Set();
  for (const rawGroup of rawGroups) {
    if (!rawGroup) continue;
    const items = Array.isArray(rawGroup) ? rawGroup : [rawGroup];
    for (const item of items) {
      const normalized = normalizeIgnoreRange(item);
      if (!normalized) continue;
      const key = `${normalized.startSec.toFixed(3)}:${normalized.endSec.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(normalized);
    }
  }
  return output.sort((a, b) => a.startSec - b.startSec);
}

function isIgnoredTime(timeSec, ignoreRanges) {
  return ignoreRanges.some((range) => timeSec >= range.startSec && timeSec < range.endSec);
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
  const f05 = (1.25 * precision * recall) / Math.max(1e-9, (0.25 * precision) + recall);
  return { precision, recall, f1, f0_5: f05, tp, fp, fn, tn };
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

const args = parseArgs(process.argv);
if (!args.frames || !args.manual || !args.out) {
  throw new Error('Usage: node tools/run_global_smoothing.mjs --frames <frames.json> --manual <manual.txt> --out <summary.json> [--smoothing-profile offline-final|live-pcm30|live-realtime-aed60] [--ignore-ranges start:end,...] [--split-medley] [--segment-filter-predictions <predictions.json>]');
}

const framesPayload = JSON.parse(await readFile(args.frames, 'utf8'));
const frames = Array.isArray(framesPayload.frames) ? framesPayload.frames : [];
const manual = await loadManual(args.manual);
const ignoreRanges = collectIgnoreRanges(args, framesPayload);
const endSec = Number(framesPayload.durationSec) || frames.at(-1)?.timeSec || 0;
const startSec = frames[0]?.timeSec ? Math.max(0, Number(frames[0].timeSec) - Number(framesPayload.hopSec || 0.5)) : 0;
let segmentFilterPredictions = null;
if (args['segment-filter-predictions']) {
  const predictionsPayload = JSON.parse(await readFile(args['segment-filter-predictions'], 'utf8'));
  segmentFilterPredictions = Array.isArray(predictionsPayload)
    ? predictionsPayload
    : predictionsPayload.predictions;
}
const smoothing = smoothFireRedAnalyses(frames, endSec, {
  startSec,
  smoothingProfile: args['smoothing-profile'] || 'offline-final',
  segmentFilterEnabled: Boolean(segmentFilterPredictions),
  segmentFilterPredictions,
});
let finalSegments = smoothing.segments;
let boundarySplit = null;
if (args['split-medley']) {
  boundarySplit = splitSongSegmentsByBoundaries(finalSegments, frames);
  finalSegments = boundarySplit.segments;
}

const times = frames.map((frame) => Number(frame.timeSec) || 0);
const predictedLabels = labelsFromSegments(times, finalSegments);
const manualLabels = labelsFromSegments(times, manual);
const rawModelLabels = frames.map((frame) => {
  const threshold = Number(frame.temporalHeadThreshold) || Number(framesPayload.temporalHeadThreshold) || 0.75;
  return Number(frame.temporalHeadProbability ?? frame.songProbability) >= threshold ? 1 : 0;
});
const evaluationMask = times.map((timeSec) => !isIgnoredTime(timeSec, ignoreRanges));
const filterByEvaluationMask = (values) => values.filter((_, index) => evaluationMask[index]);
const ignoredEvaluationFrameCount = evaluationMask.reduce((total, keep) => total + (keep ? 0 : 1), 0);

const summary = {
  frames: args.frames,
  manual: args.manual,
  ignoreRanges,
  method: smoothing.method,
  smoothingVersion: smoothing.smoothingVersion,
  smoothingProfile: smoothing.smoothingProfile,
  endSec,
  evaluationIgnoredFrameCount: ignoredEvaluationFrameCount,
  evaluationIgnoredSec: ignoredEvaluationFrameCount * (Number(framesPayload.hopSec) || 0.5),
  metrics: metrics(filterByEvaluationMask(predictedLabels), filterByEvaluationMask(manualLabels)),
  rawModelMetrics: metrics(filterByEvaluationMask(rawModelLabels), filterByEvaluationMask(manualLabels)),
  segments: finalSegments,
  trackerSegments: smoothing.trackerSegments,
  modelRunSegments: smoothing.modelRunSegments,
  fallbackSegments: smoothing.fallbackSegments,
  selectedModelFallbackSegments: smoothing.selectedModelFallbackSegments || [],
  droppedTrackerSegments: smoothing.droppedTrackerSegments || [],
  excludedMusicOnlySpans: smoothing.excludedMusicOnlySpans || [],
  droppedMusicOnlySegments: smoothing.droppedMusicOnlySegments || [],
  spectralEdgeRefinements: smoothing.spectralEdgeRefinements || [],
  segmentFilterAdjustments: smoothing.segmentFilterAdjustments || [],
  boundarySplit,
  matches: segmentMatches(finalSegments, manual),
};

await writeFile(args.out, JSON.stringify(summary, null, 2), 'utf8');
console.log(`[smoothing] method=${summary.method} segments=${finalSegments.length}`);
console.log('[metrics]', JSON.stringify(summary.metrics));
console.log('[rawModelMetrics]', JSON.stringify(summary.rawModelMetrics));
for (const segment of finalSegments) {
  console.log(`  pred ${formatTime(segment.startSec)}-${formatTime(segment.endSec)} dur=${Math.round(segment.endSec - segment.startSec)} conf=${segment.confidence}`);
}
for (const match of summary.matches) {
  const best = match.best;
  const predicted = best?.predicted;
  console.log(
    `  match ${formatTime(match.manual.startSec)}-${formatTime(match.manual.endSec)} ${match.manual.title}: `
    + (predicted
      ? `best=${formatTime(predicted.startSec)}-${formatTime(predicted.endSec)} overlap=${best.overlapSec.toFixed(1)} recall=${best.recallRatio.toFixed(2)} dStart=${best.startDeltaSec.toFixed(1)} dEnd=${best.endDeltaSec.toFixed(1)}`
      : 'no prediction')
  );
}
