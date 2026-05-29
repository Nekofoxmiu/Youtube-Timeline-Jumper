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

function safeGet(object, path, fallback = null) {
  let current = object;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) return fallback;
    current = current[key];
  }
  return current ?? fallback;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function normalizeRowFromLiveSummary(row) {
  return {
    videoId: row.videoId || null,
    hasLiveDiagnostics: Boolean(row.hasLiveDiagnostics),
    finalSegmentCount: finite(row.finalSegmentCount, 0),
    frameCount: finite(row.frameCount, 0),
    modelHighRatio: finite(row.modelHighRatio, null),
    singingHighRatio: finite(row.singingHighRatio, null),
    musicOnlyLowVocalRatio: finite(row.musicOnlyLowVocalRatio, null),
    firstWindowMusicOnlyLowVocalRatio: finite(row.firstWindowMusicOnlyLowVocalRatio, null),
    snapshotRealCount: finite(row.snapshotRealCount, 0),
    snapshotEstimatedCount: finite(row.snapshotEstimatedCount, 0),
    snapshotFailureCount: finite(row.snapshotFailureCount, 0),
    snapshotUnavailableCount: finite(row.snapshotUnavailableCount, 0),
    seekCount: finite(row.seekCount, 0),
    videoBoundaryCount: finite(row.videoBoundaryCount, 0),
    suspendedAudioSec: finite(row.suspendedAudioSec, 0),
    completedRangeCount: finite(row.completedRangeCount, 0),
    completedRangeReasons: row.completedRangeReasons || {},
    discontinuities: finite(row.discontinuities, 0),
    segmentFilterCounts: row.segmentFilterCounts || {},
    playbackCounts: row.playbackCounts || {},
    suspensionReasons: row.suspensionReasons || {},
  };
}

function summarizePlaylistItems(items) {
  const source = Array.isArray(items) ? items : [];
  const auto = source.filter((item) => item?.type === 'auto-song');
  return {
    autoSongCount: auto.length,
    finalAutoSongCount: auto.filter((item) => !item.provisional).length,
  };
}

function normalizeRowFromRawExport(store, videoId) {
  const meta = store[`playlist_meta_${videoId}`] || {};
  const items = store[`playlist_${videoId}`] || [];
  const playlist = summarizePlaylistItems(items);
  const analysis = meta.analysisCacheSummary || {};
  const diagnostics = analysis.liveFinalizationDiagnostics || {};
  const frameAll = analysis?.frameDistribution?.all || {};
  const frameFirst = analysis?.frameDistribution?.firstWindow || {};
  const playback = diagnostics.playbackDiagnostics || {};
  const snapshot = playback.snapshot || {};
  const completedRanges = analysis.completedRangesSummary || diagnostics.completedAnalysisRanges || {};
  return {
    videoId,
    hasLiveDiagnostics: Boolean(analysis.liveFinalizationDiagnostics),
    finalSegmentCount: finite(diagnostics.finalSegmentCount, playlist.finalAutoSongCount),
    frameCount: finite(analysis.frameCount, 0),
    modelHighRatio: finite(frameAll.modelHighRatio, null),
    singingHighRatio: finite(frameAll.singingHighRatio, null),
    musicOnlyLowVocalRatio: finite(frameAll.musicOnlyLowVocalRatio, null),
    firstWindowMusicOnlyLowVocalRatio: finite(frameFirst.musicOnlyLowVocalRatio, null),
    snapshotRealCount: finite(snapshot.realCount, 0),
    snapshotEstimatedCount: finite(snapshot.estimatedCount, 0),
    snapshotFailureCount: finite(snapshot.failureCount, 0),
    snapshotUnavailableCount: finite(snapshot.unavailableCount, 0),
    seekCount: finite(playback.seekCount, 0),
    videoBoundaryCount: finite(playback.videoBoundaryCount, 0),
    suspendedAudioSec: finite(diagnostics?.captureSuspensionStats?.skippedAudioSec, 0),
    completedRangeCount: finite(completedRanges.count ?? analysis.completedRangeCount, 0),
    completedRangeReasons: completedRanges.reasons || {},
    discontinuities: finite(analysis.discontinuities, 0),
    segmentFilterCounts: diagnostics?.segmentFilter?.adjustmentSummary?.counts || {},
    playbackCounts: playback.counts || {},
    suspensionReasons: playback.suspensionReasons || diagnostics?.captureSuspensionStats?.reasons || {},
  };
}

