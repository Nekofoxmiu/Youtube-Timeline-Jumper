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

function roundNumber(value, digits = 3) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function safeGet(object, path, fallback = null) {
  let current = object;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) return fallback;
    current = current[key];
  }
  return current ?? fallback;
}

function parseVideoFilter(value) {
  if (value === undefined || value === null || value === true) return null;
  const items = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? new Set(items) : null;
}

function playlistKey(videoId) {
  return `playlist_${videoId}`;
}

function formatCounts(value) {
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value)
    .filter(([, count]) => Number(count) !== 0)
    .map(([key, count]) => `${key}:${roundNumber(count, 3)}`)
    .join(';');
}

function summarizeCompletedRanges(analysis, diagnostics) {
  const summary = analysis?.completedRangesSummary || diagnostics?.completedAnalysisRanges || {};
  return {
    count: finite(summary?.count ?? analysis?.completedRangeCount, 0),
    frameCount: finite(summary?.frameCount ?? analysis?.completedFrameCount, 0),
    segmentCount: finite(summary?.segmentCount, 0),
    reasons: summary?.reasons || {},
    ranges: Array.isArray(summary?.ranges) ? summary.ranges : [],
  };
}

function summarizePlaylistItems(items) {
  const source = Array.isArray(items) ? items : [];
  const auto = source.filter((item) => item?.type === 'auto-song');
  const finalAuto = auto.filter((item) => !item.provisional);
  const provisionalAuto = auto.filter((item) => item.provisional);
  return {
    itemCount: source.length,
    autoSongCount: auto.length,
    finalAutoSongCount: finalAuto.length,
    provisionalAutoSongCount: provisionalAuto.length,
  };
}

function summarizeMeta(videoId, meta, items) {
  const analysis = meta?.analysisCacheSummary || {};
  const diagnostics = analysis?.liveFinalizationDiagnostics || {};
  const frameAll = analysis?.frameDistribution?.all || {};
  const frameFirst = analysis?.frameDistribution?.firstWindow || {};
  const frameTail = analysis?.frameDistribution?.tailWindow || {};
  const playback = diagnostics?.playbackDiagnostics || {};
  const snapshot = playback?.snapshot || {};
  const filterSummary = diagnostics?.segmentFilter?.adjustmentSummary || {};
  const filterCounts = filterSummary?.counts || {};
  const finalizationState = diagnostics?.finalizationState || {};
  const capture = diagnostics?.captureSuspensionStats || {};
  const completedRanges = summarizeCompletedRanges(analysis, diagnostics);
  const playlist = summarizePlaylistItems(items);

  return {
    videoId,
    hasLiveDiagnostics: Boolean(analysis?.liveFinalizationDiagnostics),
    source: meta?.source || null,
    detectorVersion: meta?.detectorVersion || null,
    refinedBy: meta?.refinedBy || null,
    smoothingMethod: meta?.smoothingMethod || null,
    lastAnalyzedAt: meta?.lastAnalyzedAt || null,
    frameCount: finite(analysis?.frameCount, 0),
    analysisStartSec: finite(analysis?.startSec, null),
    analysisEndSec: finite(analysis?.endSec, null),
    analysisSegmentCount: finite(analysis?.segmentCount, null),
    finalSegmentCount: finite(diagnostics?.finalSegmentCount, playlist.finalAutoSongCount),
    provisionalSegmentCount: finite(diagnostics?.provisionalSegmentCount, playlist.provisionalAutoSongCount),
    playlistItemCount: playlist.itemCount,
    autoSongCount: playlist.autoSongCount,
    modelHighRatio: roundNumber(frameAll?.modelHighRatio, 4),
    singingHighRatio: roundNumber(frameAll?.singingHighRatio, 4),
    musicOnlyLowVocalRatio: roundNumber(frameAll?.musicOnlyLowVocalRatio, 4),
    firstWindowMusicOnlyLowVocalRatio: roundNumber(frameFirst?.musicOnlyLowVocalRatio, 4),
    tailWindowMusicOnlyLowVocalRatio: roundNumber(frameTail?.musicOnlyLowVocalRatio, 4),
    segmentFilterAdjustmentCount: finite(filterSummary?.total, 0),
    segmentFilterCounts: filterCounts,
    segmentFilterKeepProbabilityMean: roundNumber(filterSummary?.keepProbabilityMean, 4),
    sourceRangeCount: finite(finalizationState?.sourceRangeCount, 0),
    completedRangeCount: completedRanges.count,
    completedRangeFrameCount: completedRanges.frameCount,
    completedRangeSegmentCount: completedRanges.segmentCount,
    completedRangeReasons: completedRanges.reasons,
    recentCompletedRanges: completedRanges.ranges.slice(-8),
    discontinuities: finite(analysis?.discontinuities, 0),
    maxSourceEndSec: finite(finalizationState?.maxSourceEndSec, null),
    filterApplied: Boolean(finalizationState?.filterApplied),
    snapshotRealCount: finite(snapshot?.realCount, 0),
    snapshotEstimatedCount: finite(snapshot?.estimatedCount, 0),
    snapshotFailureCount: finite(snapshot?.failureCount, 0),
    snapshotUnavailableCount: finite(snapshot?.unavailableCount, 0),
    playbackCounts: playback?.counts || {},
    suspensionReasons: playback?.suspensionReasons || capture?.reasons || {},
    seekCount: finite(playback?.seekCount, 0),
    videoBoundaryCount: finite(playback?.videoBoundaryCount, 0),
    suspendedAudioSec: finite(capture?.skippedAudioSec, 0),
    suspendedChunkCount: finite(capture?.skippedChunkCount, 0),
    recentEvents: Array.isArray(playback?.recentEvents) ? playback.recentEvents.slice(-12) : [],
  };
}

