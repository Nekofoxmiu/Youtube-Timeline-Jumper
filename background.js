import {
  PLAYLIST_SCHEMA_VERSION,
  buildPlaylistMeta,
  normalizePlaylistItem,
  normalizePlaylist,
  serializePlaylistItem,
  serializePlaylist,
} from './lib/playlistCore.js';

// 清單(manifest)版本
const CURRENT_VERSION = chrome.runtime.getManifest().version;
const POPUP_FEATURE_NOTICE_CONTEXT_KEY = 'popupFeatureNoticeContext';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const AUTO_SONG_TYPE = 'auto-song';
const DETECTION_CONFIG_KEY = 'songDetectionConfig';
const DEFAULT_MIN_SEGMENT_DURATION_SEC = 90;
const DETECTOR_MODES = {
  FIRERED_AED: 'firered-aed',
  HEURISTIC: 'heuristic',
};
const DEFAULT_DETECTOR_MODE = DETECTOR_MODES.FIRERED_AED;
const DETECTOR_VERSION_BY_MODE = {
  [DETECTOR_MODES.FIRERED_AED]: 'firered-aed-onnx-v1',
  [DETECTOR_MODES.HEURISTIC]: 'heuristic-v1',
};
const DEFAULT_DETECTOR_VERSION = DETECTOR_VERSION_BY_MODE[DEFAULT_DETECTOR_MODE];

const detectionSessions = new Map();
let creatingOffscreenDocumentPromise = null;
let pendingAuthorizationRequest = null;

function normalizeMinSegmentDurationSec(value, fallback = DEFAULT_MIN_SEGMENT_DURATION_SEC) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(15, Math.min(600, Math.round(num)));
}

// 遷移腳本(migration)表：依目標版執行對應遷移
const MIGRATIONS = [
  {
    to: '2.0.0',
    run: async () => {
      // 將舊版播放清單鍵（陣列值）搬移到 playlist_ 前綴，並整理 meta
      const allData = await chrome.storage.local.get(null);
      const keepPrefixes = ['currentPlayId_', 'isPlaying_', 'playlist_', 'playlist_meta_'];
      const keepSet = new Set(['extensionWorkOrNot', 'version']);
      const migrated = {};
      const removeKeys = [];

      for (const [key, value] of Object.entries(allData)) {
        if (keepSet.has(key) || keepPrefixes.some(p => key.startsWith(p))) continue;
        if (Array.isArray(value)) {
          // strip legacy per-item meta and consolidate
          const items = [];
          const metaCandidates = [];
          for (const it of value) {
            if (it && typeof it === 'object') {
              const { lastModified, uploadTime, ...rest } = it;
              if (lastModified || uploadTime) {
                metaCandidates.push({ lastModified, uploadTime });
              }
              items.push(rest);
            } else {
              items.push(it);
            }
          }
          migrated[`playlist_${key}`] = items;

          if (metaCandidates.length) {
            const now = new Date().toISOString();
            const lmList = metaCandidates.map(m => m.lastModified).filter(Boolean).sort();
            const utList = metaCandidates.map(m => m.uploadTime).filter(Boolean).sort();
            migrated[`playlist_meta_${key}`] = {
              lastModified: lmList.length ? lmList.slice(-1)[0] : now,
              uploadTime: utList.length ? utList[0] : now,
            };
          }
          removeKeys.push(key);
        }
      }

      if (Object.keys(migrated).length) {
        await chrome.storage.local.set(migrated);
      }
      if (removeKeys.length) {
        await chrome.storage.local.remove(removeKeys);
      }
    }
  },
];

// ── SemVer 比較：回傳 -1/0/1
function cmpSemver(a, b) {
  const pa = String(a).split('.').map(x => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isJsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function roundNumber(value, digits = 3) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function toSeconds(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, num);
}

function normalizeDetectionStatus(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key === 'listening') return 'Listening';
  if (key === 'detecting') return 'Detecting';
  if (key === 'stopped') return 'Stopped';
  if (key === 'error') return 'Error';
  return 'Idle';
}

function normalizeDetectorMode(mode) {
  const key = String(mode || '').trim().toLowerCase();
  if (key === DETECTOR_MODES.HEURISTIC) return DETECTOR_MODES.HEURISTIC;
  if (key === DETECTOR_MODES.FIRERED_AED) return DETECTOR_MODES.FIRERED_AED;
  return DEFAULT_DETECTOR_MODE;
}

function getDefaultDetectorVersion(mode) {
  const normalizedMode = normalizeDetectorMode(mode);
  return DETECTOR_VERSION_BY_MODE[normalizedMode] || DEFAULT_DETECTOR_VERSION;
}

function getOrCreateDetectionSession(tabId) {
  if (!detectionSessions.has(tabId)) {
    detectionSessions.set(tabId, {
      tabId,
      videoId: null,
      status: 'Idle',
      isRunning: false,
      detectorMode: DEFAULT_DETECTOR_MODE,
      detectorVersion: getDefaultDetectorVersion(DEFAULT_DETECTOR_MODE),
      lastSegmentSignature: '',
      error: null,
      warning: null,
      runtimeInfo: null,
      minSegmentDurationSec: DEFAULT_MIN_SEGMENT_DURATION_SEC,
      debugTrace: null,
      updatedAt: null,
    });
  }
  return detectionSessions.get(tabId);
}

function updateDetectionSession(tabId, patch = {}) {
  const session = getOrCreateDetectionSession(tabId);
  Object.assign(session, patch, { updatedAt: new Date().toISOString() });
  return session;
}

function hasRunningDetectionSessions() {
  return Array.from(detectionSessions.values()).some(session => session.isRunning);
}

