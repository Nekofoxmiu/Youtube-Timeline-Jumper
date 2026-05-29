import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ANALYSIS_FRAME_HOP_SEC, ANALYSIS_FRAME_VERSION } from '../lib/songDetection/analysisFrame.js';
import {
  DEFAULT_SMOOTHING_PROFILE,
  GLOBAL_SMOOTHING_HOP_SEC,
  SMOOTHING_PROFILES,
  getSmoothingProfileAuditSnapshot,
  resolveSmoothingProfile,
} from '../lib/songDetection/globalSmoothing.js';
import { segmentFilterAssetNames } from '../lib/songDetection/segmentFilter.js';
import {
  DEFAULT_STREAMING_CHUNK_SEC,
  DEFAULT_STREAMING_OVERLAP_SEC,
  STREAMING_TARGET_SAMPLE_RATE,
} from '../lib/songDetection/streamingFrameBuilder.js';

const REQUIRED_PROFILES = ['offline-final', 'live-pcm30', 'live-realtime-aed60'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function validateProfileAssets(repoRoot) {
  const modelDir = resolve(repoRoot, 'models/fireredvad/aed');
  const results = [];
  for (const profile of REQUIRED_PROFILES) {
    const names = segmentFilterAssetNames(profile);
    const files = [
      names.segmentFilterModel,
      names.segmentFilterMeta,
      names.edgeTrimAdvisorModel,
      names.edgeTrimAdvisorMeta,
    ];
    for (const name of files) {
      const path = resolve(modelDir, name);
      assert(existsSync(path), `Missing profile asset: ${path}`);
    }
    const segmentMeta = await readJson(resolve(modelDir, names.segmentFilterMeta));
    const edgeMeta = await readJson(resolve(modelDir, names.edgeTrimAdvisorMeta));
    assert(segmentMeta.assetProfile === profile, `${names.segmentFilterMeta} assetProfile mismatch`);
    assert(edgeMeta.assetProfile === profile, `${names.edgeTrimAdvisorMeta} assetProfile mismatch`);
    assert(segmentMeta.trainingProfile === profile, `${names.segmentFilterMeta} trainingProfile mismatch`);
    assert(edgeMeta.trainingProfile === profile, `${names.edgeTrimAdvisorMeta} trainingProfile mismatch`);
    results.push({
      profile,
      segmentFilter: names.segmentFilterModel,
      edgeTrimAdvisor: names.edgeTrimAdvisorModel,
    });
  }
  return results;
}

async function validateSamplePools(repoRoot) {
  const liveSampleDir = resolve(repoRoot, 'tools/samples/live');
  const fullRegression = await readJson(resolve(liveSampleDir, 'live_pcm_full_regression_samples.example.json'));
  const noSong = await readJson(resolve(liveSampleDir, 'live_pcm_no_song_samples.example.json'));
  const stop = await readJson(resolve(liveSampleDir, 'live_pcm_stop_checkpoint_samples.example.json'));
  const snapshot = await readJson(resolve(liveSampleDir, 'live_pcm_snapshot_unavailable_samples.example.json'));
  assert(Array.isArray(fullRegression) && fullRegression.length >= 21, 'Full live PCM regression pool must have at least 21 samples.');
  assert(!fullRegression.some((item) => String(item?.id || '').includes('052')), 'video_052 must stay excluded until audio exists.');
  assert(Array.isArray(noSong) && noSong.length >= 3, 'No-song sample pool must have at least 3 samples.');
  assert(Array.isArray(stop) && stop.length >= 3, 'Stop-checkpoint sample pool must have at least 3 samples.');
  assert(Array.isArray(snapshot) && snapshot.length >= 3, 'Snapshot-unavailable sample pool must have at least 3 samples.');
  return {
    fullRegressionCount: fullRegression.length,
    noSongCount: noSong.length,
    stopCheckpointCount: stop.length,
    snapshotUnavailableCount: snapshot.length,
  };
}

async function validateWorkbenchOfflineContract(repoRoot) {
  const workbenchSource = await readFile(resolve(repoRoot, 'workbench.js'), 'utf8');
  assert(
    workbenchSource.includes('async function renderChunkedOfflineJobVisuals'),
    'Workbench must render long-audio visuals through a separate chunked visual path.'
  );
  assert(
    /generateVisuals:\s*false,\s*analysisOnly:\s*true,/u.test(workbenchSource),
    'Long-audio AED chunk analysis must not render waveform/spectrogram in the analysis worker.'
  );
  assert(
    /job\.visualsStatus\s*=\s*jobConfig\.generateVisuals\s*\?\s*'idle'\s*:\s*'skipped'/u.test(workbenchSource),
    'Long-audio visuals must stay idle until AED analysis finishes.'
  );
  return {
    longAudioAnalysisOnlyVisualsDisabled: true,
    chunkedVisualRenderer: true,
  };
}

async function validateLiveRuntimeContract(repoRoot) {
  const offscreenSource = await readFile(resolve(repoRoot, 'offscreen.js'), 'utf8');
  assert(
    /const DEFAULT_LIVE_ANALYSIS_METHOD = LIVE_ANALYSIS_METHODS\.AED_CACHE_60S;/u.test(offscreenSource),
    'Default live analysis method must remain aed-cache-60s.'
  );
  assert(/const LIVE_AED_CACHE_SEC = 60;/u.test(offscreenSource), 'AED60 chunk size must remain 60s.');
  assert(/const LIVE_AED_CACHE_OVERLAP_SEC = 60;/u.test(offscreenSource), 'AED60 overlap must remain 60s.');
  assert(/const LIVE_PCM_ROLLOVER_SEC = 30 \* 60;/u.test(offscreenSource), 'PCM rollover chunk size must remain 30min.');
  assert(/const LIVE_PCM_OVERLAP_SEC = 120;/u.test(offscreenSource), 'PCM rollover overlap must remain 120s.');
  assert(/const LIVE_EDGE_TRIM_DURING_STREAM = false;/u.test(offscreenSource), 'Live edge trim must stay disabled during provisional streaming.');
  assert(/const LIVE_START_EDGE_TRIM_ENABLED = false;/u.test(offscreenSource), 'Live start edge trim must stay disabled unless explicitly re-gated.');
  assert(
    /return normalizeLiveAnalysisMethod\(method\) === LIVE_ANALYSIS_METHODS\.PCM_ROLLOVER_30MIN[\s\S]*\? 'live-pcm30'[\s\S]*: 'live-realtime-aed60';/u.test(offscreenSource),
    'Live analysis methods must map to distinct segment-filter profiles.'
  );
  assert(
    /smoothingProfile:\s*segmentFilterProfileForLiveAnalysisMethod\(session\.liveAnalysisMethod\)/u.test(offscreenSource),
    'Live smoothing must resolve profile from liveAnalysisMethod.'
  );
  assert(
    /provisionalSegments\.push\(\{ \.\.\.segment, provisional: true \}\);/u.test(offscreenSource)
      && /finalizeNewLiveSegments\(\s*session,\s*finalSegments,/u.test(offscreenSource),
    'Live provisional segments must stay separate from segment-filter finalization.'
  );
  assert(
    /const videoBoundary = await detectVideoBoundary\(session, playbackSnapshot\);[\s\S]*?if \(videoBoundary\) \{[\s\S]*?await stopSession\(tabId,[\s\S]*?stopReason: videoBoundary\.reason,/u.test(offscreenSource),
    'videoId boundary must hard-stop the active live session.'
  );
  assert(
    /integerStartPending: true/u.test(offscreenSource)
      && /function computeNextIntegerSecond/u.test(offscreenSource)
      && /function openAnalysisGate/u.test(offscreenSource),
    'Live analysis must keep integer-second start alignment gate.'
  );
  return {
    defaultLiveAnalysisMethod: 'aed-cache-60s',
    aedCacheSec: 60,
    aedCacheOverlapSec: 60,
    pcmRolloverSec: 1800,
    pcmOverlapSec: 120,
    provisionalFilterDisabled: true,
    videoBoundaryHardStop: true,
    integerStartGate: true,
  };
}

async function validateStreamingFrameContract(repoRoot) {
  const streamingSource = await readFile(resolve(repoRoot, 'lib/songDetection/streamingFrameBuilder.js'), 'utf8');
  const detectorSource = await readFile(resolve(repoRoot, 'lib/songDetection/fireredAedDetector.js'), 'utf8');
  assert(STREAMING_TARGET_SAMPLE_RATE === 16000, 'Streaming target sample rate must remain 16kHz mono.');
  assert(DEFAULT_STREAMING_CHUNK_SEC === 1800, 'Default streaming chunk must remain 30min.');
  assert(DEFAULT_STREAMING_OVERLAP_SEC === 120, 'Default streaming overlap must remain 120s.');
  assert(
    /this\.pcm\.dropBefore\(Math\.max\(0, this\.nextFlushEndIndex - this\.overlapSamples\)\)/u.test(streamingSource),
    'StreamingFrameBuilder must release PCM after rollover while retaining overlap.'
  );
  assert(
    /sourceRangeId:\s*`\$\{boundedStart\}:\$\{boundedEnd\}`/u.test(streamingSource),
    'StreamingFrameBuilder frames must carry a sourceRangeId.'
  );
  assert(
    /lastEmittedFrameTimeSec/u.test(streamingSource),
    'StreamingFrameBuilder must dedupe overlapped frame emissions.'
  );
  assert(
    /sourceMode:\s*this\.liveAnalysisMethod === 'pcm-rollover-30min' \? 'live-pcm30' : 'live-realtime-aed60'/u.test(detectorSource),
    'Live FireRed frames must carry profile-specific sourceMode.'
  );
  assert(
    /internalChunkSec:\s*60/u.test(detectorSource),
    'Live FireRed AED must process rollover buffers with bounded internal AED chunks.'
  );
  return {
    targetSampleRate: STREAMING_TARGET_SAMPLE_RATE,
    defaultChunkSec: DEFAULT_STREAMING_CHUNK_SEC,
    defaultOverlapSec: DEFAULT_STREAMING_OVERLAP_SEC,
    overlapDeduped: true,
    sourceRangeId: true,
  };
}

function validateSmoothingProfiles() {
  assert(DEFAULT_SMOOTHING_PROFILE === 'offline-final', 'Default smoothing profile must remain offline-final.');
  assert(ANALYSIS_FRAME_HOP_SEC === 0.5, 'AnalysisFrame hop must remain 0.5s.');
  assert(GLOBAL_SMOOTHING_HOP_SEC === 0.5, 'Global smoothing hop must remain 0.5s.');
  for (const profile of REQUIRED_PROFILES) {
    assert(SMOOTHING_PROFILES[profile], `Missing smoothing profile: ${profile}`);
    assert(resolveSmoothingProfile(profile) === profile, `Cannot resolve smoothing profile: ${profile}`);
    assert(SMOOTHING_PROFILES[profile] !== SMOOTHING_PROFILES['offline-final'] || profile === 'offline-final', `${profile} reuses offline-final object`);
  }
  assert(resolveSmoothingProfile('pcm-rollover-30min') === 'live-pcm30', 'PCM30 method must resolve to live-pcm30.');
  assert(resolveSmoothingProfile('aed-cache-60s') === 'live-realtime-aed60', 'AED60 method must resolve to live-realtime-aed60.');
  return getSmoothingProfileAuditSnapshot();
}

async function main() {
  const repoRoot = resolve('.');
  const summary = {
    analysisFrameVersion: ANALYSIS_FRAME_VERSION,
    analysisFrameHopSec: ANALYSIS_FRAME_HOP_SEC,
    globalSmoothingHopSec: GLOBAL_SMOOTHING_HOP_SEC,
    smoothingProfiles: validateSmoothingProfiles(),
    profileAssets: await validateProfileAssets(repoRoot),
    samplePools: await validateSamplePools(repoRoot),
    workbenchOffline: await validateWorkbenchOfflineContract(repoRoot),
    liveRuntime: await validateLiveRuntimeContract(repoRoot),
    streamingFrames: await validateStreamingFrameContract(repoRoot),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`[audit-detection-pipelines] failed: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});