function rowNeedsAttention(row) {
  return Boolean(
    row.snapshotFailureCount
    || row.snapshotUnavailableCount
    || row.snapshotEstimatedCount > row.snapshotRealCount
    || row.seekCount
    || row.videoBoundaryCount
    || row.suspendedAudioSec > 5
    || row.completedRangeCount
    || row.musicOnlyLowVocalRatio >= 0.45
    || row.firstWindowMusicOnlyLowVocalRatio >= 0.55
    || row.segmentFilterCounts.drop
    || row.segmentFilterCounts['keep-live-protected']
  );
}

function buildCsv(rows) {
  const header = [
    'videoId',
    'hasLiveDiagnostics',
    'lastAnalyzedAt',
    'finalSegmentCount',
    'frameCount',
    'modelHighRatio',
    'singingHighRatio',
    'musicOnlyLowVocalRatio',
    'firstWindowMusicOnlyLowVocalRatio',
    'snapshotRealCount',
    'snapshotEstimatedCount',
    'snapshotFailureCount',
    'snapshotUnavailableCount',
    'seekCount',
    'videoBoundaryCount',
    'suspendedAudioSec',
    'completedRangeCount',
    'completedRangeReasons',
    'discontinuities',
    'segmentFilterCounts',
    'playbackCounts',
    'suspensionReasons',
    'needsAttention',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.videoId,
      row.hasLiveDiagnostics,
      row.lastAnalyzedAt,
      row.finalSegmentCount,
      row.frameCount,
      row.modelHighRatio,
      row.singingHighRatio,
      row.musicOnlyLowVocalRatio,
      row.firstWindowMusicOnlyLowVocalRatio,
      row.snapshotRealCount,
      row.snapshotEstimatedCount,
      row.snapshotFailureCount,
      row.snapshotUnavailableCount,
      row.seekCount,
      row.videoBoundaryCount,
      row.suspendedAudioSec,
      row.completedRangeCount,
      formatCounts(row.completedRangeReasons),
      row.discontinuities,
      formatCounts(row.segmentFilterCounts),
      formatCounts(row.playbackCounts),
      formatCounts(row.suspensionReasons),
      rowNeedsAttention(row),
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function printSummary(rows) {
  console.log(`[live-diagnostics] videos=${rows.length} withDiagnostics=${rows.filter((row) => row.hasLiveDiagnostics).length}`);
  for (const row of rows) {
    const flags = [];
    if (row.snapshotFailureCount || row.snapshotUnavailableCount) flags.push('snapshot');
    if (row.seekCount) flags.push('seek');
    if (row.videoBoundaryCount) flags.push('boundary');
    if (row.suspendedAudioSec > 5) flags.push('suspended-audio');
    if (row.completedRangeCount) flags.push(`ranges:${formatCounts(row.completedRangeReasons) || row.completedRangeCount}`);
    if (row.musicOnlyLowVocalRatio >= 0.45 || row.firstWindowMusicOnlyLowVocalRatio >= 0.55) flags.push('music-only');
    if (row.segmentFilterCounts.drop) flags.push('filter-drop');
    if (row.segmentFilterCounts['keep-live-protected']) flags.push('filter-protected');
    console.log(
      `[live-diagnostics] ${row.videoId} `
      + `segments=${row.finalSegmentCount} frames=${row.frameCount} `
      + `model=${row.modelHighRatio ?? '-'} sing=${row.singingHighRatio ?? '-'} musicOnly=${row.musicOnlyLowVocalRatio ?? '-'} `
      + `snap(real/est/fail)=${row.snapshotRealCount}/${row.snapshotEstimatedCount}/${row.snapshotFailureCount} `
      + `seek=${row.seekCount} boundary=${row.videoBoundaryCount} suspended=${roundNumber(row.suspendedAudioSec, 3)}s `
      + `ranges=${row.completedRangeCount} `
      + `flags=${flags.join('|') || '-'}`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const input = args.input || args.i;
  if (!input || input === true) {
    throw new Error('Usage: node tools/live/summarize_live_diagnostics.mjs --input <playlist-export.json> [--video-id id1,id2] [--out summary.json] [--csv summary.csv]');
  }
  const inputPath = resolve(String(input));
  const store = JSON.parse(await readFile(inputPath, 'utf8'));
  const videoFilter = parseVideoFilter(args['video-id'] || args.videoId);
  const rows = Object.keys(store)
    .filter((key) => key.startsWith('playlist_meta_'))
    .map((key) => {
      const videoId = key.slice('playlist_meta_'.length);
      return {
        videoId,
        meta: store[key] || {},
        items: store[playlistKey(videoId)] || [],
      };
    })
    .filter(({ videoId }) => !videoFilter || videoFilter.has(videoId))
    .map(({ videoId, meta, items }) => summarizeMeta(videoId, meta, items))
    .sort((a, b) => String(b.lastAnalyzedAt || '').localeCompare(String(a.lastAnalyzedAt || '')));

  printSummary(rows);

  const outPath = args.out ? resolve(String(args.out)) : null;
  if (outPath) {
    await writeFile(outPath, JSON.stringify({ inputPath, rows }, null, 2), 'utf8');
    console.log(`[live-diagnostics] wrote ${outPath}`);
  }
  const csvPath = args.csv ? resolve(String(args.csv)) : null;
  if (csvPath) {
    await writeFile(csvPath, buildCsv(rows), 'utf8');
    console.log(`[live-diagnostics] wrote ${csvPath}`);
  }
}

main().catch((error) => {
  console.error(`[live-diagnostics] failed: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});