// 安全傳訊：避免未注入 content.js 或分頁不存在造成噪訊
async function safeSendTabMessage(tabId, message) {
  if (typeof tabId !== 'number') return { ok: false, error: 'Invalid tabId' };
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    return { ok: true, res };
  } catch (e) {
    // 常見於 content script 未注入
    return { ok: false, error: e?.message || String(e) };
  }
}

async function notifySongDetectionStatus(tabId, status, extra = {}) {
  const normalizedStatus = normalizeDetectionStatus(status);
  const existingSession = getOrCreateDetectionSession(tabId);
  const detectorMode = normalizeDetectorMode(extra.detectorMode || existingSession.detectorMode || DEFAULT_DETECTOR_MODE);
  const hasRuntimeInfo = Object.prototype.hasOwnProperty.call(extra, 'runtimeInfo');
  const hasDebugTrace = Object.prototype.hasOwnProperty.call(extra, 'debugTrace');
  const session = updateDetectionSession(tabId, {
    status: normalizedStatus,
    isRunning: normalizedStatus === 'Listening' || normalizedStatus === 'Detecting',
    videoId: extra.videoId ?? existingSession.videoId ?? null,
    detectorMode,
    detectorVersion: extra.detectorVersion || existingSession.detectorVersion || getDefaultDetectorVersion(detectorMode),
    error: extra.error || null,
    warning: extra.warning || existingSession.warning || null,
    runtimeInfo: hasRuntimeInfo ? extra.runtimeInfo : existingSession.runtimeInfo || null,
    debugTrace: hasDebugTrace ? extra.debugTrace : existingSession.debugTrace || null,
    minSegmentDurationSec: normalizeMinSegmentDurationSec(
      extra.minSegmentDurationSec,
      existingSession.minSegmentDurationSec
    ),
  });

  await safeSendTabMessage(tabId, {
    action: 'songDetectionStatusChanged',
    status: session.status,
    videoId: session.videoId,
    isRunning: session.isRunning,
    detectorMode: session.detectorMode,
    detectorVersion: session.detectorVersion,
    error: session.error,
    warning: session.warning,
    runtimeInfo: session.runtimeInfo,
    debugTrace: session.debugTrace,
    minSegmentDurationSec: session.minSegmentDurationSec,
  });

  if (!session.isRunning) {
    await closeOffscreenDocumentIfIdle();
  }
  return session;
}

function normalizeSegment(segment) {
  const startSec = toSeconds(segment?.startSec);
  const endSec = Math.max(startSec, toSeconds(segment?.endSec));
  return {
    startSec: roundNumber(startSec, 3),
    endSec: roundNumber(endSec, 3),
    confidence: roundNumber(clamp(Number(segment?.confidence) || 0, 0, 1), 3),
    provisional: Boolean(segment?.provisional),
  };
}

function timeObjectToSeconds(timeObj) {
  if (!timeObj || typeof timeObj !== 'object') return 0;
  const h = Number(timeObj.hours) || 0;
  const m = Number(timeObj.minutes) || 0;
  const s = Number(timeObj.seconds) || 0;
  return (h * 3600) + (m * 60) + s;
}

function comparePlaylistItems(a, b) {
  const aStart = timeObjectToSeconds(a?.start);
  const bStart = timeObjectToSeconds(b?.start);
  if (aStart !== bStart) return aStart - bStart;

  const aEnd = timeObjectToSeconds(a?.end);
  const bEnd = timeObjectToSeconds(b?.end);
  if (aEnd !== bEnd) return aEnd - bEnd;

  const aTitle = String(a?.title || '');
  const bTitle = String(b?.title || '');
  return aTitle.localeCompare(bTitle);
}

function buildAutoSongItem(segment, detectorVersion, provisional = false, index = 0, source = 'tabCapture') {
  const normalized = normalizeSegment(segment);
  return serializePlaylistItem(normalizePlaylistItem({
    startSec: normalized.startSec,
    endSec: Math.max(normalized.startSec + 1, normalized.endSec),
    title: provisional ? 'Auto Song (Provisional)' : 'Auto Song',
    type: AUTO_SONG_TYPE,
    confidence: normalized.confidence,
    provisional: Boolean(provisional),
    detectorVersion: detectorVersion || DEFAULT_DETECTOR_VERSION,
    source,
  }, index));
}

function buildDetectionSignature(videoId, finalSegments, provisionalSegments, detectorMode, detectorVersion) {
  return JSON.stringify({
    videoId: videoId || null,
    detectorMode: detectorMode || null,
    detectorVersion: detectorVersion || null,
    finalSegments,
    provisionalSegments,
  });
}

