import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

function boolArg(value) {
  return value === true || value === 'true' || value === '1';
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalPush(args, key, value) {
  if (value === undefined || value === null || value === false) return;
  if (value === true) {
    args.push(key);
    return;
  }
  args.push(key, String(value));
}

function runCommand(command, args, { cwd }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function runAb({
  cwd,
  samples,
  outDir,
  variants,
  baseline,
  force,
  segmentFilterModelDir,
  candidateSegmentFilterModelDir,
  maxMeanF1Drop,
  maxCandidateCurrentMeanF1Drop,
  maxNoSongIncreaseSec,
  maxNoSongPredictedSec,
  failOnRegression,
  requireProfileAssets,
  jobs,
}) {
  const args = [
    'tools/live/run_live_pcm_ab_samples.mjs',
    '--samples',
    samples,
    '--out-dir',
    outDir,
    '--variants',
    variants,
    '--baseline',
    baseline,
    '--max-mean-f1-drop',
    String(maxMeanF1Drop),
  ];
  if (force) args.push('--force');
  if (failOnRegression) args.push('--fail-on-regression');
  optionalPush(args, '--segment-filter-model-dir', segmentFilterModelDir);
  optionalPush(args, '--candidate-segment-filter-model-dir', candidateSegmentFilterModelDir);
  optionalPush(args, '--max-no-song-predicted-sec', maxNoSongPredictedSec);
  optionalPush(args, '--max-candidate-current-mean-f1-drop', maxCandidateCurrentMeanF1Drop);
  optionalPush(args, '--max-no-song-increase-sec', maxNoSongIncreaseSec);
  optionalPush(args, '--jobs', jobs);
  if (requireProfileAssets) args.push('--require-profile-assets');
  await runCommand(process.execPath, args, { cwd });
}

async function runCompare({
  cwd,
  baselineSummary,
  candidateSummary,
  outPath,
  csvPath,
  maxMeanF1Drop,
  maxRecallDrop,
  maxFalsePositiveIncrease,
  failOnRegression,
  variants,
}) {
  const args = [
    'tools/live/compare_live_ab_summaries.mjs',
    '--baseline',
    baselineSummary,
    '--candidate',
    candidateSummary,
    '--out',
    outPath,
    '--csv',
    csvPath,
    '--max-mean-f1-drop',
    String(maxMeanF1Drop),
    '--max-recall-drop',
    String(maxRecallDrop),
    '--max-fp-increase',
    String(maxFalsePositiveIncrease),
  ];
  optionalPush(args, '--variants', variants);
  if (failOnRegression) args.push('--fail-on-regression');
  await runCommand(process.execPath, args, { cwd });
}

function buildHardNegativeGate(summary, allowedVariants = null) {
  const rows = (summary?.rows || [])
    .filter((row) => row.expectedNoSongSummary)
    .filter((row) => !allowedVariants || allowedVariants.has(row.variant))
    .map((row) => ({
      sampleId: row.sampleId,
      variant: row.variant,
      predictedSongSec: row.expectedNoSongSummary.predictedSongSec,
      maxPredictedSongSec: row.expectedNoSongSummary.maxPredictedSongSec,
      passed: Boolean(row.expectedNoSongSummary.passed),
      outputPath: row.outputPath,
    }));
  return {
    expectedNoSongRowCount: rows.length,
    rows,
    passed: rows.length > 0 && rows.every((row) => row.passed),
  };
}

function buildAbGate(summary, allowedVariants = null) {
  const regression = (Array.isArray(summary?.regression) ? summary.regression : [])
    .filter((row) => !allowedVariants || allowedVariants.has(row.candidate));
  return {
    rowCount: regression.length,
    regression,
    passed: regression.length > 0 && regression.every((row) => row.passed),
  };
}

function canonicalSampleId(sampleId) {
  return String(sampleId || '')
    .replace(/_snapshot_unavailable$/u, '')
    .replace(/_stop_\d+h\d{2}m\d{2}s$/u, '')
    .replace(/_stop_\d+m\d{2}s$/u, '');
}

function summarySampleKeys(summary, allowedVariants = null) {
  const keys = new Set();
  for (const row of Array.isArray(summary?.rows) ? summary.rows : []) {
    if (allowedVariants && !allowedVariants.has(row.variant)) continue;
    const sourceId = row.stopCheckpointSourceId || row.sampleId;
    const key = canonicalSampleId(sourceId);
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

function assertMatchingSampleSets(label, leftSummary, rightSummary, allowedVariants = null) {
  const left = summarySampleKeys(leftSummary, allowedVariants);
  const right = summarySampleKeys(rightSummary, allowedVariants);
  const leftKey = left.join('\n');
  const rightKey = right.join('\n');
  if (!left.length || !right.length || leftKey !== rightKey) {
    throw new Error(
      `${label} sample set mismatch. `
      + `left=[${left.join(', ')}] right=[${right.join(', ')}]`
    );
  }
  return { left, right };
}

function assertAbSummaryCoverage(label, summary, { baseline, gateVariants }) {
  const variants = new Set(Array.isArray(summary?.variants) ? summary.variants : []);
  const missingVariants = [...gateVariants, baseline]
    .filter(Boolean)
    .filter((variant) => !variants.has(variant));
  if (missingVariants.length) {
    throw new Error(`${label} missing variants: ${missingVariants.join(', ')}`);
  }

  const regression = Array.isArray(summary?.regression) ? summary.regression : [];
  const missingRegression = [...gateVariants].filter((variant) => (
    !regression.some((row) => row.baseline === baseline && row.candidate === variant)
  ));
  if (missingRegression.length) {
    throw new Error(
      `${label} missing regression rows for baseline=${baseline}: ${missingRegression.join(', ')}`
    );
  }
}

function assertExpectedNoSongCoverage(label, summary, gateVariants) {
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  const missingVariants = [...gateVariants].filter((variant) => (
    !rows.some((row) => row.variant === variant && row.expectedNoSongSummary)
  ));
  if (missingVariants.length) {
    throw new Error(`${label} missing expected-no-song rows: ${missingVariants.join(', ')}`);
  }
}

function assertExpectedNoSongMinimumCoverage(label, summary, gateVariants, {
  minSampleCount,
  minDurationSec,
}) {
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  const failures = [];
  for (const variant of gateVariants) {
    const selected = rows.filter((row) => row.variant === variant && row.expectedNoSongSummary);
    const sampleIds = new Set(selected.map((row) => row.sampleId).filter(Boolean));
    const durationSec = selected.reduce((total, row) => (
      total + (Number(row.expectedNoSongSummary?.durationSec) || 0)
    ), 0);
    if (sampleIds.size < minSampleCount || durationSec < minDurationSec) {
      failures.push(
        `${variant} has ${sampleIds.size}/${minSampleCount} samples `
        + `and ${Math.round(durationSec)}/${Math.round(minDurationSec)}s`
      );
    }
  }
  if (failures.length) {
    throw new Error(`${label} expected-no-song coverage too small: ${failures.join('; ')}`);
  }
}

function buildStopCheckpointCoverage(summary, gateVariants, { minSampleCount }) {
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  const variants = {};
  for (const variant of gateVariants) {
    const selected = rows.filter((row) => (
      row.variant === variant
      && Number.isFinite(Number(row.stopCheckpointSec))
    ));
    const sampleIds = new Set(selected
      .map((row) => row.stopCheckpointSourceId || row.sampleId)
      .map(canonicalSampleId)
      .filter(Boolean));
    variants[variant] = {
      sampleCount: sampleIds.size,
      samples: [...sampleIds].sort(),
      rowCount: selected.length,
      passed: sampleIds.size >= minSampleCount,
    };
  }
  return {
    minStopSamples: minSampleCount,
    variants,
    passed: Object.values(variants).every((entry) => entry.passed),
  };
}

function assertStopCheckpointMinimumCoverage(label, summary, gateVariants, { minSampleCount }) {
  const coverage = buildStopCheckpointCoverage(summary, gateVariants, { minSampleCount });
  if (!coverage.passed) {
    const failures = Object.entries(coverage.variants)
      .filter(([, entry]) => !entry.passed)
      .map(([variant, entry]) => `${variant} has ${entry.sampleCount}/${minSampleCount} samples`);
    throw new Error(`${label} stop-checkpoint coverage too small: ${failures.join('; ')}`);
  }
  return coverage;
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const outDir = resolve(String(args['out-dir'] || '.tmp_live_regression_suite'));
  const normalOutDir = resolve(outDir, 'primary_normal');
  const extendedOutDir = resolve(outDir, 'extended_normal');
  const snapshotOutDir = resolve(outDir, 'snapshot_unavailable');
  const stopOutDir = resolve(outDir, 'stop_checkpoint');
  const hardNegativeOutDir = resolve(outDir, 'no_song');
  const compareOutPath = resolve(outDir, 'snapshot_unavailable_vs_normal.json');
  const compareCsvPath = resolve(outDir, 'snapshot_unavailable_vs_normal.csv');
  const providedNormalSummary = args['normal-summary']
    ? resolve(String(args['normal-summary']))
    : (args['primary-normal-summary'] ? resolve(String(args['primary-normal-summary'])) : null);
  const providedExtendedSummary = args['extended-summary'] ? resolve(String(args['extended-summary'])) : null;
  const providedSnapshotSummary = args['snapshot-summary'] ? resolve(String(args['snapshot-summary'])) : null;
  const providedStopSummary = args['stop-summary'] ? resolve(String(args['stop-summary'])) : null;
  const providedHardNegativeSummary = args['hard-negative-summary']
    ? resolve(String(args['hard-negative-summary']))
    : null;
  const normalSamples = String(args['normal-samples'] || args['primary-normal-samples'] || 'tools/samples/live/live_pcm_ab_samples.example.json');
  const extendedSamples = String(args['extended-samples'] || 'tools/samples/live/live_pcm_extended_samples.example.json');
  const snapshotSamples = String(args['snapshot-samples'] || 'tools/samples/live/live_pcm_snapshot_unavailable_samples.example.json');
  const stopSamples = String(args['stop-samples'] || 'tools/samples/live/live_pcm_stop_checkpoint_samples.example.json');
  const hardNegativeSamples = String(args['hard-negative-samples'] || 'tools/samples/live/live_pcm_no_song_samples.example.json');
  const variants = String(args.variants || 'pcm-current,pcm-no-filter,aed60-current');
  const gateVariants = String(args['gate-variants'] || 'pcm-current,aed60-current');
  const allowedVariants = new Set(splitCsv(gateVariants));
  const baseline = String(args.baseline || 'pcm-no-filter');
  const force = boolArg(args.force);
  const failOnRegression = boolArg(args['fail-on-regression']);
  const skipExtended = boolArg(args['skip-extended']);
  const skipStop = boolArg(args['skip-stop']);
  const skipHardNegative = boolArg(args['skip-hard-negative']);
  const maxMeanF1Drop = Number(args['max-mean-f1-drop'] ?? 0.001);
  const maxCandidateCurrentMeanF1Drop = Number(args['max-candidate-current-mean-f1-drop'] ?? maxMeanF1Drop);
  const maxNoSongIncreaseSec = Number(args['max-no-song-increase-sec'] ?? 0.001);
  const maxSnapshotMeanF1Drop = Number(args['max-snapshot-mean-f1-drop'] ?? 0.02);
  const maxSnapshotRecallDrop = Number(args['max-snapshot-recall-drop'] ?? 0.05);
  const maxSnapshotFpIncrease = Number(args['max-snapshot-fp-increase'] ?? 120);
  const maxNoSongPredictedSec = Number(args['max-no-song-predicted-sec'] ?? 30);
  const minNoSongSamples = Number(args['min-no-song-samples'] ?? 4);
  const minNoSongDurationSec = Number(args['min-no-song-duration-sec'] ?? 3000);
  const minStopSamples = Number(args['min-stop-samples'] ?? 3);
  const segmentFilterModelDir = args['segment-filter-model-dir'] ? String(args['segment-filter-model-dir']) : null;
  const candidateSegmentFilterModelDir = args['candidate-segment-filter-model-dir']
    ? String(args['candidate-segment-filter-model-dir'])
    : null;
  const requireProfileAssets = boolArg(args['require-profile-assets']);
  const jobs = Number(args.jobs ?? 3);

  await mkdir(outDir, { recursive: true });

  if (!providedNormalSummary) {
    await runAb({
      cwd,
      samples: normalSamples,
      outDir: normalOutDir,
      variants,
      baseline,
      force,
      segmentFilterModelDir,
      candidateSegmentFilterModelDir,
      maxMeanF1Drop,
      maxCandidateCurrentMeanF1Drop,
      maxNoSongIncreaseSec,
      failOnRegression,
      requireProfileAssets,
      jobs,
    });
  }
  if (!skipExtended && !providedExtendedSummary) {
    await runAb({
      cwd,
      samples: extendedSamples,
      outDir: extendedOutDir,
      variants,
      baseline,
      force,
      segmentFilterModelDir,
      candidateSegmentFilterModelDir,
      maxMeanF1Drop,
      maxCandidateCurrentMeanF1Drop,
      maxNoSongIncreaseSec,
      failOnRegression,
      requireProfileAssets,
      jobs,
    });
  }
  if (!providedSnapshotSummary) {
    await runAb({
      cwd,
      samples: snapshotSamples,
      outDir: snapshotOutDir,
      variants,
      baseline,
      force,
      segmentFilterModelDir,
      candidateSegmentFilterModelDir,
      maxMeanF1Drop,
      maxCandidateCurrentMeanF1Drop,
      maxNoSongIncreaseSec,
      failOnRegression,
      requireProfileAssets,
      jobs,
    });
  }
  if (!skipStop && !providedStopSummary) {
    await runAb({
      cwd,
      samples: stopSamples,
      outDir: stopOutDir,
      variants,
      baseline,
      force,
      segmentFilterModelDir,
      candidateSegmentFilterModelDir,
      maxMeanF1Drop,
      maxCandidateCurrentMeanF1Drop,
      maxNoSongIncreaseSec,
      failOnRegression,
      requireProfileAssets,
      jobs,
    });
  }
  if (!skipHardNegative && !providedHardNegativeSummary) {
    await runAb({
      cwd,
      samples: hardNegativeSamples,
      outDir: hardNegativeOutDir,
      variants: gateVariants,
      baseline: splitCsv(gateVariants)[0] || 'pcm-current',
      force,
      segmentFilterModelDir,
      candidateSegmentFilterModelDir,
      maxMeanF1Drop,
      maxCandidateCurrentMeanF1Drop,
      maxNoSongIncreaseSec,
      maxNoSongPredictedSec,
      failOnRegression,
      requireProfileAssets,
      jobs,
    });
  }

  const normalSummary = providedNormalSummary || resolve(normalOutDir, 'live_pcm_ab_summary.json');
  const extendedSummary = skipExtended
    ? null
    : (providedExtendedSummary || resolve(extendedOutDir, 'live_pcm_ab_summary.json'));
  const snapshotSummary = providedSnapshotSummary || resolve(snapshotOutDir, 'live_pcm_ab_summary.json');
  const stopSummary = skipStop
    ? null
    : (providedStopSummary || resolve(stopOutDir, 'live_pcm_ab_summary.json'));
  const hardNegativeSummary = skipHardNegative
    ? null
    : (providedHardNegativeSummary || resolve(hardNegativeOutDir, 'live_pcm_ab_summary.json'));
  const normalPayload = await readJson(normalSummary);
  const snapshotPayload = await readJson(snapshotSummary);
  assertAbSummaryCoverage('normal summary', normalPayload, { baseline, gateVariants: allowedVariants });
  const snapshotSampleSet = assertMatchingSampleSets('snapshot-vs-normal', normalPayload, snapshotPayload, allowedVariants);

  await runCompare({
    cwd,
    baselineSummary: normalSummary,
    candidateSummary: snapshotSummary,
    outPath: compareOutPath,
    csvPath: compareCsvPath,
    maxMeanF1Drop: maxSnapshotMeanF1Drop,
    maxRecallDrop: maxSnapshotRecallDrop,
    maxFalsePositiveIncrease: maxSnapshotFpIncrease,
    failOnRegression,
    variants: gateVariants,
  });

  const normalGate = buildAbGate(normalPayload, allowedVariants);
  const extendedPayload = extendedSummary ? await readJson(extendedSummary) : null;
  if (extendedPayload) {
    assertAbSummaryCoverage('extended summary', extendedPayload, { baseline, gateVariants: allowedVariants });
  }
  const extendedGate = extendedPayload ? buildAbGate(extendedPayload, allowedVariants) : null;
  const stopPayload = stopSummary ? await readJson(stopSummary) : null;
  if (stopPayload) {
    assertAbSummaryCoverage('stop summary', stopPayload, { baseline, gateVariants: allowedVariants });
  }
  const stopCheckpointCoverage = stopPayload
    ? assertStopCheckpointMinimumCoverage('stop summary', stopPayload, allowedVariants, {
      minSampleCount: minStopSamples,
    })
    : null;
  const stopGate = stopPayload ? buildAbGate(stopPayload, allowedVariants) : null;
  const compare = await readJson(compareOutPath);
  const hardNegativePayload = hardNegativeSummary ? await readJson(hardNegativeSummary) : null;
  if (hardNegativePayload) {
    assertExpectedNoSongCoverage('no-song summary', hardNegativePayload, allowedVariants);
    assertExpectedNoSongMinimumCoverage('no-song summary', hardNegativePayload, allowedVariants, {
      minSampleCount: minNoSongSamples,
      minDurationSec: minNoSongDurationSec,
    });
  }
  const hardNegativeGate = hardNegativePayload ? buildHardNegativeGate(hardNegativePayload, allowedVariants) : null;
  const payload = {
    outDir,
    variants,
    gateVariants,
    baseline,
    normalSamples: resolve(normalSamples),
    extendedSamples: skipExtended ? null : resolve(extendedSamples),
    snapshotSamples: resolve(snapshotSamples),
    stopSamples: skipStop ? null : resolve(stopSamples),
    hardNegativeSamples: skipHardNegative ? null : resolve(hardNegativeSamples),
    normalSummary,
    extendedSummary,
    snapshotSummary,
    stopSummary,
    hardNegativeSummary,
    compareSummary: compareOutPath,
    compareCsv: compareCsvPath,
    snapshotSampleSet,
    noSongCoverageRequirements: skipHardNegative ? null : {
      minNoSongSamples,
      minNoSongDurationSec,
    },
    stopCoverageRequirements: skipStop ? null : {
      minStopSamples,
    },
    requireProfileAssets,
    maxCandidateCurrentMeanF1Drop,
    maxNoSongIncreaseSec,
    passed: normalGate.passed
      && (!extendedGate || extendedGate.passed)
      && (!stopGate || stopGate.passed)
      && (!stopCheckpointCoverage || stopCheckpointCoverage.passed)
      && Boolean(compare.passed)
      && (!hardNegativeGate || hardNegativeGate.passed),
    normalGate,
    extendedGate,
    stopGate,
    stopCheckpointCoverage,
    gates: compare.gates,
    regression: compare.regression,
    hardNegativeGate,
  };
  await writeFile(resolve(outDir, 'live_regression_suite_summary.json'), JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[live-regression-suite] passed=${payload.passed}`);
  console.log(`[live-regression-suite] wrote ${resolve(outDir, 'live_regression_suite_summary.json')}`);

  if (failOnRegression && !payload.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[live-regression-suite] failed: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});