async function loadLiveRow(path, videoId) {
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (Array.isArray(data.rows)) {
    const row = data.rows.find((item) => item.videoId === videoId) || data.rows[0] || null;
    return row ? normalizeRowFromLiveSummary(row) : null;
  }
  if (data.rows && typeof data.rows === 'object') {
    const rows = Object.values(data.rows);
    const row = rows.find((item) => item.videoId === videoId) || rows[0] || null;
    return row ? normalizeRowFromLiveSummary(row) : null;
  }
  const resolvedVideoId = videoId || Object.keys(data)
    .filter((key) => key.startsWith('playlist_meta_'))
    .map((key) => key.slice('playlist_meta_'.length))[0];
  return resolvedVideoId ? normalizeRowFromRawExport(data, resolvedVideoId) : null;
}

function normalizePcmSummary(summary) {
  const frameAll = summary?.frameDistribution?.all || {};
  const frameFirst = summary?.frameDistribution?.firstWindow || {};
  return {
    audio: summary?.audio || null,
    finalSegmentCount: finite(summary?.finalSegmentCount, Array.isArray(summary?.finalSegments) ? summary.finalSegments.length : 0),
    frameCount: finite(summary?.frameCount, 0),
    analyzedEndSec: finite(summary?.analyzedEndSec, null),
    modelHighRatio: finite(frameAll.modelHighRatio, null),
    singingHighRatio: finite(frameAll.singingHighRatio, null),
    musicOnlyLowVocalRatio: finite(frameAll.musicOnlyLowVocalRatio, null),
    firstWindowMusicOnlyLowVocalRatio: finite(frameFirst.musicOnlyLowVocalRatio, null),
    liveAnalysisMethod: safeGet(summary, ['params', 'liveAnalysisMethod'], null),
    insertedStallSec: safeGet(summary, ['params', 'insertedStallSec'], 0),
    gatedStallSec: safeGet(summary, ['params', 'gatedStallSec'], 0),
    ungatedSilenceSec: safeGet(summary, ['params', 'ungatedSilenceSec'], 0),
    snapshotUnavailableSec: safeGet(summary, ['params', 'snapshotUnavailableSec'], 0),
    snapshotUnavailableSkippedSec: safeGet(summary, ['params', 'snapshotUnavailableSkippedSec'], 0),
    completedRangeCount: Array.isArray(summary?.completedAnalysisRanges) ? summary.completedAnalysisRanges.length : 0,
    completedRangeReasons: (Array.isArray(summary?.completedAnalysisRanges) ? summary.completedAnalysisRanges : [])
      .reduce((acc, range) => {
        const reason = String(range?.reason || 'unknown');
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),
    metrics: summary?.metrics || null,
  };
}

function diffNullable(left, right) {
  if (left === null || right === null || left === undefined || right === undefined) return null;
  return roundNumber(Number(left) - Number(right), 4);
}

function buildFindings(live, pcm) {
  const findings = [];
  if (!live?.hasLiveDiagnostics) {
    findings.push({
      severity: 'info',
      code: 'missing-live-diagnostics',
      message: 'Live export does not contain liveFinalizationDiagnostics; re-run Live detection with the new build before drawing conclusions.',
    });
  }
  if (live.snapshotFailureCount || live.snapshotUnavailableCount) {
    findings.push({
      severity: 'warning',
      code: 'snapshot-instability',
      message: `Playback snapshot had failures/unavailable counts: failure=${live.snapshotFailureCount}, unavailable=${live.snapshotUnavailableCount}.`,
    });
  }
  if (live.snapshotEstimatedCount > live.snapshotRealCount) {
    findings.push({
      severity: 'warning',
      code: 'mostly-estimated-clock',
      message: `Estimated snapshots exceed real snapshots: estimated=${live.snapshotEstimatedCount}, real=${live.snapshotRealCount}.`,
    });
  }
  if (live.seekCount || live.videoBoundaryCount) {
    findings.push({
      severity: 'warning',
      code: 'timeline-discontinuity',
      message: `Live had seek/video boundary events: seek=${live.seekCount}, boundary=${live.videoBoundaryCount}.`,
    });
  }
  if (live.completedRangeCount || live.discontinuities) {
    findings.push({
      severity: 'info',
      code: 'completed-ranges',
      message: `Live finalized ${live.completedRangeCount} completed ranges; reasons=${JSON.stringify(live.completedRangeReasons || {})}.`,
    });
  }
  if (live.suspendedAudioSec > 5) {
    findings.push({
      severity: 'info',
      code: 'capture-gated',
      message: `Capture skipped ${roundNumber(live.suspendedAudioSec, 3)}s due to playback gating.`,
    });
  }
  const segmentDelta = diffNullable(live.finalSegmentCount, pcm.finalSegmentCount);
  if (segmentDelta !== null && Math.abs(segmentDelta) >= 2) {
    findings.push({
      severity: 'warning',
      code: 'segment-count-divergence',
      message: `Live and PCM segment counts differ by ${segmentDelta}.`,
    });
  }
  const musicOnlyDelta = diffNullable(live.musicOnlyLowVocalRatio, pcm.musicOnlyLowVocalRatio);
  if (musicOnlyDelta !== null && musicOnlyDelta > 0.15) {
    findings.push({
      severity: 'warning',
      code: 'live-more-music-only',
      message: `Live music-only low-vocal ratio is higher than PCM by ${musicOnlyDelta}.`,
    });
  }
  return findings;
}

function buildComparison(live, pcm) {
  return {
    videoId: live?.videoId || null,
    live,
    pcm,
    deltas: {
      finalSegmentCount: diffNullable(live?.finalSegmentCount, pcm?.finalSegmentCount),
      frameCount: diffNullable(live?.frameCount, pcm?.frameCount),
      modelHighRatio: diffNullable(live?.modelHighRatio, pcm?.modelHighRatio),
      singingHighRatio: diffNullable(live?.singingHighRatio, pcm?.singingHighRatio),
      musicOnlyLowVocalRatio: diffNullable(live?.musicOnlyLowVocalRatio, pcm?.musicOnlyLowVocalRatio),
      firstWindowMusicOnlyLowVocalRatio: diffNullable(live?.firstWindowMusicOnlyLowVocalRatio, pcm?.firstWindowMusicOnlyLowVocalRatio),
      completedRangeCount: diffNullable(live?.completedRangeCount, pcm?.completedRangeCount),
    },
    findings: buildFindings(live, pcm),
  };
}

function printComparison(comparison) {
  console.log(`[live-vs-pcm] video=${comparison.videoId || '-'}`);
  console.log(
    `[live-vs-pcm] segments live=${comparison.live?.finalSegmentCount ?? '-'} pcm=${comparison.pcm?.finalSegmentCount ?? '-'} `
    + `delta=${comparison.deltas.finalSegmentCount ?? '-'}`
  );
  console.log(
    `[live-vs-pcm] musicOnly live=${comparison.live?.musicOnlyLowVocalRatio ?? '-'} pcm=${comparison.pcm?.musicOnlyLowVocalRatio ?? '-'} `
    + `delta=${comparison.deltas.musicOnlyLowVocalRatio ?? '-'}`
  );
  console.log(
    `[live-vs-pcm] snapshots real/est/fail=${comparison.live?.snapshotRealCount ?? 0}/${comparison.live?.snapshotEstimatedCount ?? 0}/${comparison.live?.snapshotFailureCount ?? 0} `
    + `seek=${comparison.live?.seekCount ?? 0} boundary=${comparison.live?.videoBoundaryCount ?? 0} suspended=${comparison.live?.suspendedAudioSec ?? 0}s`
  );
  console.log(
    `[live-vs-pcm] ranges live=${comparison.live?.completedRangeCount ?? 0} pcm=${comparison.pcm?.completedRangeCount ?? 0} `
    + `reasons=${JSON.stringify(comparison.live?.completedRangeReasons || {})}`
  );
  for (const finding of comparison.findings) {
    console.log(`[live-vs-pcm] ${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`);
  }
}

function buildCsv(comparison) {
  const header = [
    'videoId',
    'liveSegments',
    'pcmSegments',
    'segmentDelta',
    'liveFrameCount',
    'pcmFrameCount',
    'liveMusicOnlyRatio',
    'pcmMusicOnlyRatio',
    'musicOnlyDelta',
    'snapshotReal',
    'snapshotEstimated',
    'snapshotFailure',
    'seekCount',
    'videoBoundaryCount',
    'suspendedAudioSec',
    'liveCompletedRangeCount',
    'pcmCompletedRangeCount',
    'completedRangeDelta',
    'liveCompletedRangeReasons',
    'pcmCompletedRangeReasons',
    'findingCodes',
  ];
  const row = [
    comparison.videoId,
    comparison.live?.finalSegmentCount,
    comparison.pcm?.finalSegmentCount,
    comparison.deltas.finalSegmentCount,
    comparison.live?.frameCount,
    comparison.pcm?.frameCount,
    comparison.live?.musicOnlyLowVocalRatio,
    comparison.pcm?.musicOnlyLowVocalRatio,
    comparison.deltas.musicOnlyLowVocalRatio,
    comparison.live?.snapshotRealCount,
    comparison.live?.snapshotEstimatedCount,
    comparison.live?.snapshotFailureCount,
    comparison.live?.seekCount,
    comparison.live?.videoBoundaryCount,
    comparison.live?.suspendedAudioSec,
    comparison.live?.completedRangeCount,
    comparison.pcm?.completedRangeCount,
    comparison.deltas.completedRangeCount,
    JSON.stringify(comparison.live?.completedRangeReasons || {}),
    JSON.stringify(comparison.pcm?.completedRangeReasons || {}),
    comparison.findings.map((finding) => finding.code).join(';'),
  ];
  return `${header.join(',')}\n${row.map(csvEscape).join(',')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const livePath = args.live || args.input;
  const pcmPath = args.pcm;
  if (!livePath || !pcmPath || livePath === true || pcmPath === true) {
    throw new Error('Usage: node tools/live/compare_live_pcm_diagnostics.mjs --live <playlist-export-or-diagnostics.json> --pcm <simulate_live_pcm_summary.json> [--video-id id] [--out compare.json] [--csv compare.csv]');
  }
  const videoId = args['video-id'] || args.videoId || null;
  const live = await loadLiveRow(resolve(String(livePath)), videoId ? String(videoId) : null);
  const pcm = normalizePcmSummary(JSON.parse(await readFile(resolve(String(pcmPath)), 'utf8')));
  if (!live) throw new Error('No live diagnostics row found.');
  const comparison = buildComparison(live, pcm);
  printComparison(comparison);

  if (args.out) {
    const outPath = resolve(String(args.out));
    await writeFile(outPath, JSON.stringify(comparison, null, 2), 'utf8');
    console.log(`[live-vs-pcm] wrote ${outPath}`);
  }
  if (args.csv) {
    const csvPath = resolve(String(args.csv));
    await writeFile(csvPath, buildCsv(comparison), 'utf8');
    console.log(`[live-vs-pcm] wrote ${csvPath}`);
  }
}

main().catch((error) => {
  console.error(`[live-vs-pcm] failed: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});