async function persistSongSegmentsToStorage(payload) {
  const {
    videoId,
    finalSegments = [],
    provisionalSegments = [],
    detectorVersion = DEFAULT_DETECTOR_VERSION,
    source = 'tabCapture',
    refinedBy = null,
    smoothingMethod = null,
    analysisCacheSummary = null,
  } = payload || {};

  if (!videoId) return { changed: false, reason: 'Missing videoId' };

  const itemsKey = `playlist_${videoId}`;
  const metaKey = `playlist_meta_${videoId}`;
  const store = await chrome.storage.local.get([itemsKey, metaKey]);

  const existingItems = Array.isArray(store[itemsKey]) ? store[itemsKey] : [];
  const existingMeta = store[metaKey] || {};
  const normalizedExisting = normalizePlaylist(existingItems, existingMeta).items;
  const manualItems = serializePlaylist(normalizedExisting.filter(item => item.type !== AUTO_SONG_TYPE));

  const normalizedFinalSegments = (Array.isArray(finalSegments) ? finalSegments : []).map(normalizeSegment);
  const normalizedProvisionalSegments = (Array.isArray(provisionalSegments) ? provisionalSegments : []).map(normalizeSegment);

  const autoFinalItems = normalizedFinalSegments.map((segment, index) => buildAutoSongItem(segment, detectorVersion, false, index, source));
  const autoProvisionalItems = normalizedProvisionalSegments.map((segment, index) => buildAutoSongItem(segment, detectorVersion, true, index, source));
  const combinedItems = [...manualItems, ...autoFinalItems, ...autoProvisionalItems].sort(comparePlaylistItems);

  const nextMetaComparable = {
    detectorVersion: detectorVersion || existingMeta.detectorVersion || DEFAULT_DETECTOR_VERSION,
    source,
    refinedBy: refinedBy || null,
    smoothingMethod: smoothingMethod || null,
    analysisCacheSummary: analysisCacheSummary || null,
    provisionalSegments: normalizedProvisionalSegments,
    finalSegments: normalizedFinalSegments,
  };
  const prevMetaComparable = {
    detectorVersion: existingMeta.detectorVersion || null,
    source: existingMeta.source || null,
    refinedBy: existingMeta.refinedBy || null,
    smoothingMethod: existingMeta.smoothingMethod || null,
    analysisCacheSummary: existingMeta.analysisCacheSummary || null,
    provisionalSegments: Array.isArray(existingMeta.provisionalSegments) ? existingMeta.provisionalSegments : [],
    finalSegments: Array.isArray(existingMeta.finalSegments) ? existingMeta.finalSegments : [],
  };

  const playlistChanged = !isJsonEqual(existingItems, combinedItems);
  const autoMetaChanged = !isJsonEqual(prevMetaComparable, nextMetaComparable);

  if (!playlistChanged && !autoMetaChanged) {
    return { changed: false, playlistChanged: false, metaChanged: false };
  }

  if (combinedItems.length === 0) {
    await chrome.storage.local.remove([itemsKey, metaKey]);
    return { changed: true, playlistChanged, metaChanged: true };
  }

  const now = new Date().toISOString();
  const nextMeta = {
    ...existingMeta,
    uploadTime: existingMeta.uploadTime || now,
    lastModified: now,
    detectorVersion: nextMetaComparable.detectorVersion,
    lastAnalyzedAt: now,
    source: nextMetaComparable.source,
    refinedBy: nextMetaComparable.refinedBy,
    smoothingMethod: nextMetaComparable.smoothingMethod,
    analysisCacheSummary: nextMetaComparable.analysisCacheSummary,
    provisionalSegments: nextMetaComparable.provisionalSegments,
    finalSegments: nextMetaComparable.finalSegments,
  };

  await chrome.storage.local.set({
    [itemsKey]: combinedItems,
    [metaKey]: nextMeta,
  });

  return {
    changed: true,
    playlistChanged,
    metaChanged: true,
    itemCount: combinedItems.length,
  };
}

async function requestCurrentVideoIdFromTab(tabId) {
  const response = await safeSendTabMessage(tabId, { action: 'getCurrentVideoId' });
  if (!response.ok || !response.res) return null;
  return response.res.videoId || null;
}

async function requestCurrentVideoSnapshotFromTab(tabId) {
  const response = await safeSendTabMessage(tabId, { action: 'getCurrentVideoTime' });
  if (!response.ok || !response.res) return null;
  const currentTime = Number(response.res.currentTime);
  if (!Number.isFinite(currentTime)) return null;
  return {
    currentTime: Math.max(0, currentTime),
    videoId: response.res.videoId || null,
  };
}

async function hasOffscreenDocument() {
  if (!chrome.offscreen) return false;
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl],
    });
    return Array.isArray(contexts) && contexts.length > 0;
  }

  if (chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }

  return false;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error('chrome.offscreen API is unavailable in this environment.');
  }

  if (await hasOffscreenDocument()) return;
  if (creatingOffscreenDocumentPromise) {
    await creatingOffscreenDocumentPromise;
    return;
  }

  creatingOffscreenDocumentPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture and analyze tab audio for local song segment detection.',
  });

  try {
    await creatingOffscreenDocumentPromise;
  } finally {
    creatingOffscreenDocumentPromise = null;
  }
}

async function closeOffscreenDocumentIfIdle() {
  if (!chrome.offscreen) return;
  if (hasRunningDetectionSessions()) return;
  if (!await hasOffscreenDocument()) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    console.debug('closeOffscreenDocumentIfIdle failed:', error);
  }
}

async function resolveTargetTabId(sender, request) {
  if (typeof request?.tabId === 'number') return request.tabId;
  if (typeof sender?.tab?.id === 'number') return sender.tab.id;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  return tabs[0].id ?? null;
}

async function getSongDetectionConfig() {
  const stored = await chrome.storage.local.get(DETECTION_CONFIG_KEY);
  const rawConfig = stored[DETECTION_CONFIG_KEY] || {};
  const mode = DEFAULT_DETECTOR_MODE;
  return {
    mode,
    minSegmentDurationSec: normalizeMinSegmentDurationSec(rawConfig.minSegmentDurationSec),
    updatedAt: rawConfig.updatedAt || null,
  };
}

async function updateSongDetectionConfig(patch = {}) {
  const current = await getSongDetectionConfig();
  const mode = DEFAULT_DETECTOR_MODE;
  const nextConfig = {
    ...current,
    mode,
    minSegmentDurationSec: normalizeMinSegmentDurationSec(
      patch.minSegmentDurationSec,
      current.minSegmentDurationSec
    ),
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [DETECTION_CONFIG_KEY]: nextConfig });
  return nextConfig;
}

function isPopupAuthorizationRequiredError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('extension has not been invoked for the current page')
    || message.includes('activeTab permission'.toLowerCase());
}

function summarizeTabForDebug(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: Boolean(tab.active),
    highlighted: Boolean(tab.highlighted),
    status: tab.status || null,
    audible: Boolean(tab.audible),
    muted: Boolean(tab.mutedInfo?.muted),
    url: tab.url || tab.pendingUrl || null,
    title: tab.title || null,
  };
}

function serializeErrorForDebug(error) {
  return {
    name: error?.name || null,
    message: error?.message || String(error || ''),
    stack: error?.stack || null,
  };
}

