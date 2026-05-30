import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

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

function finite(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundNumber(value, digits = 3) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function overlapSeconds(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.min(finite(a.endSec), finite(b.endSec)) - Math.max(finite(a.startSec), finite(b.startSec)));
}

function segmentDurationSec(segment) {
  return Math.max(0, finite(segment?.endSec) - finite(segment?.startSec));
}

function overlapWithRanges(segment, ranges) {
  return (Array.isArray(ranges) ? ranges : [])
    .reduce((total, range) => total + overlapSeconds(segment, range), 0);
}

function overlapRatio(segment, ranges) {
  const duration = Math.max(1e-6, segmentDurationSec(segment));
  return overlapWithRanges(segment, ranges) / duration;
}

function closeEnough(a, b, toleranceSec = 1) {
  return Math.abs(finite(a) - finite(b)) <= toleranceSec;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function formatCsv(rows) {
  const headers = [
    'sample',
    'variant',
    'manualIndex',
    'type',
    'classifiedTypes',
    'title',
    'manualStartSec',
    'manualEndSec',
    'predictedStartSec',
    'predictedEndSec',
    'recall',
    'precision',
    'startDeltaSec',
    'endDeltaSec',
    'keepProbability',
    'action',
    'rawStartTrimDeltaSec',
    'startTrimDeltaSec',
    'endTrimDeltaSec',
    'startEvidenceReason',
    'startEvidencePass',
    'startBoundaryScan',
    'startBoundaryScanReason',
    'startCandidateStartSec',
    'endEvidenceReason',
    'trackerOverlapRatio',
    'modelRunOverlapRatio',
    'fallbackOverlapRatio',
    'selectedFallbackOverlapRatio',
    'skippedShortOverlapSec',
    'ignoreOverlapSec',
    'severeOutlierTypes',
    'outputPath',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function findIssueMatch(output, issue) {
  const index = Math.max(0, Math.floor(finite(issue.manualIndex, 1)) - 1);
  const matches = Array.isArray(output.matches) ? output.matches : [];
  const indexed = matches[index];
  if (indexed?.manual) return indexed;
  return matches.find((match) => (
    closeEnough(match?.manual?.startSec, issue.manualStartSec, 0.75)
    && closeEnough(match?.manual?.endSec, issue.manualEndSec, 0.75)
  )) || null;
}

function findAdjustment(output, predicted) {
  if (!predicted) return null;
  const adjustments = Array.isArray(output.filterAdjustments) ? output.filterAdjustments : [];
  let best = null;
  for (const adjustment of adjustments) {
    const segment = adjustment.segment || adjustment.original;
    if (!segment) continue;
    const startDistance = Math.abs(finite(segment.startSec) - finite(predicted.startSec));
    const endDistance = Math.abs(finite(segment.endSec) - finite(predicted.endSec));
    const overlap = overlapSeconds(segment, predicted);
    const score = overlap - (startDistance + endDistance);
    if (!best || score > best.score) best = { adjustment, score, overlap };
  }
  return best && best.overlap > 0 ? best.adjustment : null;
}

function findSevereOutlierTypes(output, issue) {
  const severe = Array.isArray(output.severeOutliers) ? output.severeOutliers : [];
  const matching = severe.filter((outlier) => {
    const manual = outlier.manual || outlier.segment || outlier.target;
    if (!manual) return false;
    return closeEnough(manual.startSec, issue.manualStartSec, 1)
      && closeEnough(manual.endSec, issue.manualEndSec, 1);
  });
  return matching
    .map((outlier) => outlier.type || outlier.reason || outlier.kind)
    .filter(Boolean)
    .join('|');
}

function summarizeIssue(row, output, issue) {
  const match = findIssueMatch(output, issue);
  const predicted = match?.best?.predicted || (
    Number.isFinite(Number(issue.predictedStartSec)) && Number.isFinite(Number(issue.predictedEndSec))
      ? { startSec: finite(issue.predictedStartSec), endSec: finite(issue.predictedEndSec) }
      : null
  );
  const adjustment = findAdjustment(output, predicted);
  const startEvidence = adjustment?.startTrimEvidence || null;
  const boundaryScan = startEvidence?.boundaryScan || (startEvidence?.boundaryScan === true ? startEvidence : null);
  const endEvidence = adjustment?.endTrimEvidence || null;
  const skippedShort = output.evaluationSkippedShortManualSegments || [];
  const ignored = [
    ...(output.params?.evaluationIgnoreRanges || []),
    ...(output.params?.ignoreRanges || []),
  ];

  return {
    sample: row.sampleId,
    variant: row.variant,
    manualIndex: issue.manualIndex,
    type: issue.type,
    classifiedTypes: (issue.classifiedTypes || []).join('|'),
    title: issue.title || '',
    manualStartSec: roundNumber(issue.manualStartSec),
    manualEndSec: roundNumber(issue.manualEndSec),
    predictedStartSec: predicted ? roundNumber(predicted.startSec) : null,
    predictedEndSec: predicted ? roundNumber(predicted.endSec) : null,
    recall: roundNumber(issue.recall, 4),
    precision: roundNumber(issue.precision, 4),
    startDeltaSec: roundNumber(issue.startDeltaSec),
    endDeltaSec: roundNumber(issue.endDeltaSec),
    keepProbability: roundNumber(adjustment?.keepProbability, 4),
    action: adjustment?.action || '',
    rawStartTrimDeltaSec: roundNumber(adjustment?.rawStartTrimDeltaSec),
    startTrimDeltaSec: roundNumber(adjustment?.startTrimDeltaSec),
    endTrimDeltaSec: roundNumber(adjustment?.endTrimDeltaSec),
    startEvidenceReason: startEvidence?.reason || '',
    startEvidencePass: startEvidence?.pass ?? '',
    startBoundaryScan: Boolean(startEvidence?.boundaryScan || boundaryScan?.boundaryScan),
    startBoundaryScanReason: boundaryScan?.reason || '',
    startCandidateStartSec: roundNumber(startEvidence?.candidateStartSec ?? boundaryScan?.candidateStartSec),
    endEvidenceReason: endEvidence?.reason || '',
    trackerOverlapRatio: predicted ? roundNumber(overlapRatio(predicted, output.trackerSegments), 4) : null,
    modelRunOverlapRatio: predicted ? roundNumber(overlapRatio(predicted, output.modelRunSegments), 4) : null,
    fallbackOverlapRatio: predicted ? roundNumber(overlapRatio(predicted, output.fallbackSegments), 4) : null,
    selectedFallbackOverlapRatio: predicted ? roundNumber(overlapRatio(predicted, output.selectedModelFallbackSegments), 4) : null,
    skippedShortOverlapSec: predicted ? roundNumber(overlapWithRanges(predicted, skippedShort)) : null,
    ignoreOverlapSec: predicted ? roundNumber(overlapWithRanges(predicted, ignored)) : null,
    severeOutlierTypes: findSevereOutlierTypes(output, issue),
    outputPath: row.outputPath,
    match,
    adjustment,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv);
  const summaryPath = args.summary ? resolve(String(args.summary)) : null;
  if (!summaryPath) {
    throw new Error('Usage: node tools/live/analyze_live_outliers.mjs --summary <live_pcm_ab_summary.json> [--variant pcm-current] [--out out.json] [--csv out.csv]');
  }
  const selectedVariant = args.variant ? String(args.variant) : null;
  const summary = await readJson(summaryPath);
  const rows = Array.isArray(summary.rows) ? summary.rows : [];
  const records = [];
  for (const row of rows) {
    if (selectedVariant && row.variant !== selectedVariant) continue;
    const issues = row.perSongDeviationSummary?.issues || [];
    if (!issues.length) continue;
    const outputPath = resolve(dirname(summaryPath), String(row.outputPath || ''));
    const output = await readJson(outputPath);
    for (const issue of issues) {
      records.push(summarizeIssue(row, output, issue));
    }
  }

  const publicRecords = records.map(({ match, adjustment, ...record }) => ({
    ...record,
    match,
    adjustment,
  }));
  const csvRows = records.map(({ match, adjustment, ...record }) => record);

  const outPath = args.out ? resolve(String(args.out)) : null;
  const csvPath = args.csv ? resolve(String(args.csv)) : null;
  if (outPath) await writeFile(outPath, JSON.stringify(publicRecords, null, 2), 'utf8');
  if (csvPath) await writeFile(csvPath, formatCsv(csvRows), 'utf8');

  console.log(`[live-outliers] summary=${summaryPath}`);
  console.log(`[live-outliers] issues=${records.length}${selectedVariant ? ` variant=${selectedVariant}` : ''}`);
  if (outPath) console.log(`[live-outliers] wrote ${outPath}`);
  if (csvPath) console.log(`[live-outliers] wrote ${csvPath}`);
  for (const record of csvRows.slice(0, 20)) {
    console.log([
      record.sample,
      record.variant,
      `#${record.manualIndex}`,
      record.type,
      `startDelta=${record.startDeltaSec}`,
      `endDelta=${record.endDeltaSec}`,
      `action=${record.action || '-'}`,
      `startTrim=${record.startTrimDeltaSec ?? '-'}`,
      `reason=${record.startEvidenceReason || '-'}`,
    ].join(' '));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
