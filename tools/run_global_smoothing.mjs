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
  throw new Error('Usage: node tools/run_global_smoothing.mjs --frames <frames.json> --manual <manual.txt> --out <summary.json> [--split-medley]');
}

const framesPayload = JSON.parse(await readFile(args.frames, 'utf8'));
const frames = Array.isArray(framesPayload.frames) ? framesPayload.frames : [];
const manual = await loadManual(args.manual);
const endSec = Number(framesPayload.durationSec) || frames.at(-1)?.timeSec || 0;
const startSec = frames[0]?.timeSec ? Math.max(0, Number(frames[0].timeSec) - Number(framesPayload.hopSec || 0.5)) : 0;
const smoothing = smoothFireRedAnalyses(frames, endSec, { startSec });
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

const summary = {
  frames: args.frames,
  manual: args.manual,
  method: smoothing.method,
  smoothingVersion: smoothing.smoothingVersion,
  endSec,
  metrics: metrics(predictedLabels, manualLabels),
  rawModelMetrics: metrics(rawModelLabels, manualLabels),
  segments: finalSegments,
  trackerSegments: smoothing.trackerSegments,
  modelRunSegments: smoothing.modelRunSegments,
  fallbackSegments: smoothing.fallbackSegments,
  selectedModelFallbackSegments: smoothing.selectedModelFallbackSegments || [],
  droppedTrackerSegments: smoothing.droppedTrackerSegments || [],
  excludedMusicOnlySpans: smoothing.excludedMusicOnlySpans || [],
  droppedMusicOnlySegments: smoothing.droppedMusicOnlySegments || [],
  spectralEdgeRefinements: smoothing.spectralEdgeRefinements || [],
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