async function collectTabCaptureDebug(tabId, phase, extra = {}) {
  const debug = {
    phase,
    tabId: typeof tabId === 'number' ? tabId : null,
    timestamp: new Date().toISOString(),
    extra,
  };

  try {
    debug.targetTab = typeof tabId === 'number'
      ? summarizeTabForDebug(await chrome.tabs.get(tabId))
      : null;
  } catch (error) {
    debug.targetTabError = error?.message || String(error);
  }

  try {
    debug.activeCurrentWindowTabs = (await chrome.tabs.query({ active: true, currentWindow: true }))
      .map(summarizeTabForDebug);
  } catch (error) {
    debug.activeCurrentWindowError = error?.message || String(error);
  }

  try {
    debug.activeLastFocusedWindowTabs = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))
      .map(summarizeTabForDebug);
  } catch (error) {
    debug.activeLastFocusedWindowError = error?.message || String(error);
  }

  try {
    debug.capturedTabs = chrome.tabCapture?.getCapturedTabs
      ? await chrome.tabCapture.getCapturedTabs()
      : null;
  } catch (error) {
    debug.capturedTabsError = error?.message || String(error);
  }

  try {
    debug.hasOffscreenDocument = await hasOffscreenDocument();
  } catch (error) {
    debug.hasOffscreenDocumentError = error?.message || String(error);
  }

  return debug;
}

function formatDebugLine(debug) {
  if (!debug) return '';
  const target = debug.targetTab;
  const active = Array.isArray(debug.activeLastFocusedWindowTabs)
    ? debug.activeLastFocusedWindowTabs[0]
    : null;
  const capturedCount = Array.isArray(debug.capturedTabs) ? debug.capturedTabs.length : 'n/a';
  return [
    `phase=${debug.phase}`,
    `target=${target?.id ?? 'n/a'} active=${target?.active ?? 'n/a'} status=${target?.status ?? 'n/a'}`,
    `activeLastFocused=${active?.id ?? 'n/a'}`,
    `capturedTabs=${capturedCount}`,
    `offscreen=${debug.hasOffscreenDocument ?? 'n/a'}`,
    `error=${debug.extra?.error?.message || debug.extra?.retryError?.message || 'n/a'}`,
  ].join(' | ');
}

function clearPendingAuthorizationForTab(tabId) {
  if (!pendingAuthorizationRequest) return;
  if (typeof tabId === 'number' && pendingAuthorizationRequest.tabId !== tabId) return;
  pendingAuthorizationRequest = null;
}

async function openSongDetectionPermissionPopup(tabId, videoId = null, reason = 'authorize-tabCapture') {
  pendingAuthorizationRequest = {
    tabId: typeof tabId === 'number' ? tabId : null,
    videoId: videoId || null,
    reason,
    requestedAt: new Date().toISOString(),
  };

  try {
    await chrome.action.openPopup();
    return { success: true, opened: 'action-popup' };
  } catch (error) {
    const popupUrl = chrome.runtime.getURL('popup.html');
    await chrome.windows.create({
      url: popupUrl,
      type: 'popup',
      width: 460,
      height: 780,
      // Keep YouTube tab focused so tabCapture keeps the invocation context.
      focused: false,
    });
    return { success: true, opened: 'popup-window' };
  }
}

async function startSongDetectionForTab(tabId, videoIdHint = null, detectorModeHint = null) {
  if (typeof tabId !== 'number') {
    throw new Error('Invalid tabId for startSongDetectionForTab');
  }

  const debugTrace = [];
  const existing = detectionSessions.get(tabId);
  if (existing && existing.isRunning) {
    await stopSongDetectionForTab(tabId, { notifyTab: false, removeSession: false });
  }

  const config = await getSongDetectionConfig();
  const detectorMode = DEFAULT_DETECTOR_MODE;
  const minSegmentDurationSec = normalizeMinSegmentDurationSec(config.minSegmentDurationSec);

  try {
    await ensureOffscreenDocument();
  } catch (error) {
    const debug = await collectTabCaptureDebug(tabId, 'ensure-offscreen-failed', {
      error: serializeErrorForDebug(error),
    });
    debugTrace.push(debug);
    console.warn('[song-detection] ensure offscreen failed', debug);
    error.debugTrace = debugTrace;
    throw error;
  }

  let streamId = null;
  try {
    console.info('[song-detection] requesting tab capture stream id', { tabId });
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    const debug = await collectTabCaptureDebug(tabId, 'getMediaStreamId-targetTabId-failed', {
      error: serializeErrorForDebug(error),
    });
    debugTrace.push(debug);
    console.warn('[song-detection] tabCapture.getMediaStreamId failed', debug);
    error.debugTrace = debugTrace;
    throw error;
  }

  if (!streamId) {
    const debug = await collectTabCaptureDebug(tabId, 'getMediaStreamId-empty-stream-id');
    debugTrace.push(debug);
    const error = new Error('Failed to get tab capture stream id.');
    error.debugTrace = debugTrace;
    console.warn('[song-detection] tabCapture returned empty stream id', debug);
    throw error;
  }

  const videoId = videoIdHint || null;

  const response = await chrome.runtime.sendMessage({
    action: 'offscreenStartSongDetection',
    tabId,
    streamId,
    videoId: videoId || null,
    detectorMode,
    minSegmentDurationSec,
    debugTrace,
  });

  if (!response || !response.success) {
    const debug = await collectTabCaptureDebug(tabId, 'offscreenStartSongDetection-failed', {
      response: response || null,
    });
    debugTrace.push(debug);
    const error = new Error(response?.message || 'offscreen start failed.');
    error.debugTrace = debugTrace.concat(Array.isArray(response?.debugTrace) ? response.debugTrace : []);
    console.warn('[song-detection] offscreen start failed', error.debugTrace);
    throw error;
  }

  const resolvedMode = normalizeDetectorMode(response.detectorMode || detectorMode);
  const session = updateDetectionSession(tabId, {
    videoId: videoId || null,
    status: normalizeDetectionStatus(response.status || 'Listening'),
    isRunning: true,
    detectorMode: resolvedMode,
    detectorVersion: response.detectorVersion || getDefaultDetectorVersion(resolvedMode),
    lastSegmentSignature: '',
    error: null,
    warning: response.warning || null,
    runtimeInfo: response.runtimeInfo || null,
    minSegmentDurationSec,
    debugTrace: debugTrace.concat(Array.isArray(response.debugTrace) ? response.debugTrace : []),
  });

  clearPendingAuthorizationForTab(tabId);

  await notifySongDetectionStatus(tabId, session.status, {
    videoId: session.videoId,
    detectorMode: session.detectorMode,
    detectorVersion: session.detectorVersion,
    warning: session.warning,
    runtimeInfo: session.runtimeInfo,
    minSegmentDurationSec: session.minSegmentDurationSec,
  });

  return {
    success: true,
    tabId,
    videoId: session.videoId,
    status: session.status,
    detectorMode: session.detectorMode,
    detectorVersion: session.detectorVersion,
    warning: session.warning,
    runtimeInfo: session.runtimeInfo,
    debugTrace: session.debugTrace,
  };
}

