import { readFile, writeFile } from 'node:fs/promises';
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

function finite(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundNumber(value, digits = 4) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function splitCsv(value) {
  if (value === undefined || value === null || value === true) return null;
  const items = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? new Set(items) : null;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

function collectVariantNames(baseline, candidate, allowedVariants = null) {
  const names = Array.from(new Set([
    ...Object.keys(baseline?.aggregates || {}),
    ...Object.keys(candidate?.aggregates || {}),
  ])).sort();
  return allowedVariants ? names.filter((name) => allowedVariants.has(name)) : names;
}

function metricDelta(candidate, baseline, key) {
  const left = finite(candidate?.[key], null);
  const right = finite(baseline?.[key], null);
  if (left === null || right === null) return null;
  return roundNumber(left - right, 6);
}

function buildRows(baseline, candidate, allowedVariants = null) {
  return collectVariantNames(baseline, candidate, allowedVariants).map((variant) => {
    const base = baseline?.aggregates?.[variant] || {};
    const cand = candidate?.aggregates?.[variant] || {};
    return {
      variant,
      baseline: base,
      candidate: cand,
      deltas: {
        meanF1: metricDelta(cand, base, 'meanF1'),
        f1: metricDelta(cand, base, 'f1'),
        precision: metricDelta(cand, base, 'precision'),
        recall: metricDelta(cand, base, 'recall'),
        fp: metricDelta(cand, base, 'fp'),
        fn: metricDelta(cand, base, 'fn'),
        perSongDeviationIssueCount: metricDelta(cand, base, 'perSongDeviationIssueCount'),
        perSongDeviationFailedRowCount: metricDelta(cand, base, 'perSongDeviationFailedRowCount'),
        expectedNoSongPredictedSec: metricDelta(cand, base, 'expectedNoSongPredictedSec'),
      },
    };
  });
}

function buildRegression(rows, maxMeanF1Drop, maxRecallDrop, maxFalsePositiveIncrease, maxPerSongDeviationFailureIncrease) {
  return rows.map((row) => {
    const meanF1Drop = -(finite(row.deltas.meanF1, 0));
    const recallDrop = -(finite(row.deltas.recall, 0));
    const falsePositiveIncrease = finite(row.deltas.fp, 0);
    const perSongDeviationFailureIncrease = finite(row.deltas.perSongDeviationFailedRowCount, 0);
    const passed = meanF1Drop <= maxMeanF1Drop
      && recallDrop <= maxRecallDrop
      && falsePositiveIncrease <= maxFalsePositiveIncrease
      && perSongDeviationFailureIncrease <= maxPerSongDeviationFailureIncrease;
    return {
      variant: row.variant,
      meanF1Drop: roundNumber(meanF1Drop, 6),
      recallDrop: roundNumber(recallDrop, 6),
      falsePositiveIncrease: roundNumber(falsePositiveIncrease, 3),
      perSongDeviationFailureIncrease: roundNumber(perSongDeviationFailureIncrease, 3),
      passed,
    };
  });
}

function buildCsv(rows, regression) {
  const regressionByVariant = Object.fromEntries(regression.map((item) => [item.variant, item]));
  const header = [
    'variant',
    'baselineMeanF1',
    'candidateMeanF1',
    'deltaMeanF1',
    'baselineF1',
    'candidateF1',
    'deltaF1',
    'deltaPrecision',
    'deltaRecall',
    'deltaFp',
    'deltaFn',
    'deltaPerSongDeviationIssues',
    'deltaPerSongDeviationFailedRows',
    'meanF1Drop',
    'recallDrop',
    'falsePositiveIncrease',
    'perSongDeviationFailureIncrease',
    'passed',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    const gate = regressionByVariant[row.variant] || {};
    lines.push([
      row.variant,
      row.baseline.meanF1,
      row.candidate.meanF1,
      row.deltas.meanF1,
      row.baseline.f1,
      row.candidate.f1,
      row.deltas.f1,
      row.deltas.precision,
      row.deltas.recall,
      row.deltas.fp,
      row.deltas.fn,
      row.deltas.perSongDeviationIssueCount,
      row.deltas.perSongDeviationFailedRowCount,
      gate.meanF1Drop,
      gate.recallDrop,
      gate.falsePositiveIncrease,
      gate.perSongDeviationFailureIncrease,
      gate.passed,
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function printRows(rows, regression) {
  const regressionByVariant = Object.fromEntries(regression.map((item) => [item.variant, item]));
  for (const row of rows) {
    const gate = regressionByVariant[row.variant] || {};
    console.log(
      `[ab-compare] ${row.variant} `
      + `meanF1 ${roundNumber(row.baseline.meanF1, 4)} -> ${roundNumber(row.candidate.meanF1, 4)} `
      + `delta=${row.deltas.meanF1} recallDelta=${row.deltas.recall} fpDelta=${row.deltas.fp} `
      + `songDeviationFailedDelta=${row.deltas.perSongDeviationFailedRowCount} `
      + `${gate.passed ? 'PASS' : 'FAIL'}`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const baselinePath = args.baseline;
  const candidatePath = args.candidate;
  if (!baselinePath || !candidatePath || baselinePath === true || candidatePath === true) {
    throw new Error('Usage: node tools/live/compare_live_ab_summaries.mjs --baseline <live_pcm_ab_summary.json> --candidate <live_pcm_ab_summary.json> [--out compare.json] [--csv compare.csv] [--max-mean-f1-drop 0.02] [--max-recall-drop 0.05] [--max-fp-increase 120] [--max-per-song-deviation-failure-increase 0]');
  }

  const baseline = await readJson(String(baselinePath));
  const candidate = await readJson(String(candidatePath));
  const allowedVariants = splitCsv(args.variants);
  const rows = buildRows(baseline, candidate, allowedVariants);
  const gates = {
    maxMeanF1Drop: finite(args['max-mean-f1-drop'], 0.02),
    maxRecallDrop: finite(args['max-recall-drop'], 0.05),
    maxFalsePositiveIncrease: finite(args['max-fp-increase'], 120),
    maxPerSongDeviationFailureIncrease: finite(args['max-per-song-deviation-failure-increase'], 0),
  };
  const regression = buildRegression(
    rows,
    gates.maxMeanF1Drop,
    gates.maxRecallDrop,
    gates.maxFalsePositiveIncrease,
    gates.maxPerSongDeviationFailureIncrease
  );
  const payload = {
    baselinePath: resolve(String(baselinePath)),
    candidatePath: resolve(String(candidatePath)),
    gates,
    rows,
    regression,
    passed: regression.every((item) => item.passed),
  };

  printRows(rows, regression);

  if (args.out) {
    const outPath = resolve(String(args.out));
    await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`[ab-compare] wrote ${outPath}`);
  }
  if (args.csv) {
    const csvPath = resolve(String(args.csv));
    await writeFile(csvPath, buildCsv(rows, regression), 'utf8');
    console.log(`[ab-compare] wrote ${csvPath}`);
  }
  if (args['fail-on-regression'] && !payload.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[ab-compare] failed: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});

