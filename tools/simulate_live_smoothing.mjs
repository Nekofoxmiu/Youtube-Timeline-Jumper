import { readFile, writeFile } from 'node:fs/promises';
import { smoothFireRedAnalyses } from '../lib/songDetection/globalSmoothing.js';

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
  const parts = String(value || '').trim().split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  return Math.max(0, Number(value) || 0);
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
  return { precision, recall, f1, tp, fp, fn, tn };
}

function parseNumberList(value, fallback) {
  const raw = Array.isArray(value) ? value : (value === undefined ? [] : [value]);
  const parsed = raw.map(Number).filter(Number.isFinite);
  return parsed.length ? parsed : fallback;
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

function uniqueSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .slice()
    .sort((a, b) => Number(a.startSec) - Number(b.startSec) || Number(a.endSec) - Number(b.endSec))
    .filter((segment, index, list) => list.findIndex((candidate) => (
      Math.abs(Number(candidate.startSec) - Number(segment.startSec)) < 0.001
      && Math.abs(Number(candidate.endSec) - Number(segment.endSec)) < 0.001
    )) === index);
}

const args = parseArgs(process.argv);
if (!args.frames || !args.manual || !args.out) {
  throw new Error('Usage: node tools/simulate_live_smoothing.mjs --frames <frames.json> --manual <manual.txt> --out <summary.json> [--lookahead-sec 20 30 60] [--step-sec 30] [--policy full|rolling] [--resmooth-window-sec 180]');
}

const framesPayload = JSON.parse(await readFile(args.frames, 'utf8'));
const frames = Array.isArray(framesPayload.frames) ? framesPayload.frames : [];
const manual = await loadManual(args.manual);
const endSec = Number(framesPayload.durationSec) || frames.at(-1)?.timeSec || 0;
const startSec = frames[0]?.timeSec ? Math.max(0, Number(frames[0].timeSec) - Number(framesPayload.hopSec || 0.5)) : 0;
const lookaheads = parseNumberList(args['lookahead-sec'], [20, 30, 60, 90, 120]);
const stepSec = Number(args['step-sec']) || 30;
const resmoothWindowSec = Number(args['resmooth-window-sec']) || 180;
const overlapSec = Number(args['overlap-sec']) || 30;
const policy = String(args.policy || 'full').toLowerCase() === 'rolling' ? 'rolling' : 'full';
const results = [];

for (const lookaheadSec of lookaheads) {
  const times = [];
  const predicted = [];
  const actual = [];
  const checkpoints = [];
  const finalizedSegments = [];
  for (let nowSec = Math.max(30, startSec + stepSec); nowSec <= endSec; nowSec += stepSec) {
    const visibleEndSec = Math.min(endSec, nowSec + lookaheadSec);
    const visibleFrames = frames.filter((frame) => Number(frame.timeSec) <= visibleEndSec);
    const finalCutoffSec = Math.max(0, nowSec - lookaheadSec);
    const frozenUntilSec = Math.max(0, finalCutoffSec - overlapSec);
    const windowStartSec = policy === 'rolling'
      ? Math.max(startSec, frozenUntilSec - resmoothWindowSec)
      : startSec;
    const windowFrames = policy === 'rolling'
      ? visibleFrames.filter((frame) => Number(frame.timeSec) >= windowStartSec)
      : visibleFrames;
    const smoothing = smoothFireRedAnalyses(windowFrames, visibleEndSec, { startSec: windowStartSec });
    const newlyFinal = smoothing.segments
      .filter((segment) => Number(segment.endSec) <= finalCutoffSec)
      .filter((segment) => !finalizedSegments.some((known) => Math.abs(Number(known.startSec) - Number(segment.startSec)) < 0.001
        && Math.abs(Number(known.endSec) - Number(segment.endSec)) < 0.001));
    finalizedSegments.push(...newlyFinal);
    const visibleTimes = frames
      .map((frame) => Number(frame.timeSec) || 0)
      .filter((time) => time > nowSec - stepSec && time <= nowSec);
    const liveSegments = clipSegmentsToTime(uniqueSegments([...finalizedSegments, ...smoothing.segments]), nowSec);
    times.push(...visibleTimes);
    predicted.push(...labelsFromSegments(visibleTimes, liveSegments));
    actual.push(...labelsFromSegments(visibleTimes, manual));
    checkpoints.push({
      nowSec,
      visibleEndSec,
      finalCutoffSec,
      windowStartSec,
      segmentCount: liveSegments.length,
      finalizedSegmentCount: finalizedSegments.length,
      method: smoothing.method,
    });
  }
  results.push({
    lookaheadSec,
    stepSec,
    resmoothWindowSec,
    overlapSec,
    policy,
    metrics: metrics(predicted, actual),
    checkpointCount: checkpoints.length,
    checkpoints,
  });
}

await writeFile(args.out, JSON.stringify({ frames: args.frames, manual: args.manual, endSec, results }, null, 2), 'utf8');
console.log(`[live-sim] wrote ${args.out}`);
for (const result of results) {
  console.log(`[live-sim] lookahead=${result.lookaheadSec}s f1=${result.metrics.f1.toFixed(4)} p=${result.metrics.precision.toFixed(4)} r=${result.metrics.recall.toFixed(4)}`);
}