function formatSongDetectionStartError(error) {
  const message = String(error?.message || error || 'Unknown error');
  const lower = message.toLowerCase();

  if (lower.includes('extension has not been invoked for the current page')) {
    return 'Tab capture 權限尚未授權目前分頁。請切換到要偵測的 YouTube 分頁，點擊擴充功能圖示後再按「Start Detect」。';
  }
  if (lower.includes('chrome pages cannot be captured')) {
    return '目前分頁無法被 capture。請切換到 YouTube 網頁分頁後再啟動偵測。';
  }
  if (lower.includes('not allowed')) {
    return 'Chrome 拒絕 tabCapture。請確認你在一般 YouTube 分頁（非 chrome://、擴充功能頁）並重新嘗試。';
  }
  if (lower.includes('error starting tab capture')) {
    return 'Chrome 回報 Error starting tab capture。請依 popup 下方除錯資訊確認失敗階段。';
  }
  return message;
}

async function stopSongDetectionForTab(tabId, options = {}) {
  const { notifyTab = true, removeSession = false } = options;

  if (typeof tabId !== 'number') {
    return { success: false, message: 'Invalid tabId' };
  }

  let offscreenResponse = null;
  try {
    offscreenResponse = await chrome.runtime.sendMessage({
      action: 'offscreenStopSongDetection',
      tabId,
    });
  } catch (error) {
    // ignore; offscreen may already be closed
  }

  updateDetectionSession(tabId, {
    isRunning: false,
    status: 'Stopped',
    error: null,
    warning: null,
    runtimeInfo: null,
    debugTrace: offscreenResponse && offscreenResponse.debugTrace
      ? offscreenResponse.debugTrace
      : getOrCreateDetectionSession(tabId).debugTrace || null,
  });

  if (notifyTab) {
    await notifySongDetectionStatus(tabId, 'Stopped', { runtimeInfo: null });
  }

  if (removeSession) {
    detectionSessions.delete(tabId);
  }

  await closeOffscreenDocumentIfIdle();
  return { success: true, tabId, status: 'Stopped', offscreenResponse };
}

async function handleSongSegmentsUpdated(request) {
  const tabId = Number(request?.tabId);
  if (!Number.isFinite(tabId)) {
    return { success: false, message: 'songSegmentsUpdated requires tabId' };
  }

  const session = getOrCreateDetectionSession(tabId);
  const status = normalizeDetectionStatus(request.status || session.status || 'Listening');
  const videoId = request.videoId || session.videoId || null;
  const detectorMode = normalizeDetectorMode(request.detectorMode || session.detectorMode || DEFAULT_DETECTOR_MODE);
  const detectorVersion = request.detectorVersion || session.detectorVersion || getDefaultDetectorVersion(detectorMode);
  const finalSegments = Array.isArray(request.finalSegments) ? request.finalSegments : [];
  const provisionalSegments = Array.isArray(request.provisionalSegments) ? request.provisionalSegments : [];

  const signature = buildDetectionSignature(
    videoId,
    finalSegments,
    provisionalSegments,
    detectorMode,
    detectorVersion
  );
  const isSameSignature = signature === session.lastSegmentSignature;
  const isSameVideo = (videoId || null) === (session.videoId || null);
  const isSameStatus = status === session.status;
  const isSameMode = detectorMode === session.detectorMode;
  const isSameVersion = detectorVersion === session.detectorVersion;
  const hasRefinementPayload = Boolean(request.refinedBy || request.smoothingMethod || request.analysisCacheSummary);

  updateDetectionSession(tabId, {
    videoId,
    status,
    isRunning: status === 'Listening' || status === 'Detecting',
    detectorMode,
    detectorVersion,
    lastSegmentSignature: signature,
    error: null,
    warning: request.warning || session.warning || null,
    minSegmentDurationSec: normalizeMinSegmentDurationSec(
      request.minSegmentDurationSec,
      session.minSegmentDurationSec
    ),
  });

  let persistResult = { changed: false };
  if (videoId && (!isSameSignature || !isSameVideo || hasRefinementPayload)) {
    persistResult = await persistSongSegmentsToStorage({
      videoId,
      finalSegments,
      provisionalSegments,
      detectorVersion,
      source: request.source || 'tabCapture',
      refinedBy: request.refinedBy || null,
      smoothingMethod: request.smoothingMethod || null,
      analysisCacheSummary: request.analysisCacheSummary || null,
    });
  }

  if (!isSameStatus || !isSameMode || !isSameVersion || persistResult.changed) {
    await notifySongDetectionStatus(tabId, status, {
      videoId,
      detectorMode,
      detectorVersion,
      warning: request.warning || session.warning || null,
    });
  }

  if (videoId && persistResult.changed) {
    await safeSendTabMessage(tabId, {
      action: 'songSegmentsUpdated',
      videoId,
      status,
      detectorMode,
      detectorVersion,
      warning: request.warning || session.warning || null,
    });
  }

  return { success: true, changed: persistResult.changed, status, videoId };
}

