import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_VARIANTS = ['pcm-current', 'pcm-no-filter', 'aed60-current'];
const CANDIDATE_CURRENT_BASELINE = Object.freeze({
  'pcm-candidate-model': 'pcm-current',
  'aed60-candidate-model': 'aed60-current',
});
const VARIANTS = Object.freeze({
  'pcm-current': {
    suffix: 'pcm_filter_on',
    liveMethod: 'pcm-rollover-30min',
    segmentFilter: true,
  },
  'pcm-current-no-speech-reset': {
    suffix: 'pcm_filter_on_no_speech_reset',
    liveMethod: 'pcm-rollover-30min',
    segmentFilter: true,
    disableSpeechResetEndRefinement: true,
  },
  'pcm-current-start-trim': {
    suffix: 'pcm_filter_on_start_trim',
    liveMethod: 'pcm-rollover-30min',
    segmentFilter: true,
    enableStartEdgeTrim: true,
    startEdgeTrimScale: 0.75,
  },
  'pcm-current-no-start-trim': {
    suffix: 'pcm_filter_on_no_start_trim',
    liveMethod: 'pcm-rollover-30min',
    segmentFilter: true,
    disableStartEdgeTrim: true,
  },
  'pcm-no-filter': {
    suffix: 'pcm_filter_off',
    liveMethod: 'pcm-rollover-30min',
    segmentFilter: false,
  },
  'aed60-current': {
    suffix: 'aed60_overlap60',
    liveMethod: 'aed-cache-60s',
    segmentFilter: true,
  },
  'aed60-current-no-start-trim': {
    suffix: 'aed60_overlap60_no_start_trim',
    liveMethod: 'aed-cache-60s',
    segmentFilter: true,
    disableStartEdgeTrim: true,
  },
  'aed60-current-no-speech-reset': {
    suffix: 'aed60_overlap60_no_speech_reset',
    liveMethod: 'aed-cache-60s',
    segmentFilter: true,
    disableSpeechResetEndRefinement: true,
  },
  'aed60-no-filter': {
    suffix: 'aed60_filter_off',
    liveMethod: 'aed-cache-60s',
    segmentFilter: false,
  },
  'pcm-candidate-model': {
    suffix: 'pcm_candidate_model',
    liveMethod: 'pcm-rollover-30min',
    segmentFilter: true,
    candidateModel: true,
  },
  'aed60-candidate-model': {
    suffix: 'aed60_candidate_model',
    liveMethod: 'aed-cache-60s',
    segmentFilter: true,
    candidateModel: true,
  },
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

function splitCsv(value, fallback) {
  if (value === undefined || value === null || value === true) return fallback;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function finite(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function positiveInteger(value, fallback = 1) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(1, Math.min(64, num));
}

function toSeconds(value) {
  if (typeof value === 'number') return Math.max(0, value);
  const text = String(value || '').trim();
  if (!text) return 0;
  const parts = text.split(':').map((part) => Number(part.trim()));
  if (parts.length === 3 && parts.every(Number.isFinite)) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2 && parts.every(Number.isFinite)) return (parts[0] * 60) + parts[1];
  return Math.max(0, Number(text) || 0);
}

function normalizeRangeItem(raw, label) {
  if (Array.isArray(raw) && raw.length >= 2) {
    return {
      startSec: toSeconds(raw[0]),
      endSec: toSeconds(raw[1]),
      reason: raw[2] ? String(raw[2]) : null,
    };
  }
  if (raw && typeof raw === 'object') {
    return {
      startSec: toSeconds(raw.startSec ?? raw.start ?? raw.from),
      endSec: toSeconds(raw.endSec ?? raw.end ?? raw.to),
      reason: raw.reason ? String(raw.reason) : null,
    };
  }
  const text = String(raw || '').trim();
  const match = text.match(/^(.+?)\s*(?:-|~|->)\s*(.+)$/);
  if (!match) throw new Error(`Invalid ${label} range "${text}".`);
  return {
    startSec: toSeconds(match[1]),
    endSec: toSeconds(match[2]),
    reason: null,
  };
}

function normalizeRanges(value, label) {
  if (value === null || value === undefined || value === false) return [];
  const rawItems = Array.isArray(value)
    ? value
    : String(value).split(',').map((item) => item.trim()).filter(Boolean);
  return rawItems
    .map((item) => normalizeRangeItem(item, label))
    .filter((range) => Number.isFinite(range.startSec) && Number.isFinite(range.endSec) && range.endSec > range.startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

function formatIdSeconds(value) {
  const sec = Math.max(0, Math.round(Number(value) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h
    ? `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`
    : `${m}m${String(s).padStart(2, '0')}s`;
}

function formatMetric(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : '-';
}

function roundNumber(value, digits = 3) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function formatTime(value) {
  const sec = Math.max(0, Number(value) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const whole = Math.floor(s);
  const frac = s - whole;
  const secText = frac > 0.0005
    ? `${String(whole).padStart(2, '0')}${frac.toFixed(3).slice(1)}`
    : String(whole).padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${secText}`;
}

function createLineLogger(prefix) {
  let pending = '';
  return {
    write(chunk) {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        if (line) console.log(`${prefix}${line}`);
      }
    },
    flush() {
      if (pending) {
        console.log(`${prefix}${pending}`);
        pending = '';
      }
    },
  };
}

function runCommand(command, args, { cwd, label }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const prefix = label ? `[${label}] ` : '';
    const stdoutLogger = createLineLogger(prefix);
    const stderrLogger = createLineLogger(prefix);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => stdoutLogger.write(chunk));
    child.stderr?.on('data', (chunk) => stderrLogger.write(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      stdoutLogger.flush();
      stderrLogger.flush();
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function normalizeSample(raw, index) {
  const id = String(raw.id || raw.video || raw.videoId || `sample_${index + 1}`).trim();
  const audio = String(raw.audio || raw.audioPath || '').trim();
  const manual = String(raw.manual || raw.manualPath || '').trim();
  const expectedNoSong = Boolean(raw.expectedNoSong || raw.noSong || raw.negativeOnly);
  if (!id || !audio || (!manual && !expectedNoSong)) {
    throw new Error(`Invalid sample at index ${index}: id/audio/manual are required unless expectedNoSong is true.`);
  }
  return {
    id,
    audio,
    manual: manual || null,
    expectedNoSong,
    maxPredictedSongSec: raw.maxPredictedSongSec ?? raw.maxFalsePositiveSec ?? null,
    start: raw.start ?? raw.startSec ?? null,
    end: raw.end ?? raw.endSec ?? null,
    stopCheckpoints: raw.stopCheckpoints ?? raw.stopAtSec ?? raw.stopAt ?? null,
    includeBaseSample: raw.includeBaseSample ?? false,
    stallInsertions: raw.stallInsertions ?? null,
    gateStalls: raw.gateStalls ?? null,
    snapshotUnavailableInsertions: raw.snapshotUnavailableInsertions
      ?? raw.snapshotUnavailable
      ?? raw.snapshotUnavailableRanges
      ?? null,
    ignoreRanges: normalizeRanges(raw.ignoreRanges ?? raw.ignore ?? raw.evaluationIgnoreRanges, 'ignoreRanges'),
  };
}

function splitStopCheckpoints(value) {
  if (value === null || value === undefined || value === false) return [];
  const rawItems = Array.isArray(value)
    ? value
    : String(value).split(',').map((item) => item.trim()).filter(Boolean);
  return rawItems
    .map(toSeconds)
    .filter((sec) => Number.isFinite(sec) && sec > 0)
    .sort((a, b) => a - b);
}

function expandStopCheckpointSamples(samples) {
  const output = [];
  for (const sample of samples) {
    const checkpoints = splitStopCheckpoints(sample.stopCheckpoints);
    if (!checkpoints.length) {
      output.push(sample);
      continue;
    }
    if (sample.includeBaseSample) {
      output.push({
        ...sample,
        stopCheckpoints: null,
        stopCheckpointSec: null,
        stopCheckpointSourceId: sample.id,
      });
    }
    for (const checkpointSec of checkpoints) {
      output.push({
        ...sample,
        id: `${sample.id}_stop_${formatIdSeconds(checkpointSec)}`,
        end: checkpointSec,
        stopCheckpoints: null,
        stopCheckpointSec: checkpointSec,
        stopCheckpointSourceId: sample.id,
      });
    }
  }
  return output;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function runVariant({ cwd, sample, variantName, variant, outDir, options }) {
  const outPath = resolve(outDir, `${sample.id}_${variant.suffix}.json`);
  if (!options.force && existsSync(outPath)) {
    return { path: outPath, summary: await readJson(outPath), reused: true, elapsedMs: 0 };
  }

  const args = [
    'tools/live/simulate_live_pcm_detection.mjs',
    '--audio',
    sample.audio,
    '--out',
    outPath,
    '--live-method',
    variant.liveMethod,
    '--report-step-sec',
    String(options.reportStepSec),
    '--lookahead-sec',
    String(options.lookaheadSec),
    '--min-segment-duration-sec',
    String(options.minSegmentDurationSec),
  ];
  if (sample.manual) args.push('--manual', sample.manual);
  if (sample.start !== null && sample.start !== undefined) args.push('--start-sec', String(sample.start));
  if (sample.end !== null && sample.end !== undefined) args.push('--end-sec', String(sample.end));
  if (sample.stallInsertions !== null && sample.stallInsertions !== undefined) {
    const encodedStalls = Array.isArray(sample.stallInsertions)
      ? sample.stallInsertions.map((item) => {
        if (typeof item === 'string') return item;
        const atSec = item.atSec ?? item.at ?? item.startSec ?? item.start;
        const durationSec = item.durationSec ?? item.duration ?? item.sec;
        return `${atSec}:${durationSec}`;
      }).join(',')
      : String(sample.stallInsertions);
    if (encodedStalls) args.push('--stall-insertions', encodedStalls);
  }
  if (sample.gateStalls === true) args.push('--gate-stalls');
  if (sample.snapshotUnavailableInsertions !== null && sample.snapshotUnavailableInsertions !== undefined) {
    const encodedUnavailable = Array.isArray(sample.snapshotUnavailableInsertions)
      ? sample.snapshotUnavailableInsertions.map((item) => {
        if (typeof item === 'string') return item;
        const atSec = item.atSec ?? item.at ?? item.startSec ?? item.start;
        const durationSec = item.durationSec ?? item.duration ?? item.sec;
        return `${atSec}:${durationSec}`;
      }).join(',')
      : String(sample.snapshotUnavailableInsertions);
    if (encodedUnavailable) args.push('--snapshot-unavailable-insertions', encodedUnavailable);
  }
  if (Array.isArray(sample.ignoreRanges) && sample.ignoreRanges.length) {
    args.push(
      '--ignore-ranges',
      sample.ignoreRanges.map((range) => `${range.startSec}:${range.endSec}`).join(',')
    );
  }
  const modelDir = variant.candidateModel ? options.candidateSegmentFilterModelDir : options.segmentFilterModelDir;
  if (variant.candidateModel && !modelDir) {
    throw new Error(`${variantName} requires --candidate-segment-filter-model-dir.`);
  }
  if (modelDir) args.push('--segment-filter-model-dir', modelDir);
  if (options.segmentFilterProfile) args.push('--segment-filter-profile', options.segmentFilterProfile);
  if (!variant.segmentFilter) args.push('--no-segment-filter');
  if (options.requireProfileAssets && variant.segmentFilter) args.push('--require-profile-assets');
  if (variant.disableSpeechResetEndRefinement) args.push('--disable-speech-reset-end-refinement');
  if (variant.enableStartEdgeTrim) {
    args.push('--enable-start-edge-trim');
    if (Number.isFinite(Number(variant.startEdgeTrimScale))) {
      args.push('--start-edge-trim-scale', String(variant.startEdgeTrimScale));
    }
  }
  if (variant.disableStartEdgeTrim) args.push('--disable-start-edge-trim');
  if (options.includeFrames) args.push('--include-frames');

  const label = `${sample.id} ${variantName}`;
  console.log(`[live-pcm-ab] run ${label}`);
  const startedAt = Date.now();
  await runCommand(process.execPath, args, { cwd, label });
  return { path: outPath, summary: await readJson(outPath), reused: false, elapsedMs: Date.now() - startedAt };
}

function buildRow({ sample, variantName, result, options }) {
  const metrics = result.summary.metrics || null;
  const expectedNoSongSummary = summarizeExpectedNoSong(sample, result.summary);
  const perSongDeviationSummary = classifyPerSongDeviations(sample, variantName, result.summary, options);
  const expectedNoSongLimit = sample.maxPredictedSongSec === null || sample.maxPredictedSongSec === undefined
    ? options.maxNoSongPredictedSec
    : finite(sample.maxPredictedSongSec, null);
  if (expectedNoSongSummary && expectedNoSongLimit !== null) {
    expectedNoSongSummary.maxPredictedSongSec = expectedNoSongLimit;
    expectedNoSongSummary.passed = expectedNoSongSummary.predictedSongSec <= expectedNoSongLimit;
  }
  return {
    sampleId: sample.id,
    variant: variantName,
    outputPath: result.path,
    reused: result.reused,
    elapsedMs: result.elapsedMs,
    metrics,
    expectedNoSong: sample.expectedNoSong,
    expectedNoSongSummary,
    perSongDeviationSummary,
    evaluationIgnoredSec: result.summary.evaluationIgnoredSec || 0,
    evaluationManualCount: result.summary.evaluationManualCount ?? null,
    evaluationSkippedShortManualCount: Array.isArray(result.summary.evaluationSkippedShortManualSegments)
      ? result.summary.evaluationSkippedShortManualSegments.length
      : 0,
    severeOutlierCount: Array.isArray(result.summary.severeOutliers)
      ? result.summary.severeOutliers.length
      : 0,
    perSongDeviationIssueCount: perSongDeviationSummary.issueCount,
    perSongDeviationAffectedSongCount: perSongDeviationSummary.affectedSongCount,
    perSongDeviationPassed: perSongDeviationSummary.passed,
    stopCheckpointSec: sample.stopCheckpointSec ?? null,
    stopCheckpointSourceId: sample.stopCheckpointSourceId ?? null,
    segmentCount: result.summary.finalSegmentCount || 0,
    modelDir: VARIANTS[variantName].candidateModel
      ? options.candidateSegmentFilterModelDir
      : (VARIANTS[variantName].segmentFilter ? options.segmentFilterModelDir || 'models/fireredvad/aed' : null),
    segmentFilterAssetProfile: result.summary.params?.segmentFilterAssetProfile || null,
    segmentFilterAssetProfileUsed: result.summary.params?.segmentFilterAssetProfileUsed || null,
    edgeTrimAdvisorAssetProfileUsed: result.summary.params?.edgeTrimAdvisorAssetProfileUsed || null,
    requireProfileAssets: Boolean(result.summary.params?.requireProfileAssets),
  };
}

function logRow(row) {
  console.log(
    `[live-pcm-ab] ${row.sampleId} ${row.variant} `
    + `F1=${formatMetric(row.metrics?.f1)} P=${formatMetric(row.metrics?.precision)} R=${formatMetric(row.metrics?.recall)} `
    + `segments=${row.segmentCount}`
    + (row.severeOutlierCount ? ` outliers=${row.severeOutlierCount}` : '')
    + (row.perSongDeviationIssueCount ? ` songDeviation=${row.perSongDeviationIssueCount}` : '')
    + (row.evaluationSkippedShortManualCount
      ? ` shortManualSkipped=${row.evaluationSkippedShortManualCount}`
      : '')
    + (row.expectedNoSongSummary ? ` noSongPred=${formatMetric(row.expectedNoSongSummary.predictedSongSec)}s` : '')
    + `${row.reused ? ' reused' : ` elapsed=${formatMetric(row.elapsedMs / 1000)}s`}`
  );
}

async function runWithConcurrency(tasks, jobs, worker) {
  const results = new Array(tasks.length);
  let nextIndex = 0;
  let active = 0;
  return new Promise((resolvePromise) => {
    const launch = () => {
      while (active < jobs && nextIndex < tasks.length) {
        const currentIndex = nextIndex;
        const task = tasks[currentIndex];
        nextIndex += 1;
        active += 1;
        Promise.resolve()
          .then(() => worker(task, currentIndex))
          .then((value) => {
            results[currentIndex] = { ok: true, value };
          })
          .catch((error) => {
            results[currentIndex] = { ok: false, task, error };
            console.error(
              `[live-pcm-ab] task failed ${task.sample.id} ${task.variantName}: `
              + `${error?.message || String(error)}`
            );
          })
          .finally(() => {
            active -= 1;
            if (nextIndex >= tasks.length && active === 0) {
              resolvePromise(results);
              return;
            }
            launch();
          });
      }
    };
    launch();
  });
}

function segmentOverlapSec(segment, startSec, endSec) {
  const start = Math.max(Number(segment?.startSec) || 0, startSec);
  const end = Math.min(Number(segment?.endSec) || 0, endSec);
  return Math.max(0, end - start);
}

function summarizeExpectedNoSong(sample, summary) {
  if (!sample.expectedNoSong) return null;
  const rangeStart = finite(summary?.params?.analysisStartOriginSec, finite(sample.start, 0));
  const rangeEnd = finite(summary?.analyzedEndSec, finite(sample.end, rangeStart));
  const predictedSongSec = (Array.isArray(summary?.finalSegments) ? summary.finalSegments : [])
    .reduce((total, segment) => total + segmentOverlapSec(segment, rangeStart, rangeEnd), 0);
  const maxPredictedSongSec = sample.maxPredictedSongSec === null || sample.maxPredictedSongSec === undefined
    ? null
    : finite(sample.maxPredictedSongSec, null);
  return {
    rangeStart,
    rangeEnd,
    durationSec: Math.max(0, rangeEnd - rangeStart),
    predictedSongSec,
    maxPredictedSongSec,
    passed: maxPredictedSongSec === null || predictedSongSec <= maxPredictedSongSec,
  };
}

function classifyPerSongDeviations(sample, variantName, summary, options) {
  const matches = Array.isArray(summary?.matches) ? summary.matches : [];
  const classifiedOutliers = Array.isArray(summary?.severeOutliers) ? summary.severeOutliers : [];
  const outlierTypesForManual = (manual) => classifiedOutliers
    .filter((outlier) => (
      Math.abs(finite(outlier?.manual?.startSec, -999999) - finite(manual?.startSec, 999999)) <= 0.01
      && Math.abs(finite(outlier?.manual?.endSec, -999999) - finite(manual?.endSec, 999999)) <= 0.01
    ))
    .map((outlier) => String(outlier.type || '').trim())
    .filter(Boolean);
  const issues = [];
  matches.forEach((match, index) => {
    const manual = match?.manual && typeof match.manual === 'object' ? match.manual : {};
    const best = match?.best && typeof match.best === 'object' ? match.best : null;
    const title = String(manual.title || manual.name || `song_${index + 1}`);
    const base = {
      sampleId: sample.id,
      variant: variantName,
      manualIndex: index + 1,
      title,
      manualStartSec: roundNumber(manual.startSec, 3),
      manualEndSec: roundNumber(manual.endSec, 3),
      manualStart: formatTime(manual.startSec),
      manualEnd: formatTime(manual.endSec),
      classifiedTypes: outlierTypesForManual(manual),
    };
    if (!best || !Number(best.overlapSec)) {
      issues.push({
        ...base,
        type: 'missed-song',
        recall: 0,
        precision: 0,
      });
      return;
    }

    const predicted = best.predicted || {};
    const recall = Number(best.recallRatio) || 0;
    const precision = Number(best.predictedPrecisionRatio) || 0;
    const startDeltaSec = Number(best.startDeltaSec) || 0;
    const endDeltaSec = Number(best.endDeltaSec) || 0;
    const detail = {
      ...base,
      predictedStartSec: roundNumber(predicted.startSec, 3),
      predictedEndSec: roundNumber(predicted.endSec, 3),
      predictedStart: formatTime(predicted.startSec),
      predictedEnd: formatTime(predicted.endSec),
      overlapSec: roundNumber(best.overlapSec, 3),
      recall: roundNumber(recall, 4),
      precision: roundNumber(precision, 4),
      startDeltaSec: roundNumber(startDeltaSec, 3),
      endDeltaSec: roundNumber(endDeltaSec, 3),
    };

    if (recall < options.perSongMinRecall) {
      issues.push({ ...detail, type: 'low-recall', threshold: options.perSongMinRecall });
    }
    if (precision < options.perSongMinPrecision) {
      issues.push({ ...detail, type: 'low-precision', threshold: options.perSongMinPrecision });
    }
    if (startDeltaSec < -options.perSongMaxStartDeltaSec) {
      issues.push({ ...detail, type: 'early-start', thresholdSec: -options.perSongMaxStartDeltaSec });
    }
    if (startDeltaSec > options.perSongMaxStartDeltaSec) {
      issues.push({ ...detail, type: 'late-start', thresholdSec: options.perSongMaxStartDeltaSec });
    }
    if (endDeltaSec < -options.perSongMaxEndDeltaSec) {
      issues.push({ ...detail, type: 'early-end', thresholdSec: -options.perSongMaxEndDeltaSec });
    }
    if (endDeltaSec > options.perSongMaxEndDeltaSec) {
      issues.push({ ...detail, type: 'late-end', thresholdSec: options.perSongMaxEndDeltaSec });
    }
  });

  const affectedSongs = new Set(issues.map((issue) => issue.manualIndex));
  return {
    issueCount: issues.length,
    affectedSongCount: affectedSongs.size,
    manualCount: matches.length,
    issues,
    passed: issues.length <= options.maxPerSongDeviationIssues,
  };
}

function aggregate(rows, variantName) {
  const selected = rows.filter((row) => row.variant === variantName && row.metrics);
  const expectedNoSongRows = rows.filter((row) => row.variant === variantName && row.expectedNoSong);
  const totals = { tp: 0, fp: 0, fn: 0, tn: 0 };
  let meanF1 = 0;
  let measuredCount = 0;
  let totalElapsedMs = 0;
  let expectedNoSongPredictedSec = 0;
  let expectedNoSongDurationSec = 0;
  let perSongDeviationIssueCount = 0;
  let perSongDeviationAffectedSongCount = 0;
  let perSongDeviationFailedRowCount = 0;
  for (const row of selected) {
    for (const key of Object.keys(totals)) totals[key] += Math.round(finite(row.metrics[key]));
    meanF1 += finite(row.metrics.f1);
    perSongDeviationIssueCount += finite(row.perSongDeviationIssueCount, 0);
    perSongDeviationAffectedSongCount += finite(row.perSongDeviationAffectedSongCount, 0);
    if (row.perSongDeviationPassed === false) perSongDeviationFailedRowCount += 1;
    if (!row.reused && Number.isFinite(Number(row.elapsedMs))) {
      measuredCount += 1;
      totalElapsedMs += Number(row.elapsedMs);
    }
  }
  for (const row of expectedNoSongRows) {
    expectedNoSongPredictedSec += finite(row.expectedNoSongSummary?.predictedSongSec, 0);
    expectedNoSongDurationSec += finite(row.expectedNoSongSummary?.durationSec, 0);
  }
  meanF1 /= Math.max(1, selected.length);
  const precision = totals.tp / Math.max(1, totals.tp + totals.fp);
  const recall = totals.tp / Math.max(1, totals.tp + totals.fn);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
  return {
    ...totals,
    precision,
    recall,
    f1,
    meanF1,
    sampleCount: selected.length,
    measuredCount,
    totalElapsedMs,
    meanElapsedMs: measuredCount ? totalElapsedMs / measuredCount : null,
    expectedNoSongCount: expectedNoSongRows.length,
    expectedNoSongPredictedSec,
    expectedNoSongDurationSec,
    perSongDeviationIssueCount,
    perSongDeviationAffectedSongCount,
    perSongDeviationFailedRowCount,
  };
}

function buildRegressionReport(aggregates, baselineName, candidateNames, maxMeanF1Drop) {
  const baseline = aggregates[baselineName];
  if (!baseline) return [];
  return candidateNames
    .filter((name) => name !== baselineName && aggregates[name])
    .map((name) => {
      const candidate = aggregates[name];
      const meanF1Drop = baseline.meanF1 - candidate.meanF1;
      return {
        baseline: baselineName,
        candidate: name,
        meanF1Drop,
        passed: meanF1Drop <= maxMeanF1Drop,
      };
    });
}

function buildCandidateCurrentRegression(aggregates, variantNames, maxMeanF1Drop) {
  return variantNames
    .filter((name) => CANDIDATE_CURRENT_BASELINE[name] && aggregates[name] && aggregates[CANDIDATE_CURRENT_BASELINE[name]])
    .map((name) => {
      const baselineName = CANDIDATE_CURRENT_BASELINE[name];
      const baseline = aggregates[baselineName];
      const candidate = aggregates[name];
      const meanF1Drop = baseline.meanF1 - candidate.meanF1;
      return {
        baseline: baselineName,
        candidate: name,
        meanF1Drop,
        passed: meanF1Drop <= maxMeanF1Drop,
      };
    });
}

function buildCandidateCurrentNoSongRegression(aggregates, variantNames, maxNoSongIncreaseSec) {
  return variantNames
    .filter((name) => CANDIDATE_CURRENT_BASELINE[name] && aggregates[name] && aggregates[CANDIDATE_CURRENT_BASELINE[name]])
    .map((name) => {
      const baselineName = CANDIDATE_CURRENT_BASELINE[name];
      const baseline = aggregates[baselineName];
      const candidate = aggregates[name];
      const comparable = baseline.expectedNoSongCount > 0 && candidate.expectedNoSongCount > 0;
      const predictedSongSecIncrease = candidate.expectedNoSongPredictedSec - baseline.expectedNoSongPredictedSec;
      return {
        baseline: baselineName,
        candidate: name,
        comparable,
        baselinePredictedSongSec: baseline.expectedNoSongPredictedSec,
        candidatePredictedSongSec: candidate.expectedNoSongPredictedSec,
        predictedSongSecIncrease,
        passed: !comparable || predictedSongSecIncrease <= maxNoSongIncreaseSec,
      };
    })
    .filter((row) => row.comparable);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const samplesPath = resolve(String(args.samples || 'tools/samples/live/live_pcm_ab_samples.example.json'));
  const outDir = resolve(String(args['out-dir'] || '.tmp_live_pcm_ab'));
  const variantNames = splitCsv(args.variants, DEFAULT_VARIANTS);
  for (const name of variantNames) {
    if (!VARIANTS[name]) throw new Error(`Unknown variant "${name}". Available: ${Object.keys(VARIANTS).join(', ')}`);
  }

  const samples = (await readJson(samplesPath)).map(normalizeSample);
  const expandedSamples = expandStopCheckpointSamples(samples);
  const allExpectedNoSong = expandedSamples.length > 0 && expandedSamples.every((sample) => sample.expectedNoSong);
  if (!allExpectedNoSong && expandedSamples.length < 3) {
    throw new Error(`At least 3 samples are required for live PCM A/B, got ${expandedSamples.length}.`);
  }

  await mkdir(outDir, { recursive: true });
  const options = {
    force: Boolean(args.force),
    reportStepSec: finite(args['report-step-sec'], 30),
    lookaheadSec: finite(args['lookahead-sec'], 180),
    minSegmentDurationSec: finite(args['min-segment-duration-sec'], 90),
    segmentFilterModelDir: args['segment-filter-model-dir'] ? String(args['segment-filter-model-dir']) : null,
    segmentFilterProfile: args['segment-filter-profile'] ? String(args['segment-filter-profile']) : null,
    candidateSegmentFilterModelDir: args['candidate-segment-filter-model-dir']
      ? String(args['candidate-segment-filter-model-dir'])
      : null,
    maxNoSongPredictedSec: args['max-no-song-predicted-sec'] === undefined
      ? null
      : finite(args['max-no-song-predicted-sec'], null),
    includeFrames: Boolean(args['include-frames']),
    requireProfileAssets: Boolean(args['require-profile-assets']),
    jobs: positiveInteger(args.jobs ?? args.parallel, 1),
    perSongMaxStartDeltaSec: finite(args['per-song-max-start-delta-sec'], 20),
    perSongMaxEndDeltaSec: finite(args['per-song-max-end-delta-sec'], 20),
    perSongMinRecall: finite(args['per-song-min-recall'], 0.9),
    perSongMinPrecision: finite(args['per-song-min-precision'], 0.85),
    maxPerSongDeviationIssues: finite(args['max-per-song-deviation-issues'], 0),
  };

  const tasks = [];
  for (const sample of expandedSamples) {
    for (const variantName of variantNames) {
      tasks.push({
        sample,
        variantName,
        variant: VARIANTS[variantName],
      });
    }
  }
  console.log(`[live-pcm-ab] tasks=${tasks.length} jobs=${options.jobs}`);

  const taskResults = await runWithConcurrency(tasks, options.jobs, async (task) => {
    const result = await runVariant({
      cwd,
      sample: task.sample,
      variantName: task.variantName,
      variant: task.variant,
      outDir,
      options,
    });
    const row = buildRow({
      sample: task.sample,
      variantName: task.variantName,
      result,
      options,
    });
    logRow(row);
    return row;
  });
  const rows = taskResults
    .filter((item) => item?.ok)
    .map((item) => item.value);
  const failures = taskResults
    .filter((item) => item && !item.ok)
    .map((item) => ({
      sampleId: item.task?.sample?.id || null,
      variant: item.task?.variantName || null,
      error: item.error?.stack || item.error?.message || String(item.error),
    }));

  const aggregates = Object.fromEntries(variantNames.map((name) => [name, aggregate(rows, name)]));
  const regression = buildRegressionReport(
    aggregates,
    String(args.baseline || 'pcm-no-filter'),
    variantNames,
    finite(args['max-mean-f1-drop'], 0.001)
  );
  const candidateCurrentRegression = buildCandidateCurrentRegression(
    aggregates,
    variantNames,
    finite(args['max-candidate-current-mean-f1-drop'], finite(args['max-mean-f1-drop'], 0.001))
  );
  const candidateCurrentNoSongRegression = buildCandidateCurrentNoSongRegression(
    aggregates,
    variantNames,
    finite(args['max-no-song-increase-sec'], 0.001)
  );
  const perSongDeviationIssues = rows.flatMap((row) => (
    Array.isArray(row.perSongDeviationSummary?.issues) ? row.perSongDeviationSummary.issues : []
  ));
  const baselineVariantForPerSongGate = String(args.baseline || 'pcm-no-filter');
  const perSongDeviationFailures = rows.filter((row) => (
    row.variant !== baselineVariantForPerSongGate
    && row.metrics
    && row.perSongDeviationPassed === false
  ));
  const payload = {
    samplesPath,
    outDir,
    variants: variantNames,
    options,
    sourceSampleCount: samples.length,
    expandedSampleCount: expandedSamples.length,
    taskCount: tasks.length,
    jobs: options.jobs,
    failureCount: failures.length,
    failures,
    rows,
    aggregates,
    regression,
    candidateCurrentRegression,
    candidateCurrentNoSongRegression,
    perSongDeviationGate: {
      baselineVariant: baselineVariantForPerSongGate,
      maxStartDeltaSec: options.perSongMaxStartDeltaSec,
      maxEndDeltaSec: options.perSongMaxEndDeltaSec,
      minRecall: options.perSongMinRecall,
      minPrecision: options.perSongMinPrecision,
      maxIssuesPerRow: options.maxPerSongDeviationIssues,
      failureCount: perSongDeviationFailures.length,
      passed: perSongDeviationFailures.length === 0,
    },
    perSongDeviationIssues,
  };
  await writeFile(resolve(outDir, 'live_pcm_ab_summary.json'), JSON.stringify(payload, null, 2), 'utf8');

  const csvLines = [
    'sample,variant,f1,precision,recall,tp,fp,fn,tn,segments,severeOutlierCount,perSongDeviationIssueCount,perSongDeviationAffectedSongCount,perSongDeviationPassed,evaluationManualCount,evaluationSkippedShortManualCount,evaluationIgnoredSec,expectedNoSong,predictedSongSec,maxPredictedSongSec,noSongPassed,stopCheckpointSec,reused,elapsedMs,modelDir,segmentFilterAssetProfile,segmentFilterAssetProfileUsed,edgeTrimAdvisorAssetProfileUsed,requireProfileAssets,output',
    ...rows.map((row) => [
      row.sampleId,
      row.variant,
      row.metrics?.f1 ?? '',
      row.metrics?.precision ?? '',
      row.metrics?.recall ?? '',
      row.metrics?.tp ?? '',
      row.metrics?.fp ?? '',
      row.metrics?.fn ?? '',
      row.metrics?.tn ?? '',
      row.segmentCount,
      row.severeOutlierCount,
      row.perSongDeviationIssueCount,
      row.perSongDeviationAffectedSongCount,
      row.perSongDeviationPassed,
      row.evaluationManualCount ?? '',
      row.evaluationSkippedShortManualCount ?? '',
      row.evaluationIgnoredSec ?? '',
      row.expectedNoSong || '',
      row.expectedNoSongSummary?.predictedSongSec ?? '',
      row.expectedNoSongSummary?.maxPredictedSongSec ?? '',
      row.expectedNoSongSummary ? row.expectedNoSongSummary.passed : '',
      row.stopCheckpointSec ?? '',
      row.reused,
      row.elapsedMs ?? '',
      row.modelDir ?? '',
      row.segmentFilterAssetProfile ?? '',
      row.segmentFilterAssetProfileUsed ?? '',
      row.edgeTrimAdvisorAssetProfileUsed ?? '',
      row.requireProfileAssets,
      row.outputPath,
    ].map(csvEscape).join(',')),
  ];
  await writeFile(resolve(outDir, 'live_pcm_ab_summary.csv'), `${csvLines.join('\n')}\n`, 'utf8');
  const perSongCsvLines = [
    'sample,variant,manualIndex,type,classifiedTypes,title,manualStart,manualEnd,predictedStart,predictedEnd,recall,precision,startDeltaSec,endDeltaSec,overlapSec,threshold,thresholdSec',
    ...perSongDeviationIssues.map((issue) => [
      issue.sampleId,
      issue.variant,
      issue.manualIndex,
      issue.type,
      Array.isArray(issue.classifiedTypes) ? issue.classifiedTypes.join('|') : '',
      issue.title,
      issue.manualStart,
      issue.manualEnd,
      issue.predictedStart ?? '',
      issue.predictedEnd ?? '',
      issue.recall ?? '',
      issue.precision ?? '',
      issue.startDeltaSec ?? '',
      issue.endDeltaSec ?? '',
      issue.overlapSec ?? '',
      issue.threshold ?? '',
      issue.thresholdSec ?? '',
    ].map(csvEscape).join(',')),
  ];
  await writeFile(resolve(outDir, 'live_pcm_ab_per_song_deviations.csv'), `${perSongCsvLines.join('\n')}\n`, 'utf8');

  console.log('[live-pcm-ab] aggregate');
  for (const [variantName, metrics] of Object.entries(aggregates)) {
    console.log(
      `  ${variantName}: meanF1=${formatMetric(metrics.meanF1)} `
      + `F1=${formatMetric(metrics.f1)} P=${formatMetric(metrics.precision)} R=${formatMetric(metrics.recall)} `
      + `FP=${metrics.fp} FN=${metrics.fn} `
      + `songDeviation=${metrics.perSongDeviationIssueCount}/${metrics.perSongDeviationAffectedSongCount}`
      + (metrics.expectedNoSongCount
        ? ` noSongPred=${formatMetric(metrics.expectedNoSongPredictedSec)}s/${formatMetric(metrics.expectedNoSongDurationSec)}s`
        : '')
      + (metrics.measuredCount ? ` meanElapsed=${formatMetric(metrics.meanElapsedMs / 1000)}s` : '')
    );
  }
  for (const item of regression) {
    console.log(
      `[live-pcm-ab] gate ${item.candidate} vs ${item.baseline}: `
      + `meanF1Drop=${formatMetric(item.meanF1Drop)} ${item.passed ? 'PASS' : 'FAIL'}`
    );
  }
  for (const item of candidateCurrentRegression) {
    console.log(
      `[live-pcm-ab] gate ${item.candidate} vs current ${item.baseline}: `
      + `meanF1Drop=${formatMetric(item.meanF1Drop)} ${item.passed ? 'PASS' : 'FAIL'}`
    );
  }
  for (const item of candidateCurrentNoSongRegression) {
    console.log(
      `[live-pcm-ab] gate ${item.candidate} no-song FP vs current ${item.baseline}: `
      + `increaseSec=${formatMetric(item.predictedSongSecIncrease)} ${item.passed ? 'PASS' : 'FAIL'}`
    );
  }
  console.log(
    `[live-pcm-ab] per-song deviation gate: `
    + `${payload.perSongDeviationGate.passed ? 'PASS' : 'FAIL'} `
    + `failures=${payload.perSongDeviationGate.failureCount} `
    + `thresholds=start<=${options.perSongMaxStartDeltaSec}s `
    + `end<=${options.perSongMaxEndDeltaSec}s `
    + `recall>=${options.perSongMinRecall} precision>=${options.perSongMinPrecision}`
  );
  if (args['fail-on-regression'] && regression.some((item) => !item.passed)) {
    process.exitCode = 1;
  }
  if (args['fail-on-regression'] && candidateCurrentRegression.some((item) => !item.passed)) {
    process.exitCode = 1;
  }
  if (args['fail-on-regression'] && candidateCurrentNoSongRegression.some((item) => !item.passed)) {
    process.exitCode = 1;
  }
  if (
    args['fail-on-regression']
    && rows.some((row) => row.expectedNoSongSummary && row.expectedNoSongSummary.passed === false)
  ) {
    process.exitCode = 1;
  }
  if (args['fail-on-regression'] && perSongDeviationFailures.length) {
    process.exitCode = 1;
  }
  if (failures.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[live-pcm-ab] failed: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});