// 初始化預設狀態
async function ensureDefaultState() {
  const store = await chrome.storage.local.get(['extensionWorkOrNot', DETECTION_CONFIG_KEY]);
  const { extensionWorkOrNot } = store;
  if (extensionWorkOrNot === undefined) {
    await chrome.storage.local.set({ extensionWorkOrNot: true });
  }

  const currentConfig = store[DETECTION_CONFIG_KEY];
  if (!currentConfig || typeof currentConfig !== 'object') {
    await chrome.storage.local.set({
      [DETECTION_CONFIG_KEY]: {
        mode: DEFAULT_DETECTOR_MODE,
        updatedAt: new Date().toISOString(),
      },
    });
    return;
  }

  const normalizedMode = normalizeDetectorMode(currentConfig.mode);
  if (normalizedMode !== currentConfig.mode) {
    await chrome.storage.local.set({
      [DETECTION_CONFIG_KEY]: {
        ...currentConfig,
        mode: normalizedMode,
        updatedAt: currentConfig.updatedAt || new Date().toISOString(),
      },
    });
  }
}

// 執行遷移
async function runMigrationsIfNeeded() {
  const { version: oldVersion = '1.0.0' } = await chrome.storage.local.get('version');
  if (cmpSemver(oldVersion, CURRENT_VERSION) === 0) return;

  // 依 MIGRATIONS.to 昇冪排序，依序執行需要的遷移
  const sorted = [...MIGRATIONS].sort((a, b) => cmpSemver(a.to, b.to));
  for (const m of sorted) {
    if (cmpSemver(oldVersion, m.to) < 0 && cmpSemver(CURRENT_VERSION, m.to) >= 0) {
      await m.run();
    }
  }
  await chrome.storage.local.set({ version: CURRENT_VERSION });
}

// 嘗試從 watch page 抓取 uploadDate 的輔助函式
async function fetchUploadTimeFromWatchPage(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp || !resp.ok) return null;
    const text = await resp.text();

    const metaMatch = text.match(/<meta[^>]+itemprop=(?:"|')datePublished(?:"|')[^>]*content=(?:"|')([^"']+)(?:"|')/i);
    if (metaMatch && metaMatch[1]) {
      const d = new Date(metaMatch[1]);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }

    const jsonMatch =
      text.match(/"uploadDate"\s*:\s*"([0-9T:\-\.Z ]+)"/i) ||
      text.match(/"datePublished"\s*:\s*"([0-9T:\-\.Z ]+)"/i);
    if (jsonMatch && jsonMatch[1]) {
      const d2 = new Date(jsonMatch[1]);
      if (!Number.isNaN(d2.getTime())) return d2.toISOString();
    }
  } catch (err) {
    console.debug('fetchUploadTimeFromWatchPage failed for', videoId, err);
  }
  return null;
}

// 確保所有播放清單擁有 meta（lastModified / uploadTime）
async function ensureAllPlaylistMeta() {
  const all = await chrome.storage.local.get(null);
  const now = new Date().toISOString();

  const playlists = Object.keys(all)
    .filter(k => k.startsWith('playlist_') && !k.startsWith('playlist_meta_'))
    .map(k => ({ videoId: k.replace('playlist_', ''), items: Array.isArray(all[k]) ? all[k] : [] }));

  for (const p of playlists) {
    const metaKey = `playlist_meta_${p.videoId}`;
    const meta = all[metaKey] || {};
    let { lastModified, uploadTime } = meta;
    let changed = false;

    if (!lastModified) {
      const lmList = p.items.map(it => it && it.lastModified).filter(Boolean).sort();
      lastModified = lmList.length ? lmList.slice(-1)[0] : now;
      changed = true;
    }
    if (!uploadTime) {
      // 1) try asking any open YouTube watch tab
      try {
        const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/watch*' });
        for (const t of tabs) {
          try {
            const resp = await chrome.tabs.sendMessage(t.id, { action: 'getUploadTime', videoId: p.videoId });
            if (resp && resp.uploadTime) {
              uploadTime = resp.uploadTime;
              break;
            }
          } catch (e) {
            // ignore - content script may not exist in tab
          }
        }
      } catch (e) {
        // ignore
      }
      // 2) fallback to fetching watch page directly
      if (!uploadTime) {
        uploadTime = await fetchUploadTimeFromWatchPage(p.videoId);
      }
      if (!uploadTime) uploadTime = now;
      changed = true;
    }

    if (changed) {
      await chrome.storage.local.set({ [metaKey]: { ...meta, lastModified, uploadTime } });
    }
  }
}

async function rebuildLegacyPlaylistDatabase() {
  const all = await chrome.storage.local.get(null);
  const updates = {};
  const removeKeys = [];
  const now = new Date().toISOString();

  for (const key of Object.keys(all)) {
    if (!key.startsWith('playlist_') || key.startsWith('playlist_meta_')) continue;

    const videoId = key.replace('playlist_', '');
    const metaKey = `playlist_meta_${videoId}`;
    const rawItems = all[key];
    const rawMeta = all[metaKey] || {};
    const { items, rebuilt } = normalizePlaylist(rawItems, rawMeta);
    const metaNeedsRebuild = !rawMeta || rawMeta.schemaVersion !== PLAYLIST_SCHEMA_VERSION;

    if (!items.length) {
      removeKeys.push(key, metaKey);
      continue;
    }

    if (rebuilt || metaNeedsRebuild) {
      updates[key] = serializePlaylist(items);
      updates[metaKey] = buildPlaylistMeta(items, rawMeta, { rebuiltAt: now });
    }
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }

  if (removeKeys.length) {
    await chrome.storage.local.remove([...new Set(removeKeys)]);
  }
}

async function checkMetaOnStartup() {
  try {
    await rebuildLegacyPlaylistDatabase();
    await ensureAllPlaylistMeta();
  } catch (err) {
    console.error('ensureAllPlaylistMeta failed:', err);
  }
}

// ── onInstalled：安裝/更新時處理預設值與遷移
chrome.runtime.onInstalled.addListener(async (details = {}) => {
  try {
    await ensureDefaultState();
    await runMigrationsIfNeeded();
    await checkMetaOnStartup();
    await chrome.storage.local.set({
      [POPUP_FEATURE_NOTICE_CONTEXT_KEY]: {
        reason: details.reason || 'unknown',
        previousVersion: details.previousVersion || null,
        currentVersion: CURRENT_VERSION,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('Error during installation/update:', err);
  }
});

// 其他情境下（如瀏覽器啟動）也要檢查 meta
chrome.runtime.onStartup.addListener(() => {
  checkMetaOnStartup();
});

// service worker 啟動時先嘗試檢查一次
checkMetaOnStartup();
ensureDefaultState();

const BACKGROUND_ACTIONS = new Set([
  'getExtensionWorkOrNot',
  'updatePlaylistState',
  'playPlaylist',
  'getTabId',
  'startSongDetectionForActiveTab',
  'stopSongDetectionForActiveTab',
  'prepareSongDetectionOffscreen',
  'getSongDetectionStatus',
  'getSongDetectionConfig',
  'setSongDetectionMode',
  'setSongDetectionConfig',
  'openSongDetectionPermissionPopup',
  'getSongDetectionAuthorizationContext',
  'requestCurrentVideoTime',
  'requestCurrentVideoId',
  'getCurrentVideoId',
  'songSegmentsUpdated',
  'songDetectionStatusChanged',
]);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !BACKGROUND_ACTIONS.has(request.action)) {
    return false;
  }

  (async () => {
    try {
      if (request.action === 'getExtensionWorkOrNot') {
        const { extensionWorkOrNot } = await chrome.storage.local.get('extensionWorkOrNot');
        sendResponse({ state: extensionWorkOrNot });
        return;
      }

      if (request.action === 'updatePlaylistState') {
        // new format: data = { videoId, state, meta }
        const { videoId, state, meta } = request.data || {};
        if (videoId && Array.isArray(state)) {
          const itemsKey = `playlist_${videoId}`;
          const metaKey = `playlist_meta_${videoId}`;
          if (state.length === 0) {
            await chrome.storage.local.remove([itemsKey, metaKey]);
          } else {
            const toSet = { [itemsKey]: state };
            if (meta && typeof meta === 'object') toSet[metaKey] = meta;
            await chrome.storage.local.set(toSet);
          }
          sendResponse({ success: true });
          return;
        }

        if (request.data && typeof request.data === 'object') {
          // Backwards compatibility: older callers may send { videoId: stateArray }
          await chrome.storage.local.set(request.data);
          sendResponse({ success: true });
          return;
        }

        sendResponse({ success: false, message: 'Invalid payload' });
        return;
      }

      if (request.action === 'playPlaylist') {
        const tabId = sender?.tab?.id;
        if (typeof tabId !== 'number') {
          sendResponse({ success: false, message: 'No sender tab.' });
          return;
        }
        chrome.tabs.sendMessage(
          tabId,
          { action: 'playPlaylist', startIndex: request.startIndex, endIndex: request.endIndex, tabId },
          () => sendResponse({ success: true })
        );
        return;
      }

      if (request.action === 'getTabId') {
        sendResponse(sender?.tab?.id ?? null); // 傳回目前的 tabId
        return;
      }

      if (request.action === 'startSongDetectionForActiveTab') {
        const tabId = await resolveTargetTabId(sender, request);
        if (typeof tabId !== 'number') {
          sendResponse({ success: false, message: 'No active tab available for detection.' });
          return;
        }

        try {
          const result = await startSongDetectionForTab(
            tabId,
            request.videoId || null,
            request.detectorMode || null
          );
          sendResponse(result);
        } catch (error) {
          const friendly = formatSongDetectionStartError(error);
          const requiresPopupAuthorization = isPopupAuthorizationRequiredError(error);
          const debugTrace = Array.isArray(error?.debugTrace) ? error.debugTrace : [];
          console.warn('[song-detection] startSongDetectionForActiveTab failed', {
            tabId,
            message: error?.message || String(error),
            friendly,
            debugTrace,
          });
          await notifySongDetectionStatus(tabId, 'Error', { error: friendly, debugTrace });
          sendResponse({
            success: false,
            tabId,
            message: friendly,
            requiresPopupAuthorization,
            debugTrace,
          });
        }
        return;
      }

      if (request.action === 'stopSongDetectionForActiveTab') {
        const tabId = await resolveTargetTabId(sender, request);
        if (typeof tabId !== 'number') {
          sendResponse({ success: false, message: 'No active tab available for stop.' });
          return;
        }
        const result = await stopSongDetectionForTab(tabId, { notifyTab: true, removeSession: false });
        sendResponse(result);
        return;
      }

      if (request.action === 'prepareSongDetectionOffscreen') {
        await ensureOffscreenDocument();
        sendResponse({ success: true });
        return;
      }

      if (request.action === 'getSongDetectionStatus') {
        const tabId = await resolveTargetTabId(sender, request);
        if (typeof tabId !== 'number') {
          sendResponse({
            success: true,
            status: 'Idle',
            isRunning: false,
            videoId: null,
            detectorMode: DEFAULT_DETECTOR_MODE,
            detectorVersion: getDefaultDetectorVersion(DEFAULT_DETECTOR_MODE),
            error: null,
            warning: null,
            runtimeInfo: null,
            debugTrace: null,
          });
          return;
        }
        const session = getOrCreateDetectionSession(tabId);
        sendResponse({
          success: true,
          status: session.status,
          isRunning: session.isRunning,
          videoId: session.videoId,
          detectorMode: session.detectorMode,
          detectorVersion: session.detectorVersion,
          error: session.error,
          warning: session.warning,
          runtimeInfo: session.runtimeInfo,
          debugTrace: session.debugTrace || null,
          minSegmentDurationSec: session.minSegmentDurationSec,
        });
        return;
      }

      if (request.action === 'getSongDetectionConfig') {
        const config = await getSongDetectionConfig();
        sendResponse({
          success: true,
          mode: config.mode,
          minSegmentDurationSec: config.minSegmentDurationSec,
          updatedAt: config.updatedAt,
        });
        return;
      }

      if (request.action === 'setSongDetectionMode') {
        const config = await updateSongDetectionConfig({ mode: DEFAULT_DETECTOR_MODE });
        sendResponse({
          success: true,
          mode: config.mode,
          minSegmentDurationSec: config.minSegmentDurationSec,
          updatedAt: config.updatedAt,
        });
        return;
      }

      if (request.action === 'setSongDetectionConfig') {
        const config = await updateSongDetectionConfig({
          minSegmentDurationSec: request.minSegmentDurationSec,
        });
        sendResponse({
          success: true,
          mode: config.mode,
          minSegmentDurationSec: config.minSegmentDurationSec,
          updatedAt: config.updatedAt,
        });
        return;
      }

      if (request.action === 'openSongDetectionPermissionPopup') {
        const tabId = await resolveTargetTabId(sender, request);
        const openResult = await openSongDetectionPermissionPopup(
          tabId,
          request.videoId || null,
          request.reason || 'authorize-tabCapture'
        );
        sendResponse({
          success: true,
          tabId,
          opened: openResult.opened,
        });
        return;
      }

      if (request.action === 'getSongDetectionAuthorizationContext') {
        sendResponse({
          success: true,
          pending: pendingAuthorizationRequest,
        });
        return;
      }

      if (request.action === 'requestCurrentVideoTime') {
        const tabId = await resolveTargetTabId(sender, request);
        if (typeof tabId !== 'number') {
          sendResponse({ success: false, message: 'requestCurrentVideoTime requires tabId' });
          return;
        }
        const snapshot = await requestCurrentVideoSnapshotFromTab(tabId);
        if (!snapshot) {
          sendResponse({ success: false, message: 'Unable to read current video time.' });
          return;
        }
        sendResponse({
          success: true,
          tabId,
          currentTime: snapshot.currentTime,
          videoId: snapshot.videoId,
        });
        return;
      }

      if (request.action === 'requestCurrentVideoId' || request.action === 'getCurrentVideoId') {
        const tabId = await resolveTargetTabId(sender, request);
        if (typeof tabId !== 'number') {
          sendResponse({ success: false, message: 'requestCurrentVideoId requires tabId' });
          return;
        }
        const videoId = await requestCurrentVideoIdFromTab(tabId);
        if (!videoId) {
          sendResponse({ success: false, tabId, videoId: null });
          return;
        }
        sendResponse({ success: true, tabId, videoId });
        return;
      }

      if (request.action === 'songSegmentsUpdated') {
        const result = await handleSongSegmentsUpdated(request);
        sendResponse(result);
        return;
      }

      if (request.action === 'songDetectionStatusChanged') {
        const tabId = Number(request?.tabId);
        if (!Number.isFinite(tabId)) {
          sendResponse({ success: false, message: 'songDetectionStatusChanged requires tabId' });
          return;
        }
        const session = await notifySongDetectionStatus(tabId, request.status, {
          videoId: request.videoId ?? null,
          detectorMode: request.detectorMode || DEFAULT_DETECTOR_MODE,
          detectorVersion: request.detectorVersion || getDefaultDetectorVersion(request.detectorMode),
          error: request.error || null,
          warning: request.warning || null,
          runtimeInfo: request.runtimeInfo || null,
          minSegmentDurationSec: request.minSegmentDurationSec,
        });
        sendResponse({ success: true, status: session.status, tabId });
        return;
      }

      sendResponse({ success: false, message: 'Unhandled action.' });
    } catch (error) {
      console.error('Error handling runtime message:', error);
      sendResponse({ success: false, message: error?.message || String(error) });
    }
  })();

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  (async () => {
    try {
      if (changeInfo.status !== 'complete') return;
      await safeSendTabMessage(tabId, { action: 'initializePlaylist' });

      const session = detectionSessions.get(tabId);
      if (session && (session.isRunning || session.status !== 'Idle')) {
        await safeSendTabMessage(tabId, {
          action: 'songDetectionStatusChanged',
          status: session.status,
          videoId: session.videoId,
          isRunning: session.isRunning,
          detectorMode: session.detectorMode,
          detectorVersion: session.detectorVersion,
          error: session.error,
          warning: session.warning,
          minSegmentDurationSec: session.minSegmentDurationSec,
        });
      }
    } catch (error) {
      console.log('Request failed.', error);
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    try {
      // 刪除與該 tab ID 相關的狀態資訊
      await chrome.storage.local.remove(`currentPlayId_${tabId}`);
      await chrome.storage.local.remove(`isPlaying_${tabId}`);
      await stopSongDetectionForTab(tabId, { notifyTab: false, removeSession: true });
      clearPendingAuthorizationForTab(tabId);
    } catch (error) {
      console.log('Error removing state for closed tab:', error);
    }
  })();
});
