import { FIRERED_AED_DETECTOR_VERSION } from './lib/songDetection/fireredAedDetector.js';
import { AUTO_SONG_TYPE, buildPlaylistMeta, formatSeconds, normalizePlaylist, normalizePlaylistItem, parseTimeToken, serializePlaylist } from './lib/playlistCore.js';
import { decodeM4aWithWebCodecs } from './lib/audio/mp4AacWebCodecsDecoder.js';

const OFFLINE_SOURCE = 'workbench-offline';
const OFFLINE_DETECTOR_VERSION = `${FIRERED_AED_DETECTOR_VERSION}-workbench-offline-v2`;
const DETECTION_CONFIG_KEY = 'songDetectionConfig';
const APP_PREFERENCES_KEY = 'ytjUserPreferences';
const APP_PREFERENCES_DEFAULTS_VERSION = 'defaults-off-2026-05-18';
const DEFAULT_MIN_SEGMENT_DURATION_SEC = 90;
const DEFAULT_PRELOAD_LOOKAHEAD_SEC = 20;
const QUEUE_STORAGE_KEY = 'workbench_cross_video_queue';
const SAVED_QUEUES_STORAGE_KEY = 'workbench_cross_video_saved_queues';
const HOP_SEC = 0.5;
const PLAYBACK_POLL_MS = 250;
const OFFLINE_ANALYSIS_CHUNK_SEC = 20;
const TRACKER_CONFIG = Object.freeze({ hopSeconds: HOP_SEC, candidateMinDurationSec: 18, candidateMaxDurationSec: 75, minCandidateAnchors: 5, minCandidateAnchorSpanSec: 4, candidateGapSec: 8, tailStartRequiredWindows: 4, tailEndRequiredWindows: 3, tailMaxDurationSec: 40, tailPaddingSec: 40, minSegmentDurationSec: 90, mergeGapSec: 8, provisionalMinDurationSec: 12 });
const MODEL_RUN_SEGMENT_RULES = Object.freeze({
  minSegmentDurationSec: 60,
  mergeGapSec: 18,
  introPaddingSec: 6,
  tailPaddingSec: 40,
  maxModelOnlyTailSec: 40,
  modelDropMaxGapSec: 8,
  suspiciousCoverageRatio: 0.65,
  suspiciousTailOverrunSec: 12,
  suspiciousStartOverrunSec: 10,
  silenceRmsThreshold: 0.0045,
  silencePeakThreshold: 0.018,
  silenceMinDurationSec: 1.6,
  silenceEndPaddingSec: 0.8,
  energyTailLookbackSec: 3.5,
  energyDropRatio: 0.2,
  energyPeakDropRatio: 0.3,
  energyDropMinDurationSec: 2.5,
  energyEndPaddingSec: 1.2,
  lowRegularityEnergyRatio: 0.35,
  lowRegularityCvThreshold: 0.05,
  preRollSec: 50,
  startLookbackSec: 45,
  startPaddingSec: 0.5,
  startEnergyRatio: 0.15,
  startPeakRatio: 0.24,
  startNoiseMultiplier: 1.55,
  startGapToleranceSec: 2.5,
  startMinRunSec: 0.75,
  startEnergyOnlyWindowSec: 10,
  vocalSingingThreshold: 0.72,
  vocalSingingMeanThreshold: 0.35,
  vocalSingingRatioThreshold: 0.12,
});
const OFFLINE_TRACKER_START_MARGIN = 0.02;
const OFFLINE_TRACKER_HYSTERESIS_GAP = 0.18;
const OFFLINE_DECISION_RULES = Object.freeze({
  historyWindowSec: 45,
  shortWindowSec: 4,
  mediumWindowSec: 10,
  anchorGraceSec: 12,
  introLookbackSec: 45,
  singingPresentThreshold: 0.78,
  singingMeanShortThreshold: 0.5,
  singingMeanMediumThreshold: 0.52,
  musicPresentThreshold: 0.65,
  musicMeanMediumThreshold: 0.55,
  speechDominantThreshold: 0.65,
  speechLowSingingCeiling: 0.35,
});
const VIEW_META = Object.freeze({
  global: { eyebrowKey: 'view_global_eyebrow', titleKey: 'nav_global' },
  database: { eyebrowKey: 'view_database_eyebrow', titleKey: 'nav_database' },
  offline: { eyebrowKey: 'view_offline_eyebrow', titleKey: 'nav_offline' },
  settings: { eyebrowKey: 'settings_eyebrow', titleKey: 'settings_title' },
});
const UI_TEXT = Object.freeze({
  en: {
    nav_global: 'Global Playlist',
    nav_database: 'Database',
    nav_offline: 'Offline Analysis',
    nav_settings: 'Settings',
    view_global_eyebrow: 'Global Playlist',
    view_database_eyebrow: 'Database Editor',
    view_offline_eyebrow: 'Offline Detection',
    settings_eyebrow: 'Settings',
    settings_title: 'Settings',
    settings_language: 'Interface language',
    settings_language_auto: 'Follow browser language',
    settings_language_zh: 'Chinese',
    settings_language_en: 'English',
    settings_min_segment: 'Minimum song segment seconds',
    settings_split_medley: 'Enable medley splitting by default for offline analysis',
    settings_advanced_preload: 'Enable cross-video preload by default for playback queue',
    settings_advanced_preload_seconds: 'Cross-video preload seconds',
    settings_save: 'Save settings',
    settings_saved: 'Settings saved.',
    settings_save_failed: 'Failed to save settings: $1',
    library_eyebrow: 'Song Library',
    library_title: 'Recorded Songs',
    search_global_placeholder: 'Search songs or video titles',
    refresh: 'Refresh',
    collapse: 'Collapse',
    expand: 'Expand',
    now_playing: 'Now Playing',
    no_track_selected: 'No track selected',
    drag_songs_to_queue: 'Drag songs from the left into the playback queue',
    queue_name_placeholder: 'Queue name',
    save: 'Save',
    load: 'Load',
    delete: 'Delete',
    queue_title: 'Playback Queue',
    advanced_preload_label: 'Advanced test: preload the next video tab $1 seconds before switching',
    database_eyebrow: 'Database',
    database_title: 'Database',
    database_search_placeholder: 'Search videos or streams',
    playlist_items: 'Playlist Items',
    database_select_video: 'Select a video or stream on the left',
    add_segment: 'Add Segment',
    offline_eyebrow: 'Offline Detection',
    offline_title: 'Local Audio Analysis',
    audio_file: 'Audio file',
    start_seconds: 'Start seconds',
    end_seconds: 'End seconds',
    end_seconds_placeholder: 'Blank means end of file',
    save_to_video_id: 'Save to videoId',
    video_id_example: 'Example: -25jwY-5MT7I',
    display_title: 'Display title',
    optional_playlist_meta: 'Optional, saved to playlist meta',
    split_medley_label: 'Split medley',
    analyze_local_audio: 'Analyze Local Audio',
    save_segments: 'Save Segments',
    refresh_failed: 'Refresh failed: $1',
    select_audio_file: 'Select an audio file first.',
    enter_video_id: 'Enter the target videoId first.',
    no_segments_to_save: 'There are no segments to save.',
    saved_segments_to: 'Saved $1 auto-song segment(s) to $2.',
    untitled_video: 'Untitled video',
    no_songs: 'No songs',
    no_playlist_items: 'There are no playlist items to show.',
    songs_count: '$1 songs',
    matched_count: '$1/$2 matched',
    drag_whole_playlist: 'Drag the whole playlist to the playback queue',
    drag_song_to_queue: 'Drag song to playback queue',
    drag_add_whole_playlist: 'Drag to add the whole playlist',
    no_data: 'No data',
    no_editable_database: 'There is no editable playlist database.',
    select_left_video: 'Select a video or stream on the left',
    select_left_video_detail: 'After selecting one, you can edit segment order, titles, and times.',
    empty_database_playlist: 'This list has no segments',
    add_first_segment: 'Click "Add Segment" to create the first item.',
    drag_reorder_segment: 'Drag to reorder segments',
    song_title_placeholder: 'Song title',
    saved_status: 'Saved.',
    selected_database_missing: 'Selected database item is missing.',
    item_added: 'Item added.',
    item_saved: 'Item saved.',
    item_deleted: 'Item deleted.',
    order_saved: 'Order saved.',
    delete_database_confirm: 'Delete the complete database list for "$1"?',
    delete_item_confirm: 'Delete "$1"?',
    untitled_item: 'Untitled',
    new_song: 'New Song',
    queue_empty_cannot_save: 'The queue is empty and cannot be saved.',
    queue_saved: 'Saved queue: $1',
    queue_loaded: 'Loaded queue: $1',
    queue_deleted: 'Deleted queue: $1',
    queue_added_video: 'Added $1 songs: $2',
    queue_inserted_at: 'Inserted at $1: $2',
    no_saved_lists: 'No saved lists',
    no_queue_to_load: 'There is no queue to load.',
    shuffled: 'Shuffled.',
    drag_reorder_queue: 'Drag to reorder playback queue',
    loaded_another_queue: 'Loaded another queue.',
    delete_queue_confirm: 'Delete the current playback queue?',
    queue_empty: 'The playback queue is empty',
    drag_songs_here: 'Drag songs from the left here',
    remove: 'Remove',
    stopped: 'Stopped.',
    stopped_by_user: 'Stopped by user.',
    paused: 'Paused.',
    playing_with_preload: 'Playing with advanced preload...',
    playing_with_navigation: 'Playing with page navigation...',
    playing_index: 'Playing $1/$2',
    playing_index_title: 'Playing $1/$2: $3',
    queue_completed: 'Playback queue completed.',
    preload_failed: 'Preload failed: $1',
    sidebar_expand: 'Expand sidebar',
    sidebar_collapse: 'Collapse sidebar',
  },
  zh: {
    nav_global: '總播放清單',
    nav_database: '資料庫編輯',
    nav_offline: '本機音訊分析',
    nav_settings: '設定',
    view_global_eyebrow: '總播放清單',
    view_database_eyebrow: '資料庫編輯',
    view_offline_eyebrow: '本機音訊分析',
    settings_eyebrow: '設定',
    settings_title: '設定',
    settings_language: '介面語言',
    settings_language_auto: '依照瀏覽器語言',
    settings_language_zh: '中文',
    settings_language_en: 'English',
    settings_min_segment: '最短歌曲片段秒數',
    settings_split_medley: '離線分析預設啟用串燒切分',
    settings_advanced_preload: '播放序列預設啟用跨影片預開緩衝',
    settings_advanced_preload_seconds: '跨影片預開緩衝秒數',
    settings_save: '儲存設定',
    settings_saved: '設定已儲存。',
    settings_save_failed: '儲存設定失敗：$1',
    library_eyebrow: '歌曲資料庫',
    library_title: '已記錄歌曲',
    search_global_placeholder: '搜尋歌曲 / 影片標題',
    refresh: '重新整理',
    collapse: '收合',
    expand: '展開',
    now_playing: '目前播放',
    no_track_selected: '尚未選擇歌曲',
    drag_songs_to_queue: '拖曳左側歌曲加入播放序列',
    queue_name_placeholder: '清單名稱',
    save: '儲存',
    load: '載入',
    delete: '刪除',
    queue_title: '播放序列',
    advanced_preload_label: '進階測試：跨影片前 $1 秒預開緩衝分頁',
    database_eyebrow: '資料庫',
    database_title: '資料庫',
    database_search_placeholder: '搜尋影片 / 直播',
    playlist_items: '播放清單段落',
    database_select_video: '選擇左側影片 / 直播',
    add_segment: '新增段落',
    offline_eyebrow: '離線偵測',
    offline_title: '本機音訊檔離線分析',
    audio_file: '音訊檔',
    start_seconds: '開始秒數',
    end_seconds: '結束秒數',
    end_seconds_placeholder: '留空代表檔案結尾',
    save_to_video_id: '儲存到 videoId',
    video_id_example: '例如 -25jwY-5MT7I',
    display_title: '顯示標題',
    optional_playlist_meta: '可選，寫入 playlist meta',
    split_medley_label: '串燒切分',
    analyze_local_audio: '分析本機音訊',
    save_segments: '儲存片段',
    refresh_failed: '重新整理失敗：$1',
    select_audio_file: '請先選擇音訊檔。',
    enter_video_id: '請輸入要儲存的 videoId。',
    no_segments_to_save: '目前沒有可儲存的片段。',
    saved_segments_to: '已儲存 $1 個 auto-song 片段到 $2。',
    untitled_video: '未命名影片',
    no_songs: '沒有歌曲',
    no_playlist_items: '目前沒有可顯示的播放清單段落。',
    songs_count: '$1 首歌',
    matched_count: '符合 $1/$2',
    drag_whole_playlist: '拖曳整場歌單到播放序列',
    drag_song_to_queue: '拖曳歌曲到播放序列',
    drag_add_whole_playlist: '拖曳加入整場歌單',
    no_data: '沒有資料',
    no_editable_database: '目前沒有可編輯的播放清單資料庫。',
    select_left_video: '選擇左側影片 / 直播',
    select_left_video_detail: '選取後可編輯段落順序、名稱與時間。',
    empty_database_playlist: '此清單沒有段落',
    add_first_segment: '按「新增段落」建立第一筆資料。',
    drag_reorder_segment: '拖曳調整段落順序',
    song_title_placeholder: '歌曲名稱',
    saved_status: '已儲存。',
    selected_database_missing: '找不到目前選取的資料庫項目。',
    item_added: '段落已新增。',
    item_saved: '段落已儲存。',
    item_deleted: '段落已刪除。',
    order_saved: '順序已儲存。',
    delete_database_confirm: '確定要刪除「$1」的完整資料庫清單？',
    delete_item_confirm: '確定要刪除「$1」？',
    untitled_item: '未命名',
    new_song: '新歌曲',
    queue_empty_cannot_save: '佇列是空的，無法儲存。',
    queue_saved: '已儲存清單：$1',
    queue_loaded: '已載入清單：$1',
    queue_deleted: '已刪除清單：$1',
    queue_added_video: '已加入 $1 首：$2',
    queue_inserted_at: '已插入第 $1 位：$2',
    no_saved_lists: '沒有已儲存清單',
    no_queue_to_load: '沒有可載入的清單。',
    shuffled: '已亂序。',
    drag_reorder_queue: '拖曳調整播放順序',
    loaded_another_queue: '已載入其他清單。',
    delete_queue_confirm: '確定要刪除目前播放佇列？',
    queue_empty: '播放序列是空的',
    drag_songs_here: '從左側拖曳歌曲到此處',
    remove: '移除',
    stopped: '已停止。',
    stopped_by_user: '使用者已停止。',
    paused: '已暫停。',
    playing_with_preload: '正在播放：已啟用進階預開緩衝...',
    playing_with_navigation: '正在播放：一般頁面跳轉...',
    playing_index: '正在播放 $1/$2',
    playing_index_title: '正在播放 $1/$2：$3',
    queue_completed: '播放佇列已完成。',
    preload_failed: '預開緩衝失敗：$1',
    sidebar_expand: '展開側欄',
    sidebar_collapse: '收合側欄',
  },
});
const $ = (id) => document.getElementById(id);

const appShell = $('appShell');
const sidebarToggle = $('sidebarToggle');
const pageEyebrow = $('pageEyebrow');
const pageTitle = $('pageTitle');
const navItems = Array.from(document.querySelectorAll('.nav-item'));
const viewPanels = Array.from(document.querySelectorAll('[data-view-panel]'));
const offlineAudioInput = $('offlineAudioInput');
const offlineStartSec = $('offlineStartSec');
const offlineEndSec = $('offlineEndSec');
const offlineVideoId = $('offlineVideoId');
const offlineTitle = $('offlineTitle');
const offlineMinSegmentSec = $('offlineMinSegmentSec');
const offlineAnalyzeBtn = $('offlineAnalyzeBtn');
const offlineSaveBtn = $('offlineSaveBtn');
const offlineSplitMedleyToggle = $('offlineSplitMedleyToggle');
const offlineProgressBar = $('offlineProgressBar');
const offlineStatus = $('offlineStatus');
const offlineSummary = $('offlineSummary');
const offlineBoundaryDebug = $('offlineBoundaryDebug');
const offlineResults = $('offlineResults');
const modelStatus = $('modelStatus');
const storageStatus = $('storageStatus');
const globalSearch = $('globalSearch');
const refreshGlobalBtn = $('refreshGlobalBtn');
const groupToggleBtn = $('groupToggleBtn');
const globalPlaylistList = $('globalPlaylistList');
const databaseSearch = $('databaseSearch');
const refreshDatabaseBtn = $('refreshDatabaseBtn');
const databaseVideoList = $('databaseVideoList');
const databaseEditorCover = $('databaseEditorCover');
const databaseTitleText = $('databaseTitleText');
const databaseItemCountBadge = $('databaseItemCountBadge');
const databaseStatus = $('databaseStatus');
const databaseAddItemBtn = $('databaseAddItemBtn');
const databaseTrackList = $('databaseTrackList');
const queueCountBadge = $('queueCountBadge');
const queueList = $('queueList');
const nowPlayingCover = $('nowPlayingCover');
const nowPlayingTitle = $('nowPlayingTitle');
const nowPlayingVideoTitle = $('nowPlayingVideoTitle');
const nowPlayingTime = $('nowPlayingTime');
const shuffleQueueBtn = $('shuffleQueueBtn');
const prevTrackBtn = $('prevTrackBtn');
const playPauseBtn = $('playPauseBtn');
const nextTrackBtn = $('nextTrackBtn');
const advancedPreloadToggle = $('advancedPreloadToggle');
const advancedPreloadLabel = $('advancedPreloadLabel');
const stopQueueBtn = $('stopQueueBtn');
const clearQueueBtn = $('clearQueueBtn');
const queueNameInput = $('queueNameInput');
const saveQueueBtn = $('saveQueueBtn');
const savedQueueSelect = $('savedQueueSelect');
const loadQueueBtn = $('loadQueueBtn');
const deleteSavedQueueBtn = $('deleteSavedQueueBtn');
const queueStatus = $('queueStatus');
const toastHost = $('toastHost');
const settingsLanguageSelect = $('settingsLanguageSelect');
const settingsMinSegmentSec = $('settingsMinSegmentSec');
const settingsSplitMedleyDefault = $('settingsSplitMedleyDefault');
const settingsAdvancedPreloadDefault = $('settingsAdvancedPreloadDefault');
const settingsAdvancedPreloadLookaheadSec = $('settingsAdvancedPreloadLookaheadSec');
const saveSettingsBtn = $('saveSettingsBtn');
const settingsStatus = $('settingsStatus');

let offlineSegments = [];
let offlineBoundarySplit = null;
let cachedSongRows = [];
let databaseVideos = [];
let selectedDatabaseVideoId = null;
let queueItems = [];
let savedQueues = [];
let queueIdCounter = 0;
let videoTitleCache = new Map();
let libraryGrouped = false;
let libraryDrag = null;
let queueDrag = null;
let databaseDrag = null;
let suppressPlaylistStorageEvents = 0;
let lastInternalPlaylistWriteAt = 0;
let playlistStorageRefreshTimer = null;
let playbackState = createIdlePlaybackState();
let localePreviewOverride = 'auto';
let userPreferences = {
  language: 'auto',
  offlineSplitMedleyDefault: false,
  advancedPreloadDefault: false,
  advancedPreloadLookaheadSec: DEFAULT_PRELOAD_LOOKAHEAD_SEC,
};

function createIdlePlaybackState() { return { runId: 0, playing: false, paused: false, activeIndex: -1, requestedIndex: null, activeQueueId: null, activeHandle: null, activeVideoId: null, preloadHandles: new Map(), pausedPolls: 0 }; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function toFiniteNumber(value, fallback = null) { const num = Number(value); return Number.isFinite(num) ? num : fallback; }
function readNumberInput(input, fallback = null) { const text = String(input?.value || '').trim(); return text ? toFiniteNumber(text, fallback) : fallback; }
function normalizeMinSegmentDurationSec(value, fallback = DEFAULT_MIN_SEGMENT_DURATION_SEC) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(15, Math.min(600, Math.round(num)));
}
function normalizePreloadLookaheadSec(value, fallback = DEFAULT_PRELOAD_LOOKAHEAD_SEC) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(5, Math.min(120, Math.round(num)));
}
function normalizeLanguagePreference(value) {
  const key = String(value || 'auto').trim().toLowerCase();
  return key === 'zh' || key === 'en' ? key : 'auto';
}
function resolveWorkbenchLanguage() {
  if (localePreviewOverride === 'zh' || localePreviewOverride === 'en') return localePreviewOverride;
  const configuredLanguage = normalizeLanguagePreference(userPreferences.language);
  if (configuredLanguage === 'zh' || configuredLanguage === 'en') return configuredLanguage;
  let uiLanguage = '';
  try {
    uiLanguage = chrome.i18n.getUILanguage() || '';
  } catch (error) {
    uiLanguage = navigator.language || '';
  }
  return uiLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
function tr(key, substitutions = []) {
  const lang = resolveWorkbenchLanguage();
  const template = UI_TEXT[lang][key] ?? UI_TEXT.en[key] ?? key;
  const args = Array.isArray(substitutions) ? substitutions : [substitutions];
  return String(template).replace(/\$(\d+)/g, (_, index) => {
    const valueIndex = Number(index) - 1;
    return args[valueIndex] === undefined ? '' : String(args[valueIndex]);
  });
}
function songsLabel(count) { return tr('songs_count', [count]); }
function getAdvancedPreloadLookaheadSec() {
  return normalizePreloadLookaheadSec(userPreferences.advancedPreloadLookaheadSec);
}
function updateAdvancedPreloadLabel() {
  if (advancedPreloadLabel) {
    advancedPreloadLabel.textContent = tr('advanced_preload_label', [getAdvancedPreloadLookaheadSec()]);
  }
}
function applyWorkbenchLanguage() {
  document.documentElement.lang = resolveWorkbenchLanguage() === 'zh' ? 'zh-TW' : 'en';
  document.querySelectorAll('[data-ui-key]').forEach((element) => {
    element.textContent = tr(element.dataset.uiKey);
  });
  document.querySelectorAll('[data-ui-placeholder]').forEach((element) => {
    element.placeholder = tr(element.dataset.uiPlaceholder);
  });
  document.querySelectorAll('.nav-item[data-view]').forEach((item) => {
    const label = item.querySelector('.nav-label');
    if (label?.textContent) item.title = label.textContent;
  });
  setActiveView(document.querySelector('.nav-item.active')?.dataset.view || 'global');
  const collapsed = appShell.classList.contains('sidebar-collapsed');
  sidebarToggle.setAttribute('aria-label', collapsed ? tr('sidebar_expand') : tr('sidebar_collapse'));
  sidebarToggle.title = collapsed ? tr('sidebar_expand') : tr('sidebar_collapse');
  if (groupToggleBtn) groupToggleBtn.textContent = libraryGrouped ? tr('expand') : tr('collapse');
  if (globalPlaylistList) renderGlobalPlaylist();
  if (queueList) renderQueue();
  if (databaseVideoList) renderDatabaseVideoList();
  if (databaseTrackList) renderDatabaseEditor();
  if (savedQueueSelect) renderSavedQueueSelect();
  updateAdvancedPreloadLabel();
}
function normalizeUserPreferences(raw = {}) {
  return {
    ...raw,
    language: normalizeLanguagePreference(raw.language),
    offlineSplitMedleyDefault: Boolean(raw.offlineSplitMedleyDefault),
    advancedPreloadDefault: Boolean(raw.advancedPreloadDefault),
    advancedPreloadLookaheadSec: normalizePreloadLookaheadSec(raw.advancedPreloadLookaheadSec),
  };
}
async function loadUserPreferences() {
  const stored = await chrome.storage.local.get(APP_PREFERENCES_KEY);
  const raw = stored[APP_PREFERENCES_KEY] || {};
  userPreferences = normalizeUserPreferences(raw);
  if (raw.appPreferencesDefaultsVersion !== APP_PREFERENCES_DEFAULTS_VERSION) {
    userPreferences = normalizeUserPreferences({
      ...userPreferences,
      offlineSplitMedleyDefault: false,
      advancedPreloadDefault: false,
      appPreferencesDefaultsVersion: APP_PREFERENCES_DEFAULTS_VERSION,
      updatedAt: new Date().toISOString(),
    });
    await chrome.storage.local.set({ [APP_PREFERENCES_KEY]: userPreferences });
  }
  return userPreferences;
}
async function saveUserPreferences(patch = {}) {
  const next = normalizeUserPreferences({
    ...userPreferences,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  await chrome.storage.local.set({ [APP_PREFERENCES_KEY]: next });
  userPreferences = next;
  applyWorkbenchLanguage();
  return next;
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function setStatus(element, message) { if (element) element.textContent = message; }
function setProgress(element, ratio) { element.style.width = `${Math.round(clamp(ratio, 0, 1) * 100)}%`; }
function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function showToast(message, { warning = false, timeout = 4200 } = {}) { const toast = document.createElement('div'); toast.className = `toast-card${warning ? ' warning' : ''}`; toast.textContent = message; toastHost.appendChild(toast); setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(6px)'; setTimeout(() => toast.remove(), 220); }, timeout); }
function renderChips(container, items) { container.innerHTML = ''; for (const item of items) { const chip = document.createElement('span'); chip.className = 'summary-chip'; chip.textContent = item; container.appendChild(chip); } }
async function loadSongDetectionConfig() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSongDetectionConfig' });
    if (response && response.success) return response;
  } catch (error) {
    // Fall back to direct storage when the service worker is restarting.
  }
  const stored = await chrome.storage.local.get(DETECTION_CONFIG_KEY);
  return stored[DETECTION_CONFIG_KEY] || {};
}
async function saveSongDetectionConfig(patch = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'setSongDetectionConfig', ...patch });
    if (response && response.success) return response;
  } catch (error) {
    // Fall back to direct storage when the service worker is restarting.
  }
  const current = await loadSongDetectionConfig();
  const next = {
    ...current,
    minSegmentDurationSec: normalizeMinSegmentDurationSec(
      patch.minSegmentDurationSec,
      current.minSegmentDurationSec
    ),
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [DETECTION_CONFIG_KEY]: next });
  return { success: true, ...next };
}
function renderSettingsForm(detectionConfig = {}) {
  if (settingsLanguageSelect) settingsLanguageSelect.value = normalizeLanguagePreference(userPreferences.language);
  if (settingsMinSegmentSec) {
    settingsMinSegmentSec.value = String(normalizeMinSegmentDurationSec(detectionConfig.minSegmentDurationSec));
  }
  if (settingsSplitMedleyDefault) {
    settingsSplitMedleyDefault.checked = Boolean(userPreferences.offlineSplitMedleyDefault);
  }
  if (settingsAdvancedPreloadDefault) {
    settingsAdvancedPreloadDefault.checked = Boolean(userPreferences.advancedPreloadDefault);
  }
  if (settingsAdvancedPreloadLookaheadSec) {
    settingsAdvancedPreloadLookaheadSec.value = String(normalizePreloadLookaheadSec(userPreferences.advancedPreloadLookaheadSec));
  }
  updateAdvancedPreloadLabel();
}
async function saveSettingsFromForm() {
  const minSegmentDurationSec = normalizeMinSegmentDurationSec(
    readNumberInput(settingsMinSegmentSec, DEFAULT_MIN_SEGMENT_DURATION_SEC)
  );
  const advancedPreloadLookaheadSec = normalizePreloadLookaheadSec(
    readNumberInput(settingsAdvancedPreloadLookaheadSec, DEFAULT_PRELOAD_LOOKAHEAD_SEC)
  );
  if (settingsMinSegmentSec) settingsMinSegmentSec.value = String(minSegmentDurationSec);
  if (offlineMinSegmentSec) offlineMinSegmentSec.value = String(minSegmentDurationSec);
  if (settingsAdvancedPreloadLookaheadSec) settingsAdvancedPreloadLookaheadSec.value = String(advancedPreloadLookaheadSec);

  await saveSongDetectionConfig({ minSegmentDurationSec });
  await saveUserPreferences({
    language: settingsLanguageSelect?.value || 'auto',
    offlineSplitMedleyDefault: Boolean(settingsSplitMedleyDefault?.checked),
    advancedPreloadDefault: Boolean(settingsAdvancedPreloadDefault?.checked),
    advancedPreloadLookaheadSec,
  });

  if (offlineSplitMedleyToggle) offlineSplitMedleyToggle.checked = Boolean(userPreferences.offlineSplitMedleyDefault);
  if (advancedPreloadToggle) advancedPreloadToggle.checked = Boolean(userPreferences.advancedPreloadDefault);
  updateAdvancedPreloadLabel();
  setStatus(settingsStatus, tr('settings_saved'));
  showToast(tr('settings_saved'));
}
function setActiveView(view) {
  const selectedView = VIEW_META[view] ? view : 'global';
  if (pageEyebrow) pageEyebrow.textContent = tr(VIEW_META[selectedView].eyebrowKey);
  if (pageTitle) pageTitle.textContent = tr(VIEW_META[selectedView].titleKey);
  for (const item of navItems) item.classList.toggle('active', item.dataset.view === selectedView);
  for (const panel of viewPanels) panel.classList.toggle('active', panel.dataset.viewPanel === selectedView);
  if (selectedView === 'database') schedulePlaylistViewsRefresh();
}
function segmentDuration(item) { return Math.max(0, (Number(item?.endSec) || 0) - (Number(item?.startSec) || 0)); }
function thumbnailUrl(videoId) { return `https://i.ytimg.com/vi/${encodeURIComponent(videoId || '')}/mqdefault.jpg`; }
function emptyCoverUrl() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"></svg>';
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
function makeQueueId() { queueIdCounter += 1; return `queue-${Date.now()}-${queueIdCounter}-${Math.random().toString(36).slice(2, 8)}`; }
function serializeQueueItems(items) { return items.map(({ queueId, ...item }) => ({ ...item })); }
function formatRange(startSec, endSec) { return `${formatSeconds(startSec)} ~ ${formatSeconds(endSec)} (${formatSeconds(Math.max(0, Number(endSec) - Number(startSec)))})`; }
function parseTimeField(value, fallback = 0) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Math.floor(Number(text)));
  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(text)) return parseTimeToken(text);
  return fallback;
}
function playlistStorageKey(videoId) { return `playlist_${videoId}`; }
function playlistMetaStorageKey(videoId) { return `playlist_meta_${videoId}`; }
async function writePlaylistStorage(mutator) {
  suppressPlaylistStorageEvents += 1;
  lastInternalPlaylistWriteAt = Date.now();
  try {
    return await mutator();
  } finally {
    setTimeout(() => {
      suppressPlaylistStorageEvents = Math.max(0, suppressPlaylistStorageEvents - 1);
    }, 300);
  }
}
function schedulePlaylistViewsRefresh() {
  clearTimeout(playlistStorageRefreshTimer);
  playlistStorageRefreshTimer = setTimeout(() => {
    playlistStorageRefreshTimer = null;
    Promise.all([
      refreshGlobalPlaylist(),
      refreshDatabaseEditor(),
    ]).catch((error) => showToast(tr('refresh_failed', [error?.message || String(error)]), { warning: true }));
  }, 120);
}
function currentQueueItem() {
  if (playbackState.activeIndex >= 0 && playbackState.activeIndex < queueItems.length) return queueItems[playbackState.activeIndex];
  return queueItems[0] || null;
}
function getFilteredSongRows() {
  const query = (globalSearch.value || '').trim().toLowerCase();
  if (!query) return cachedSongRows;
  return cachedSongRows.filter((row) => [row.title, row.videoTitle, row.type].some((value) => String(value).toLowerCase().includes(query)));
}
function rowsForVideo(videoId) {
  return cachedSongRows
    .filter((row) => row.videoId === videoId)
    .sort((a, b) => (a.itemOrder - b.itemOrder) || (a.startSec - b.startSec));
}
function groupRowsByVideo(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.videoId)) {
      groups.set(row.videoId, { videoId: row.videoId, videoTitle: row.videoTitle, videoOrder: row.videoOrder, matchedRows: [], totalRows: rowsForVideo(row.videoId).length, totalDurationSec: 0 });
    }
    const group = groups.get(row.videoId);
    group.matchedRows.push(row);
  }
  for (const group of groups.values()) {
    group.totalDurationSec = rowsForVideo(group.videoId).reduce((sum, row) => sum + segmentDuration(row), 0);
  }
  return Array.from(groups.values()).sort((a, b) => a.videoOrder - b.videoOrder);
}

function mixAudioChunk(audioBuffer, startFrame, frameCount) {
  const channels = audioBuffer.numberOfChannels;
  const mono = new Float32Array(frameCount);
  if (channels <= 0) return mono;
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i += 1) mono[i] += data[startFrame + i] || 0;
  }
  const scale = 1 / channels;
  for (let i = 0; i < mono.length; i += 1) mono[i] *= scale;
  return mono;
}

function summarizeHistory(history, now, windowSec) {
  const frames = history.filter((frame) => frame.timeSec >= now - windowSec);
  if (!frames.length) return { singingMax: 0, singingMean: 0, musicMax: 0, musicMean: 0, speechMean: 0 };
  return frames.reduce((acc, frame) => { acc.singingMax = Math.max(acc.singingMax, frame.singing); acc.musicMax = Math.max(acc.musicMax, frame.music); acc.singingMean += frame.singing / frames.length; acc.musicMean += frame.music / frames.length; acc.speechMean += frame.speech / frames.length; return acc; }, { singingMax: 0, singingMean: 0, musicMax: 0, musicMean: 0, speechMean: 0 });
}

function resolveOfflineTrackerThresholds(analysis = {}) {
  const calibratedThreshold = clamp(toFiniteNumber(analysis.temporalHeadThreshold, 0.75), 0.05, 0.95);
  const start = clamp(calibratedThreshold - OFFLINE_TRACKER_START_MARGIN, 0.08, 0.9);
  const end = clamp(start - OFFLINE_TRACKER_HYSTERESIS_GAP, 0.05, Math.max(0.05, start - 0.02));
  return { start, end };
}

function findOfflineAnchoredStartSec(history, now) {
  let anchorIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const frame = history[index];
    if (now - frame.timeSec > OFFLINE_DECISION_RULES.mediumWindowSec) break;
    if (frame.singing >= OFFLINE_DECISION_RULES.singingPresentThreshold || frame.model >= frame.thresholds.start) {
      anchorIndex = index;
      break;
    }
  }
  if (anchorIndex < 0) return null;

  let startSec = history[anchorIndex].timeSec;
  for (let index = anchorIndex; index >= 0; index -= 1) {
    const frame = history[index];
    if (now - frame.timeSec > OFFLINE_DECISION_RULES.introLookbackSec) break;
    const musicLike = frame.music >= 0.55 || frame.model >= frame.thresholds.end;
    const singingLike = frame.singing >= 0.5 || frame.model >= frame.thresholds.start;
    const speechDominant = frame.speech >= 0.68 && frame.singing < 0.28;
    if (!musicLike && !singingLike) break;
    if (speechDominant) break;
    startSec = frame.timeSec;
  }
  return Math.max(0, startSec);
}

function applyOfflineDecision(session, timeSec, analysis) {
  const thresholds = resolveOfflineTrackerThresholds(analysis);
  const temporalHeadReady = Boolean(analysis.temporalHeadReady);
  const temporalHeadProbability = clamp(Number(analysis.temporalHeadProbability ?? analysis.songProbability) || 0, 0, 1);
  const frame = {
    timeSec,
    singing: clamp(Number(analysis.singingProbability ?? analysis.singingMean) || 0, 0, 1),
    music: clamp(Number(analysis.musicProbability ?? analysis.musicMean) || 0, 0, 1),
    speech: clamp(Number(analysis.speechProbability ?? analysis.speechMean) || 0, 0, 1),
    model: temporalHeadProbability,
    thresholds,
  };
  session.history.push(frame);
  session.history = session.history.filter((item) => item.timeSec >= timeSec - OFFLINE_DECISION_RULES.historyWindowSec);
  const shortStats = summarizeHistory(session.history, timeSec, OFFLINE_DECISION_RULES.shortWindowSec);
  const mediumStats = summarizeHistory(session.history, timeSec, OFFLINE_DECISION_RULES.mediumWindowSec);
  const trackerIsSong = Boolean(session.segmentTracker?.isSong);
  const silentFrame = isOfflineSilentFrame(analysis);
  const speechDominant = silentFrame || (
    mediumStats.speechMean >= OFFLINE_DECISION_RULES.speechDominantThreshold
    && shortStats.singingMean < OFFLINE_DECISION_RULES.speechLowSingingCeiling
  );
  const hasAcousticSingingAnchor = !speechDominant && (
    shortStats.singingMax >= OFFLINE_DECISION_RULES.singingPresentThreshold
    || shortStats.singingMean >= OFFLINE_DECISION_RULES.singingMeanShortThreshold
    || mediumStats.singingMean >= OFFLINE_DECISION_RULES.singingMeanMediumThreshold
  );
  const hasAcousticMusicSustain = !silentFrame && (
    shortStats.musicMax >= OFFLINE_DECISION_RULES.musicPresentThreshold
    || mediumStats.musicMean >= OFFLINE_DECISION_RULES.musicMeanMediumThreshold
  );
  const hasModelAnchor = temporalHeadReady && temporalHeadProbability >= thresholds.start && !speechDominant;
  const hasModelSustain = !silentFrame && temporalHeadReady && temporalHeadProbability >= thresholds.end && !speechDominant;
  const hasSingingAnchor = hasAcousticSingingAnchor || hasModelAnchor;
  const hasMusicSustain = hasAcousticMusicSustain || hasModelSustain;
  if (hasSingingAnchor) session.lastSingingAnchorSec = timeSec;
  const hasRecentAnchor = Number.isFinite(session.lastSingingAnchorSec)
    && timeSec - session.lastSingingAnchorSec <= OFFLINE_DECISION_RULES.anchorGraceSec;
  let songProbability = 0;
  if (hasSingingAnchor) {
    songProbability = temporalHeadReady ? Math.max(temporalHeadProbability, thresholds.start + 0.08) : thresholds.start + 0.08;
  } else if ((trackerIsSong || hasRecentAnchor || hasModelSustain) && hasMusicSustain && !speechDominant) {
    songProbability = temporalHeadReady ? Math.max(temporalHeadProbability, thresholds.end + 0.08, 0.38) : Math.max(thresholds.end + 0.08, 0.38);
  }
  const startSecOverride = hasSingingAnchor ? findOfflineAnchoredStartSec(session.history, timeSec) : null;
  const decision = {
    songProbability: clamp(songProbability, 0, 1),
    confidence: clamp(songProbability, 0, 1),
    hasSingingAnchor,
    hasRecentAnchor: hasRecentAnchor || (trackerIsSong && hasModelSustain),
    hasMusicSustain,
    speechDominant,
    startSecOverride,
    modelProbability: temporalHeadProbability,
    silentFrame,
    thresholds,
  };
  if (!Array.isArray(session.decisions)) session.decisions = [];
  session.decisions.push({ timeSec, ...decision });
  return decision;
}

function mergeOfflineSegments(segments, {
  maxGapSec = TRACKER_CONFIG.mergeGapSec,
  minSegmentDurationSec = TRACKER_CONFIG.minSegmentDurationSec,
} = {}) {
  const merged = [];
  for (const segment of segments.sort((a, b) => a.startSec - b.startSec)) {
    if (!merged.length || segment.startSec - merged[merged.length - 1].endSec > maxGapSec) {
      merged.push({ ...segment });
    } else {
      const previous = merged[merged.length - 1];
      const previousDuration = Math.max(0.001, previous.endSec - previous.startSec);
      const currentDuration = Math.max(0.001, segment.endSec - segment.startSec);
      const combinedDuration = previousDuration + currentDuration;
      previous.endSec = Math.max(previous.endSec, segment.endSec);
      previous.confidence = ((previous.confidence * previousDuration) + (segment.confidence * currentDuration)) / combinedDuration;
    }
  }
  return merged.filter((segment) => segment.endSec - segment.startSec >= minSegmentDurationSec);
}

function isOfflineVocalFrame(analysis) {
  return (Number(analysis.singingProbability) || 0) >= MODEL_RUN_SEGMENT_RULES.vocalSingingThreshold
    || (Number(analysis.singingMean) || 0) >= MODEL_RUN_SEGMENT_RULES.vocalSingingMeanThreshold
    || (Number(analysis.singingRatio) || 0) >= MODEL_RUN_SEGMENT_RULES.vocalSingingRatioThreshold;
}

function isOfflineSilentFrame(analysis) {
  const rms = Number(analysis.audioRms);
  const peak = Number(analysis.audioPeak);
  if (!Number.isFinite(rms) || !Number.isFinite(peak)) return false;
  return rms <= MODEL_RUN_SEGMENT_RULES.silenceRmsThreshold
    && peak <= MODEL_RUN_SEGMENT_RULES.silencePeakThreshold;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, ratio) {
  const sorted = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values, avg = mean(values)) {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length);
}

function pushLimited(values, value, maxItems = 240) {
  values.push(value);
  if (values.length > maxItems) values.splice(0, values.length - maxItems);
}

function updateActiveEnergyProfile(active, analysis, vocalFrame) {
  const rms = Number(analysis.audioRms);
  const peak = Number(analysis.audioPeak);
  if (!Number.isFinite(rms) || !Number.isFinite(peak)) return;
  pushLimited(active.energyFrames, { timeSec: analysis.timeSec, rms, peak }, 80);
  if (vocalFrame && rms > MODEL_RUN_SEGMENT_RULES.silenceRmsThreshold * 1.5) {
    pushLimited(active.vocalRmsSamples, rms);
    pushLimited(active.vocalPeakSamples, peak);
  }
}

function getActiveEnergyReference(active) {
  const rmsSamples = active.vocalRmsSamples.filter((value) => value > MODEL_RUN_SEGMENT_RULES.silenceRmsThreshold * 1.5);
  if (rmsSamples.length < 3) return null;
  const peakSamples = active.vocalPeakSamples.filter((value) => value > MODEL_RUN_SEGMENT_RULES.silencePeakThreshold);
  return {
    rms: median(rmsSamples),
    peak: median(peakSamples.length ? peakSamples : active.vocalPeakSamples),
  };
}

function getRecentEnergyStats(active, now) {
  const frames = active.energyFrames.filter((frame) => now - frame.timeSec <= MODEL_RUN_SEGMENT_RULES.energyTailLookbackSec);
  if (!frames.length) return null;
  const rmsValues = frames.map((frame) => frame.rms);
  const peakValues = frames.map((frame) => frame.peak);
  const meanRms = mean(rmsValues);
  const rmsStd = stddev(rmsValues, meanRms);
  return {
    meanRms,
    meanPeak: mean(peakValues),
    rmsCv: meanRms > 1e-6 ? rmsStd / meanRms : 0,
  };
}

function isOfflineEnergyCollapsed(active, analysis) {
  const reference = getActiveEnergyReference(active);
  const recent = getRecentEnergyStats(active, analysis.timeSec);
  if (!reference || !recent) return false;
  const rmsFloor = Math.max(MODEL_RUN_SEGMENT_RULES.silenceRmsThreshold * 1.25, reference.rms * MODEL_RUN_SEGMENT_RULES.energyDropRatio);
  const peakFloor = Math.max(MODEL_RUN_SEGMENT_RULES.silencePeakThreshold * 1.1, reference.peak * MODEL_RUN_SEGMENT_RULES.energyPeakDropRatio);
  const energyDrop = recent.meanRms <= rmsFloor && recent.meanPeak <= peakFloor;
  const lowFlatEnergy = recent.meanRms <= reference.rms * MODEL_RUN_SEGMENT_RULES.lowRegularityEnergyRatio
    && recent.rmsCv <= MODEL_RUN_SEGMENT_RULES.lowRegularityCvThreshold;
  return energyDrop || lowFlatEnergy;
}

function getAnalysisRms(analysis) {
  const value = Number(analysis.audioRms);
  return Number.isFinite(value) ? value : 0;
}

function getAnalysisPeak(analysis) {
  const value = Number(analysis.audioPeak);
  return Number.isFinite(value) ? value : 0;
}

function isOfflineMusicLikeFrame(analysis, thresholds = resolveOfflineTrackerThresholds(analysis)) {
  const modelProbability = Number(analysis.temporalHeadProbability ?? analysis.songProbability) || 0;
  return isOfflineVocalFrame(analysis)
    || modelProbability >= thresholds.end
    || (Number(analysis.musicProbability) || 0) >= 0.58
    || (Number(analysis.musicMean) || 0) >= 0.48
    || (Number(analysis.musicRatio) || 0) >= 0.28;
}

function estimateStartEnergyReference(frames, anchorTimeSec) {
  const rmsValues = frames.map(getAnalysisRms).filter((value) => value > 0);
  if (!rmsValues.length) return null;
  const peakValues = frames.map(getAnalysisPeak).filter((value) => value > 0);
  const anchorFrames = frames.filter((frame) => anchorTimeSec - frame.timeSec <= 2 && frame.timeSec <= anchorTimeSec);
  const anchorRms = median(anchorFrames.map(getAnalysisRms).filter((value) => value > 0)) || median(rmsValues);
  const anchorPeak = median(anchorFrames.map(getAnalysisPeak).filter((value) => value > 0)) || median(peakValues);
  const noiseRms = percentile(rmsValues, 0.2);
  const noisePeak = percentile(peakValues, 0.2);
  return {
    rms: Math.max(
      MODEL_RUN_SEGMENT_RULES.silenceRmsThreshold * 1.25,
      noiseRms * MODEL_RUN_SEGMENT_RULES.startNoiseMultiplier,
      anchorRms * MODEL_RUN_SEGMENT_RULES.startEnergyRatio
    ),
    peak: Math.max(
      MODEL_RUN_SEGMENT_RULES.silencePeakThreshold * 1.05,
      noisePeak * MODEL_RUN_SEGMENT_RULES.startNoiseMultiplier,
      anchorPeak * MODEL_RUN_SEGMENT_RULES.startPeakRatio
    ),
  };
}

function isAdaptiveStartFrame(analysis, reference, anchorTimeSec) {
  if (!reference || isOfflineSilentFrame(analysis)) return false;
  const energyActive = getAnalysisRms(analysis) >= reference.rms
    || getAnalysisPeak(analysis) >= reference.peak;
  if (!energyActive) return false;
  if (isOfflineMusicLikeFrame(analysis)) return true;

  const nearAnchor = anchorTimeSec - analysis.timeSec <= MODEL_RUN_SEGMENT_RULES.startEnergyOnlyWindowSec;
  const speechLow = (Number(analysis.speechProbability) || 0) < 0.62
    && (Number(analysis.speechMean) || 0) < 0.42;
  return nearAnchor && speechLow;
}

function findAdaptiveStartSec(preRollFrames, anchorAnalysis) {
  const fallbackStart = Math.max(0, anchorAnalysis.timeSec - HOP_SEC - MODEL_RUN_SEGMENT_RULES.introPaddingSec);
  const minTimeSec = Math.max(0, anchorAnalysis.timeSec - MODEL_RUN_SEGMENT_RULES.startLookbackSec);
  const frames = preRollFrames
    .filter((frame) => frame.timeSec >= minTimeSec && frame.timeSec <= anchorAnalysis.timeSec)
    .sort((a, b) => a.timeSec - b.timeSec);
  if (frames.length < 2) return fallbackStart;

  const reference = estimateStartEnergyReference(frames, anchorAnalysis.timeSec);
  if (!reference) return fallbackStart;

  let earliest = anchorAnalysis.timeSec;
  let gapSec = 0;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (isAdaptiveStartFrame(frame, reference, anchorAnalysis.timeSec)) {
      earliest = Math.max(0, frame.timeSec - HOP_SEC);
      gapSec = 0;
      continue;
    }

    gapSec += HOP_SEC;
    if (gapSec > MODEL_RUN_SEGMENT_RULES.startGapToleranceSec) break;
  }

  const runDuration = anchorAnalysis.timeSec - earliest;
  if (runDuration < MODEL_RUN_SEGMENT_RULES.startMinRunSec) return fallbackStart;
  return Math.max(0, earliest - MODEL_RUN_SEGMENT_RULES.startPaddingSec);
}

function finalizeModelRunSegment(active, endSec, endSecOverride = null) {
  const anchorEndSec = Number.isFinite(active.lastVocalSec) ? active.lastVocalSec : active.lastPositiveSec;
  const boundedEndSec = Number.isFinite(Number(endSecOverride))
    ? Number(endSecOverride)
    : anchorEndSec + MODEL_RUN_SEGMENT_RULES.tailPaddingSec;
  return {
    startSec: active.startSec,
    endSec: Math.min(endSec, Math.max(active.startSec, boundedEndSec)),
    confidence: active.confidenceTotal / Math.max(1, active.confidenceCount),
  };
}

function buildModelRunSegmentsFromAnalyses(analyses, endSec) {
  if (!Array.isArray(analyses) || !analyses.some((analysis) => analysis.temporalHeadReady)) return [];
  const segments = [];
  let active = null;
  const preRollFrames = [];
  const maxPreRollFrames = Math.max(1, Math.round(MODEL_RUN_SEGMENT_RULES.preRollSec / HOP_SEC));

  for (const analysis of analyses) {
    pushLimited(preRollFrames, analysis, maxPreRollFrames);
    const probability = clamp(Number(analysis.temporalHeadProbability ?? analysis.songProbability) || 0, 0, 1);
    const thresholds = resolveOfflineTrackerThresholds(analysis);
    const positive = analysis.temporalHeadReady && probability >= thresholds.start;
    const vocalFrame = isOfflineVocalFrame(analysis);
    const silentFrame = isOfflineSilentFrame(analysis);

    if (active) updateActiveEnergyProfile(active, analysis, vocalFrame);

    if (active && !vocalFrame) {
      const energyCollapsed = isOfflineEnergyCollapsed(active, analysis);
      if (silentFrame || energyCollapsed) {
        const markerKey = silentFrame ? 'silenceStartSec' : 'energyDropStartSec';
        const minDuration = silentFrame
          ? MODEL_RUN_SEGMENT_RULES.silenceMinDurationSec
          : MODEL_RUN_SEGMENT_RULES.energyDropMinDurationSec;
        const paddingSec = silentFrame
          ? MODEL_RUN_SEGMENT_RULES.silenceEndPaddingSec
          : MODEL_RUN_SEGMENT_RULES.energyEndPaddingSec;
        if (!Number.isFinite(active[markerKey])) {
          active[markerKey] = Math.max(active.startSec, analysis.timeSec - HOP_SEC);
        }
        const markerDuration = analysis.timeSec - active[markerKey];
        if (markerDuration >= minDuration) {
          segments.push(finalizeModelRunSegment(active, endSec, active[markerKey] + paddingSec));
          active = null;
          continue;
        }
      } else {
        active.silenceStartSec = null;
        active.energyDropStartSec = null;
      }
    } else if (active) {
      active.silenceStartSec = null;
      active.energyDropStartSec = null;
    }

    if (positive && vocalFrame) {
      if (!active) {
        active = {
          startSec: findAdaptiveStartSec(preRollFrames, analysis),
          lastPositiveSec: analysis.timeSec,
          lastVocalSec: analysis.timeSec,
          silenceStartSec: null,
          energyDropStartSec: null,
          modelDropStartSec: null,
          energyFrames: [],
          vocalRmsSamples: [],
          vocalPeakSamples: [],
          confidenceTotal: 0,
          confidenceCount: 0,
        };
        updateActiveEnergyProfile(active, analysis, true);
      }
      active.modelDropStartSec = null;
      active.lastPositiveSec = analysis.timeSec;
      active.lastVocalSec = analysis.timeSec;
      active.confidenceTotal += probability;
      active.confidenceCount += 1;
    } else if (positive && active) {
      active.modelDropStartSec = null;
      active.lastPositiveSec = analysis.timeSec;
      if (Number.isFinite(active.lastVocalSec) && analysis.timeSec - active.lastVocalSec > MODEL_RUN_SEGMENT_RULES.maxModelOnlyTailSec) {
        segments.push(finalizeModelRunSegment(active, endSec));
        active = null;
      }
    } else if (active) {
      if (!Number.isFinite(active.modelDropStartSec)) {
        active.modelDropStartSec = analysis.timeSec;
      }
      if (analysis.timeSec - active.modelDropStartSec <= MODEL_RUN_SEGMENT_RULES.modelDropMaxGapSec) {
        continue;
      }
      segments.push(finalizeModelRunSegment(active, endSec));
      active = null;
    }
  }

  if (active) {
    segments.push(finalizeModelRunSegment(active, endSec));
  }

  return mergeOfflineSegments(segments, {
    maxGapSec: MODEL_RUN_SEGMENT_RULES.mergeGapSec,
    minSegmentDurationSec: MODEL_RUN_SEGMENT_RULES.minSegmentDurationSec,
  }).map((segment) => ({
    startSec: Math.max(0, segment.startSec),
    endSec: Math.max(segment.startSec, segment.endSec),
    confidence: roundConfidence(segment.confidence),
    provisional: false,
  }));
}

function isSuspiciousOfflineSegmentResult(segments, modelRunSegments, startSec, endSec) {
  if (!modelRunSegments.length) return false;
  if (!segments.length) return true;
  const analyzedDuration = Math.max(1, endSec - startSec);
  const hasGiantSegment = segments.some((segment) => (segment.endSec - segment.startSec) / analyzedDuration >= MODEL_RUN_SEGMENT_RULES.suspiciousCoverageRatio);
  const hasLongTail = segments.some((segment) => {
    const overlaps = modelRunSegments.filter((modelSegment) => modelSegment.startSec < segment.endSec && modelSegment.endSec > segment.startSec);
    if (!overlaps.length) return false;
    const modelEndSec = Math.max(...overlaps.map((modelSegment) => modelSegment.endSec));
    return segment.endSec - modelEndSec > MODEL_RUN_SEGMENT_RULES.suspiciousTailOverrunSec;
  });
  const hasLongLead = segments.some((segment) => {
    const overlaps = modelRunSegments.filter((modelSegment) => modelSegment.startSec < segment.endSec && modelSegment.endSec > segment.startSec);
    if (!overlaps.length) return false;
    const modelStartSec = Math.min(...overlaps.map((modelSegment) => modelSegment.startSec));
    return modelStartSec - segment.startSec > MODEL_RUN_SEGMENT_RULES.suspiciousStartOverrunSec;
  });
  return hasGiantSegment || hasLongTail || hasLongLead || segments.length < Math.max(1, Math.floor(modelRunSegments.length / 2));
}

function buildFallbackSegmentsFromDecisions(decisions, endSec) {
  if (!Array.isArray(decisions) || !decisions.length) return [];
  const segments = [];
  let active = null;
  let lowCount = 0;

  for (const decision of decisions) {
    const positive = decision.hasSingingAnchor
      || (decision.hasRecentAnchor && decision.hasMusicSustain && !decision.speechDominant);
    if (positive) {
      if (!active) {
        active = {
          startSec: Number.isFinite(Number(decision.startSecOverride)) ? Number(decision.startSecOverride) : decision.timeSec,
          endSec: decision.timeSec,
          confidenceTotal: 0,
          confidenceCount: 0,
        };
      }
      active.endSec = decision.timeSec + HOP_SEC;
      active.confidenceTotal += clamp(Number(decision.confidence) || Number(decision.modelProbability) || 0.5, 0, 1);
      active.confidenceCount += 1;
      lowCount = 0;
    } else if (active) {
      lowCount += 1;
      if (lowCount >= TRACKER_CONFIG.tailEndRequiredWindows) {
        segments.push({
          startSec: active.startSec,
          endSec: Math.min(endSec, active.endSec + TRACKER_CONFIG.tailPaddingSec),
          confidence: active.confidenceTotal / Math.max(1, active.confidenceCount),
        });
        active = null;
        lowCount = 0;
      }
    }
  }

  if (active) {
    segments.push({
      startSec: active.startSec,
      endSec: Math.min(endSec, active.endSec + TRACKER_CONFIG.tailPaddingSec),
      confidence: active.confidenceTotal / Math.max(1, active.confidenceCount),
    });
  }
  return mergeOfflineSegments(segments).map((segment) => ({
    startSec: Math.max(0, segment.startSec),
    endSec: Math.max(segment.startSec, segment.endSec),
    confidence: roundConfidence(segment.confidence),
    provisional: false,
  }));
}

function roundConfidence(value) {
  return Math.round(clamp(Number(value) || 0, 0, 1) * 1000) / 1000;
}

function renderSegments(container, segments) {
  container.innerHTML = '<div class="result-row header"><span>Start</span><span>End</span><span>Title</span><span>Confidence</span></div>';
  if (!segments.length) { container.insertAdjacentHTML('beforeend', '<div class="result-row"><span>-</span><span>-</span><span>No segments detected</span><span>-</span></div>'); return; }
  segments.forEach((segment, index) => {
    const title = segment.title || `Offline Auto Song #${index + 1}`;
    const reasonText = Array.isArray(segment.boundaryReasons) && segment.boundaryReasons.length
      ? ` (${segment.boundaryReasons.join(', ')})`
      : '';
    container.insertAdjacentHTML('beforeend', `<div class="result-row"><span>${formatSeconds(segment.startSec)}</span><span>${formatSeconds(segment.endSec)}</span><span>${escapeHtml(title)}${escapeHtml(reasonText)}</span><span>${Math.round((segment.confidence || 0) * 100)}%</span></div>`);
  });
}

function formatBoundaryMetric(value, digits = 3) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : '-';
}

function renderBoundaryDebug(container, splitResult, enabled = false) {
  if (!container) return;
  container.innerHTML = '';
  container.hidden = !enabled;
  if (!enabled) return;

  const boundaries = Array.isArray(splitResult?.boundaries) ? splitResult.boundaries : [];
  const config = splitResult?.config || {};
  const header = document.createElement('div');
  header.className = 'boundary-debug-header';
  header.innerHTML = `<div><span class="eyebrow">Medley Boundary Debug</span><h3>串燒切點</h3></div><span class="panel-badge">${boundaries.length} accepted</span>`;
  container.appendChild(header);

  const ruleLine = document.createElement('div');
  ruleLine.className = 'boundary-debug-rules';
  ruleLine.textContent = `min child ${formatSeconds(config.minChildDurationSec || 0)} · min gap ${formatSeconds(config.minBoundaryGapSec || 0)} · edge guard ${formatSeconds(config.edgeGuardSec || 0)} · evidence >= ${config.minEvidenceCount || 0} · score >= ${Math.round((Number(config.minScore) || 0) * 100)}%`;
  container.appendChild(ruleLine);

  const list = document.createElement('div');
  list.className = 'boundary-debug-list';
  if (!boundaries.length) {
    list.innerHTML = '<div class="boundary-debug-row empty-row"><span>-</span><span>沒有接受的串燒切點</span><span>可降低 minScore 或檢查該段是否沒有低能量/人聲弱化。</span></div>';
    container.appendChild(list);
    return;
  }

  list.innerHTML = '<div class="boundary-debug-row header"><span>Time</span><span>Reason</span><span>Metrics</span></div>';
  boundaries.forEach((boundary) => {
    const reasons = Array.isArray(boundary.reasons) && boundary.reasons.length ? boundary.reasons.join(', ') : '-';
    const metrics = boundary.metrics || {};
    const metricText = [
      `confidence ${Math.round((boundary.confidence || 0) * 100)}%`,
      `source #${(boundary.sourceSegmentIndex ?? 0) + 1}`,
      `aed ${formatBoundaryMetric(metrics.aedChange)}`,
      `structure ${formatBoundaryMetric(metrics.structureChange)}`,
      `rms ${formatBoundaryMetric(metrics.valleyRms, 5)}/${formatBoundaryMetric(metrics.energyRef, 5)}`,
      `singing ${formatBoundaryMetric(metrics.valleySinging)}/${formatBoundaryMetric(metrics.singingRef)}`,
      `speech ${formatBoundaryMetric(metrics.speechMean)}`,
    ].join(' · ');
    const row = document.createElement('div');
    row.className = 'boundary-debug-row';
    row.innerHTML = `<span>${formatSeconds(boundary.timeSec)}</span><span>${escapeHtml(reasons)}</span><span>${escapeHtml(metricText)}</span>`;
    list.appendChild(row);
  });
  container.appendChild(list);
}

function extensionOfFile(file) {
  const match = /\.([a-z0-9]+)$/i.exec(file?.name || '');
  return match ? match[1].toLowerCase() : '';
}

function isBrowserDecodeFailure(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('unable to decode audio data') || message.includes('decode') || message.includes('encodingerror');
}

async function decodeAudioFile(audioContext, file, { startSec = 0, endSec = null } = {}) {
  const arrayBuffer = await file.arrayBuffer();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    return {
      audioBuffer,
      decodedStartSec: 0,
      sourceDurationSec: audioBuffer.duration,
      decoderName: 'Browser decodeAudioData',
    };
  } catch (error) {
    if (!isBrowserDecodeFailure(error)) throw error;
    const ext = extensionOfFile(file);
    if (ext === 'm4a' || ext === 'mp4') {
      try {
        setStatus(offlineStatus, 'Decoding audio...');
        return await decodeM4aWithWebCodecs(arrayBuffer, { audioContext, startSec, endSec });
      } catch (webCodecsError) {
        const reason = webCodecsError?.message || String(webCodecsError);
        throw new Error(`Chrome 無法直接解碼此 m4a，WebCodecs MP4/AAC 解碼也失敗：${reason}。請先轉成 16kHz mono WAV 後再匯入。指令：python tools/convert_audio_for_workbench.py --input "<audio.${ext}>" --output "<audio.workbench.wav>"`);
      }
    }
    const containerHint = ext === 'm4a' || ext === 'mp4'
      ? '這通常是 YouTube/DASH m4a 或特殊 AAC/MP4 container，Chrome 的 decodeAudioData 不能保證支援。'
      : 'Chrome 無法用 Web Audio API 解碼此音訊 container/codec。';
    throw new Error(`${containerHint} 請先轉成 16kHz mono WAV 後再匯入。指令：python tools/convert_audio_for_workbench.py --input "<audio.${ext || 'm4a'}>" --output "<audio.workbench.wav>"`);
  }
}

function sliceAudioBufferForWorker(audioBuffer, startFrame, endFrame) {
  const boundedStart = Math.max(0, Math.min(audioBuffer.length, Math.floor(startFrame)));
  const boundedEnd = Math.max(boundedStart, Math.min(audioBuffer.length, Math.ceil(endFrame)));
  const frameCount = boundedEnd - boundedStart;
  const channels = [];
  const transfer = [];

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const source = audioBuffer.getChannelData(channel);
    const sliced = source.slice(boundedStart, boundedEnd);
    channels.push(sliced);
    transfer.push(sliced.buffer);
  }

  return {
    audio: {
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: audioBuffer.numberOfChannels,
      length: frameCount,
      channels,
    },
    transfer,
  };
}

function runOfflineAnalysisWorker(payload, transfer) {
  return new Promise((resolve, reject) => {
    const jobId = `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const worker = new Worker(chrome.runtime.getURL('lib/songDetection/offlineDetectionWorker.js'));
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      callback(value);
    };

    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.jobId !== jobId) return;

      if (message.type === 'progress') {
        setProgress(offlineProgressBar, Number(message.ratio) || 0);
        if (message.message) setStatus(offlineStatus, message.message);
      } else if (message.type === 'status') {
        setStatus(offlineStatus, message.message || '');
      } else if (message.type === 'model-status') {
        setStatus(modelStatus, message.message || '');
      } else if (message.type === 'complete') {
        finish(resolve, message.result || {});
      } else if (message.type === 'error') {
        const error = new Error(message.error?.message || 'Offline detection worker failed.');
        if (message.error?.stack) error.stack = message.error.stack;
        finish(reject, error);
      }
    };

    worker.onerror = (event) => {
      finish(reject, new Error(event.message || 'Offline detection worker crashed.'));
    };

    worker.postMessage({
      type: 'analyze-offline-audio',
      jobId,
      payload,
    }, transfer);
  });
}

async function analyzeOfflineAudio() {
  const file = offlineAudioInput.files && offlineAudioInput.files[0];
  if (!file) { setStatus(offlineStatus, tr('select_audio_file')); return; }
  offlineSegments = [];
  offlineBoundarySplit = null;
  offlineAnalyzeBtn.disabled = true;
  offlineSaveBtn.disabled = true;
  setProgress(offlineProgressBar, 0);
  renderSegments(offlineResults, []);
  renderBoundaryDebug(offlineBoundaryDebug, null, false);
  renderChips(offlineSummary, []);
  let audioContext = null;
  try {
    setStatus(offlineStatus, 'Decoding audio...');
    setStatus(modelStatus, 'Model: worker idle');
    const requestedStartSec = Math.max(0, readNumberInput(offlineStartSec, 0));
    const requestedEndSec = readNumberInput(offlineEndSec, null);
    const minSegmentDurationSec = normalizeMinSegmentDurationSec(readNumberInput(offlineMinSegmentSec, DEFAULT_MIN_SEGMENT_DURATION_SEC));
    offlineMinSegmentSec.value = String(minSegmentDurationSec);
    await saveSongDetectionConfig({ minSegmentDurationSec });
    audioContext = new AudioContext();
    const decodedAudio = await decodeAudioFile(audioContext, file, { startSec: requestedStartSec, endSec: requestedEndSec });
    const audioBuffer = decodedAudio.audioBuffer;
    const durationSec = decodedAudio.sourceDurationSec ?? audioBuffer.duration;
    const decodedStartSec = decodedAudio.decodedStartSec ?? 0;
    const startSec = Math.min(durationSec, requestedStartSec);
    const endSec = Math.max(startSec, Math.min(durationSec, requestedEndSec || durationSec));
    const sampleRate = audioBuffer.sampleRate;
    const startFrame = Math.max(0, Math.floor((startSec - decodedStartSec) * sampleRate));
    const endFrame = Math.min(audioBuffer.length, Math.ceil((endSec - decodedStartSec) * sampleRate));
    const rangeLabel = `${formatSeconds(startSec)} - ${formatSeconds(endSec)}`;
    setStatus(offlineStatus, `Preparing worker buffer for ${file.name} (${rangeLabel})...`);
    const { audio, transfer } = sliceAudioBufferForWorker(audioBuffer, startFrame, endFrame);

    if (audioContext) {
      await audioContext.close().catch(() => {});
      audioContext = null;
    }

    const result = await runOfflineAnalysisWorker({
      audio,
      startSec,
      endSec,
      splitMedley: Boolean(offlineSplitMedleyToggle?.checked),
      minSegmentDurationSec,
      chunkSec: OFFLINE_ANALYSIS_CHUNK_SEC,
      rangeLabel,
    }, transfer);

    offlineSegments = Array.isArray(result.segments) ? result.segments : [];
    offlineBoundarySplit = result.boundarySplit || null;

    setProgress(offlineProgressBar, 1);
    const boundaryCount = offlineBoundarySplit?.boundaries?.length || 0;
    setStatus(offlineStatus, `Done. Detected ${offlineSegments.length} segment(s).`);
    renderChips(offlineSummary, [
      `duration ${formatSeconds(endSec - startSec)}`,
      `sample rate ${Math.round(sampleRate)} Hz`,
      `decoder ${decodedAudio.decoderName}`,
      `${offlineSegments.length} segment(s)`,
      `min segment ${result.minSegmentDurationSec || minSegmentDurationSec}s`,
      `hop ${HOP_SEC}s`,
      offlineSplitMedleyToggle?.checked ? `medley boundaries ${boundaryCount}` : null,
    ].filter(Boolean));
    renderBoundaryDebug(offlineBoundaryDebug, offlineBoundarySplit, Boolean(offlineSplitMedleyToggle?.checked));
    renderSegments(offlineResults, offlineSegments);
    offlineSaveBtn.disabled = offlineSegments.length === 0;
  } catch (error) {
    setStatus(offlineStatus, `Error: ${error?.message || String(error)}`);
    setStatus(modelStatus, 'Model: error');
  } finally {
    offlineAnalyzeBtn.disabled = false;
    if (audioContext) await audioContext.close().catch(() => {});
  }
}

function sortPlaylistItems(a, b) { if (a.startSec !== b.startSec) return a.startSec - b.startSec; if (a.endSec !== b.endSec) return a.endSec - b.endSec; return String(a.title || '').localeCompare(String(b.title || '')); }
async function saveOfflineSegments() {
  const videoId = offlineVideoId.value.trim();
  if (!videoId) { setStatus(offlineStatus, tr('enter_video_id')); return; }
  if (!offlineSegments.length) { setStatus(offlineStatus, tr('no_segments_to_save')); return; }
  const itemsKey = `playlist_${videoId}`;
  const metaKey = `playlist_meta_${videoId}`;
  const store = await chrome.storage.local.get([itemsKey, metaKey]);
  const existingMeta = store[metaKey] || {};
  const existing = normalizePlaylist(store[itemsKey] || [], existingMeta).items;
  const kept = existing.filter((item) => !(item.type === AUTO_SONG_TYPE && item.source === OFFLINE_SOURCE));
  const now = new Date().toISOString();
  const autoItems = offlineSegments.map((segment, index) => normalizePlaylistItem({
    startSec: segment.startSec,
    endSec: Math.max(segment.startSec + 1, segment.endSec),
    title: segment.title || `Offline Auto Song #${index + 1}`,
    type: AUTO_SONG_TYPE,
    confidence: segment.confidence,
    provisional: false,
    detectorVersion: OFFLINE_DETECTOR_VERSION,
    source: OFFLINE_SOURCE,
    sourceSegmentId: segment.sourceSegmentId,
    splitBy: segment.splitBy,
    splitSourceSegmentIndex: segment.splitSourceSegmentIndex,
    splitPartIndex: segment.splitPartIndex,
    splitPartCount: segment.splitPartCount,
    boundaryConfidence: segment.boundaryConfidence,
    boundaryReasons: segment.boundaryReasons,
    medleySplit: segment.medleySplit,
    createdAt: now,
    updatedAt: now,
  }, kept.length + index));
  const nextItems = [...kept, ...autoItems].sort(sortPlaylistItems);
  const nextMeta = buildPlaylistMeta(nextItems, existingMeta, {
    title: offlineTitle.value.trim() || existingMeta.title || null,
    lastModified: now,
    lastAnalyzedAt: now,
    detectorVersion: OFFLINE_DETECTOR_VERSION,
    source: 'offlineAudio',
    finalSegments: offlineSegments,
    provisionalSegments: [],
    boundaryDetectorVersion: offlineBoundarySplit?.detectorVersion || null,
    boundarySegments: offlineBoundarySplit?.boundaries || [],
  });
  await writePlaylistStorage(() => chrome.storage.local.set({ [itemsKey]: serializePlaylist(nextItems), [metaKey]: nextMeta }));
  setStatus(storageStatus, `Storage: saved ${videoId}`);
  setStatus(offlineStatus, tr('saved_segments_to', [autoItems.length, videoId]));
  setActiveView('global');
  await refreshGlobalPlaylist();
  await refreshDatabaseEditor();
}

function buildSongRow(videoId, videoTitle, item, videoOrder, itemOrder) {
  const title = item.title || (item.type === AUTO_SONG_TYPE ? 'Auto Song' : 'Untitled');
  const startSec = Number(item.startSec) || 0;
  const endSec = Math.max(startSec, Number(item.endSec) || startSec);
  return { libraryId: `${videoId}::${item.id || itemOrder}::${videoOrder}-${itemOrder}`, sourceItemId: item.id || null, videoId, videoTitle, title, type: item.type || 'manual', startSec, endSec, durationSec: Math.max(0, endSec - startSec), confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null, videoOrder, itemOrder };
}

async function resolveVideoTitle(videoId, meta = {}) {
  const storedTitle = String(meta.title || '').trim();
  if (storedTitle) return storedTitle;
  if (videoTitleCache.has(videoId)) return videoTitleCache.get(videoId);
  let title = '未命名影片';
  try {
    const response = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    const data = await response.json();
    if (data && typeof data.title === 'string' && data.title.trim()) title = data.title.trim();
  } catch (error) {
    // Keep the UI free of raw video ids when title lookup is unavailable.
  }
  videoTitleCache.set(videoId, title);
  return title;
}

async function refreshGlobalPlaylist() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith('playlist_') && !key.startsWith('playlist_meta_'));
  const rows = [];
  for (let videoOrder = 0; videoOrder < keys.length; videoOrder += 1) {
    const key = keys[videoOrder];
    const videoId = key.replace('playlist_', '');
    const meta = all[`playlist_meta_${videoId}`] || {};
    const videoTitle = await resolveVideoTitle(videoId, meta);
    normalizePlaylist(all[key] || [], meta).items.forEach((item, itemOrder) => rows.push(buildSongRow(videoId, videoTitle, item, videoOrder, itemOrder)));
  }
  cachedSongRows = rows;
  renderGlobalPlaylist();
  renderQueue();
}

function renderGlobalPlaylist() {
  const rows = getFilteredSongRows();
  globalPlaylistList.innerHTML = '';
  if (!rows.length) {
    globalPlaylistList.innerHTML = `<div class="song-row empty-row"><div class="song-media-group"><div class="song-drag-placeholder"></div><div class="song-media placeholder-media">-</div></div><div><div class="song-title-line"><span class="song-title">${escapeHtml(tr('no_songs'))}</span></div><div class="song-meta">${escapeHtml(tr('no_playlist_items'))}</div></div></div>`;
    return;
  }
  if (libraryGrouped) {
    for (const group of groupRowsByVideo(rows)) {
      const element = document.createElement('div');
      element.className = 'song-row video-group-row';
      element.dataset.videoId = group.videoId;
      const matchedText = group.matchedRows.length === group.totalRows ? songsLabel(group.totalRows) : tr('matched_count', [group.matchedRows.length, group.totalRows]);
      element.innerHTML = `<div class="song-media-group"><button class="song-drag-handle" type="button" aria-label="${escapeHtml(tr('drag_whole_playlist'))}" title="${escapeHtml(tr('drag_whole_playlist'))}"><span class="queue-grip" aria-hidden="true">⋮⋮</span></button><div class="song-media"><img class="song-thumb" src="${thumbnailUrl(group.videoId)}" alt=""></div></div><div><div class="song-title-line"><span class="song-title">${escapeHtml(group.videoTitle)}</span><span class="song-time">${escapeHtml(matchedText)}</span></div><div class="song-meta"><span>${escapeHtml(tr('drag_add_whole_playlist'))}</span><span>${formatSeconds(group.totalDurationSec)}</span></div></div>`;
      globalPlaylistList.appendChild(element);
    }
    return;
  }
  for (const row of rows) {
    const element = document.createElement('div');
    element.className = 'song-row';
    element.dataset.libraryId = row.libraryId;
    element.innerHTML = `<div class="song-media-group"><button class="song-drag-handle" type="button" aria-label="${escapeHtml(tr('drag_song_to_queue'))}" title="${escapeHtml(tr('drag_song_to_queue'))}"><span class="queue-grip" aria-hidden="true">⋮⋮</span></button><div class="song-media"><img class="song-thumb" src="${thumbnailUrl(row.videoId)}" alt=""></div></div><div><div class="song-title-line"><span class="song-title">${escapeHtml(row.title)}</span><span class="song-time">${formatRange(row.startSec, row.endSec)}</span></div><div class="song-meta"><span>${escapeHtml(row.videoTitle)}</span></div></div>`;
    globalPlaylistList.appendChild(element);
  }
}

function getSelectedDatabaseVideo() {
  return databaseVideos.find((video) => video.videoId === selectedDatabaseVideoId) || null;
}

function getFilteredDatabaseVideos() {
  const query = (databaseSearch?.value || '').trim().toLowerCase();
  if (!query) return databaseVideos;
  return databaseVideos.filter((video) => [
    video.videoId,
    video.title,
    video.resolvedTitle,
  ].some((value) => String(value || '').toLowerCase().includes(query)));
}

async function refreshDatabaseEditor({ keepSelection = true } = {}) {
  const previousSelection = selectedDatabaseVideoId;
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith('playlist_') && !key.startsWith('playlist_meta_'));
  const nextVideos = [];
  const rebuildPatch = {};

  for (let order = 0; order < keys.length; order += 1) {
    const key = keys[order];
    const videoId = key.replace('playlist_', '');
    const metaKey = playlistMetaStorageKey(videoId);
    const meta = all[metaKey] || {};
    const normalized = normalizePlaylist(all[key] || [], meta);
    const resolvedTitle = await resolveVideoTitle(videoId, meta);
    const title = String(meta.title || resolvedTitle || '').trim() || tr('untitled_video');

    nextVideos.push({
      videoId,
      title,
      resolvedTitle,
      meta,
      items: normalized.items,
      order,
    });

    if (normalized.rebuilt) {
      const now = new Date().toISOString();
      rebuildPatch[key] = serializePlaylist(normalized.items);
      rebuildPatch[metaKey] = buildPlaylistMeta(normalized.items, meta, { rebuiltAt: now, lastModified: now });
    }
  }

  databaseVideos = nextVideos;
  if (Object.keys(rebuildPatch).length) await writePlaylistStorage(() => chrome.storage.local.set(rebuildPatch));

  if (!keepSelection || !databaseVideos.some((video) => video.videoId === previousSelection)) {
    selectedDatabaseVideoId = databaseVideos[0]?.videoId || null;
  } else {
    selectedDatabaseVideoId = previousSelection;
  }

  renderDatabaseVideoList();
  renderDatabaseEditor();
}

function renderDatabaseVideoList() {
  if (!databaseVideoList) return;
  const videos = getFilteredDatabaseVideos();
  databaseVideoList.innerHTML = '';

  if (!videos.length) {
    databaseVideoList.innerHTML = `<div class="database-video-row empty-row"><div class="song-media placeholder-media">-</div><div><div class="song-title-line"><span class="song-title">${escapeHtml(tr('no_data'))}</span></div><div class="song-meta">${escapeHtml(tr('no_editable_database'))}</div></div></div>`;
    return;
  }

  for (const video of videos) {
    const totalDurationSec = video.items.reduce((sum, item) => sum + segmentDuration(item), 0);
    const row = document.createElement('div');
    row.className = `database-video-row${video.videoId === selectedDatabaseVideoId ? ' active' : ''}`;
    row.dataset.videoId = video.videoId;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.innerHTML = `<div class="song-media"><img class="song-thumb" src="${thumbnailUrl(video.videoId)}" alt=""></div><div><div class="song-title-line"><span class="song-title">${escapeHtml(video.title)}</span><span class="song-time">${escapeHtml(songsLabel(video.items.length))}</span></div><div class="song-meta"><span>${formatSeconds(totalDurationSec)}</span></div></div><button class="database-delete-btn" type="button" data-delete-db-video-id="${escapeHtml(video.videoId)}">${escapeHtml(tr('delete'))}</button>`;
    databaseVideoList.appendChild(row);
  }
}

function selectDatabaseVideo(videoId) {
  if (!databaseVideos.some((video) => video.videoId === videoId)) return;
  selectedDatabaseVideoId = videoId;
  renderDatabaseVideoList();
  renderDatabaseEditor();
}

function renderDatabaseEditor() {
  if (!databaseTrackList) return;
  const video = getSelectedDatabaseVideo();
  databaseTrackList.innerHTML = '';
  databaseAddItemBtn.disabled = !video;
  databaseItemCountBadge.textContent = songsLabel(video ? video.items.length : 0);

  if (!video) {
    databaseEditorCover.src = emptyCoverUrl();
    databaseEditorCover.classList.add('is-empty');
    databaseTitleText.textContent = tr('select_left_video');
    setStatus(databaseStatus, '');
    databaseTrackList.innerHTML = `<div class="database-track-row empty-row"><div class="database-drag-placeholder"></div><div><div class="song-title-line"><span class="song-title">${escapeHtml(tr('select_left_video'))}</span></div><div class="song-meta">${escapeHtml(tr('select_left_video_detail'))}</div></div></div>`;
    return;
  }

  databaseEditorCover.src = thumbnailUrl(video.videoId);
  databaseEditorCover.classList.remove('is-empty');
  databaseTitleText.textContent = video.title;

  if (!video.items.length) {
    databaseTrackList.innerHTML = `<div class="database-track-row empty-row"><div class="database-drag-placeholder"></div><div><div class="song-title-line"><span class="song-title">${escapeHtml(tr('empty_database_playlist'))}</span></div><div class="song-meta">${escapeHtml(tr('add_first_segment'))}</div></div></div>`;
    return;
  }

  video.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'database-track-row';
    row.dataset.itemId = item.id;
    const typeLabel = item.type === AUTO_SONG_TYPE ? 'auto-song' : 'manual';
    row.innerHTML = `<button class="database-drag-handle" type="button" aria-label="${escapeHtml(tr('drag_reorder_segment'))}" title="${escapeHtml(tr('drag_reorder_segment'))}"><span class="queue-grip" aria-hidden="true">⋮⋮</span></button><div class="database-track-fields"><input class="database-track-title" data-db-field="title" data-item-id="${escapeHtml(item.id)}" type="text" value="${escapeHtml(item.title || '')}" placeholder="${escapeHtml(tr('song_title_placeholder'))}"><div class="database-time-fields"><label>Start <input data-db-field="startSec" data-item-id="${escapeHtml(item.id)}" type="text" value="${formatSeconds(item.startSec)}"></label><label>End <input data-db-field="endSec" data-item-id="${escapeHtml(item.id)}" type="text" value="${formatSeconds(item.endSec)}"></label><span class="song-type ${item.type === AUTO_SONG_TYPE ? 'auto-song' : ''}">#${index + 1} ${typeLabel}</span></div></div><button class="database-delete-btn" type="button" data-delete-db-item-id="${escapeHtml(item.id)}">${escapeHtml(tr('delete'))}</button>`;
    databaseTrackList.appendChild(row);
  });
}

async function persistDatabaseVideo(videoId, { status = null } = {}) {
  const video = databaseVideos.find((item) => item.videoId === videoId);
  if (!video) throw new Error(tr('selected_database_missing'));
  const now = new Date().toISOString();
  video.items = video.items.map((item, index) => normalizePlaylistItem({ ...item, updatedAt: item.updatedAt || now }, index, video.meta));
  const title = String(video.title || '').trim();
  const nextMeta = buildPlaylistMeta(video.items, video.meta, { title: title || null, lastModified: now });
  await writePlaylistStorage(() => chrome.storage.local.set({
    [playlistStorageKey(videoId)]: serializePlaylist(video.items),
    [playlistMetaStorageKey(videoId)]: nextMeta,
  }));
  video.meta = nextMeta;
  video.title = title || video.resolvedTitle || tr('untitled_video');
  setStatus(databaseStatus, status || tr('saved_status'));
  renderDatabaseVideoList();
  await refreshGlobalPlaylist();
}

async function addDatabaseItem() {
  const video = getSelectedDatabaseVideo();
  if (!video) return;
  const now = new Date().toISOString();
  const previous = video.items[video.items.length - 1];
  const startSec = previous ? Math.max(0, Number(previous.endSec) || 0) : 0;
  const item = normalizePlaylistItem({
    startSec,
    endSec: startSec + 60,
    title: tr('new_song'),
    createdAt: now,
    updatedAt: now,
  }, video.items.length, video.meta);
  video.items.push(item);
  await persistDatabaseVideo(video.videoId, { status: tr('item_added') });
  renderDatabaseEditor();
}

async function updateDatabaseTrackField(input) {
  const video = getSelectedDatabaseVideo();
  if (!video) return;
  const item = video.items.find((entry) => entry.id === input.dataset.itemId);
  if (!item) return;
  const field = input.dataset.dbField;
  const now = new Date().toISOString();
  const previousDuration = Math.max(1, item.endSec - item.startSec);

  if (field === 'title') {
    item.title = input.value.trim() || tr('untitled_item');
  } else if (field === 'startSec') {
    item.startSec = parseTimeField(input.value, item.startSec);
    if (item.endSec <= item.startSec) item.endSec = item.startSec + previousDuration;
  } else if (field === 'endSec') {
    item.endSec = Math.max(item.startSec + 1, parseTimeField(input.value, item.endSec));
  }

  item.updatedAt = now;
  await persistDatabaseVideo(video.videoId, { status: tr('item_saved') });
  renderDatabaseEditor();
}

async function deleteDatabaseItem(itemId) {
  const video = getSelectedDatabaseVideo();
  if (!video) return;
  const item = video.items.find((entry) => entry.id === itemId);
  if (!item) return;
  if (!window.confirm(tr('delete_item_confirm', [item.title || tr('untitled_item')]))) return;
  video.items = video.items.filter((entry) => entry.id !== itemId);
  await persistDatabaseVideo(video.videoId, { status: tr('item_deleted') });
  renderDatabaseEditor();
}

async function deleteDatabaseVideo(videoId) {
  const video = databaseVideos.find((item) => item.videoId === videoId);
  if (!video) return;
  if (!window.confirm(tr('delete_database_confirm', [video.title]))) return;
  await writePlaylistStorage(() => chrome.storage.local.remove([playlistStorageKey(videoId), playlistMetaStorageKey(videoId)]));
  if (selectedDatabaseVideoId === videoId) selectedDatabaseVideoId = null;
  await refreshDatabaseEditor({ keepSelection: false });
  await refreshGlobalPlaylist();
  showToast(`已刪除：${video.title}`);
}

async function syncDatabaseOrderFromDom() {
  const video = getSelectedDatabaseVideo();
  if (!video) return;
  const orderedIds = Array.from(databaseTrackList.querySelectorAll('.database-track-row[data-item-id]')).map((row) => row.dataset.itemId);
  const nextItems = orderedIds.map((id) => video.items.find((item) => item.id === id)).filter(Boolean);
  if (nextItems.length !== video.items.length) { renderDatabaseEditor(); return; }
  video.items = nextItems;
  await persistDatabaseVideo(video.videoId, { status: tr('order_saved') });
  renderDatabaseEditor();
}

function getDatabaseDragAfterElement(y) {
  const rows = Array.from(databaseTrackList.querySelectorAll('.database-track-row[data-item-id]:not(.database-dragging)'));
  return rows.reduce((closest, row) => {
    const box = row.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: row };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function moveDatabaseDragGhost(event) {
  if (!databaseDrag) return;
  databaseDrag.ghost.style.left = `${event.clientX - databaseDrag.offsetX}px`;
  databaseDrag.ghost.style.top = `${event.clientY - databaseDrag.offsetY}px`;
  const afterElement = getDatabaseDragAfterElement(event.clientY);
  if (afterElement) databaseTrackList.insertBefore(databaseDrag.itemElement, afterElement);
  else databaseTrackList.appendChild(databaseDrag.itemElement);
}

async function finishDatabaseDrag() {
  if (!databaseDrag) return;
  const { itemElement, ghost } = databaseDrag;
  itemElement.classList.remove('database-dragging');
  ghost.remove();
  document.body.style.cursor = '';
  document.removeEventListener('pointermove', moveDatabaseDragGhost);
  databaseDrag = null;
  await syncDatabaseOrderFromDom();
}

function startDatabaseDrag(event) {
  const handle = event.target.closest('.database-drag-handle');
  const row = event.target.closest('.database-track-row[data-item-id]');
  const video = getSelectedDatabaseVideo();
  if (!handle || !row || !video || event.button !== 0 || video.items.length < 2) return;
  event.preventDefault();
  const rect = row.getBoundingClientRect();
  const ghost = row.cloneNode(true);
  ghost.classList.add('queue-drag-ghost');
  Object.assign(ghost.style, {
    position: 'fixed',
    width: `${rect.width}px`,
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  document.body.appendChild(ghost);
  row.classList.add('database-dragging');
  document.body.style.cursor = 'grabbing';
  databaseDrag = {
    itemElement: row,
    ghost,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  document.addEventListener('pointermove', moveDatabaseDragGhost);
  document.addEventListener('pointerup', () => runDatabaseAction(finishDatabaseDrag), { once: true });
}

async function runDatabaseAction(action) {
  try {
    await action();
  } catch (error) {
    const message = error?.message || String(error);
    setStatus(databaseStatus, message);
    showToast(message, { warning: true });
  }
}

function cloneForQueue(row) { return { ...row, queueId: makeQueueId() }; }
function findSongRow(libraryId) { return cachedSongRows.find((row) => row.libraryId === libraryId) || null; }
async function persistQueue() { await chrome.storage.local.set({ [QUEUE_STORAGE_KEY]: serializeQueueItems(queueItems) }); }
async function restoreQueue() { const result = await chrome.storage.local.get(QUEUE_STORAGE_KEY); queueItems = (Array.isArray(result[QUEUE_STORAGE_KEY]) ? result[QUEUE_STORAGE_KEY] : []).filter((item) => item && item.videoId && Number.isFinite(Number(item.startSec))).map(cloneForQueue); renderQueue(); }
async function persistSavedQueues() { await chrome.storage.local.set({ [SAVED_QUEUES_STORAGE_KEY]: savedQueues }); }
async function restoreSavedQueues() {
  const result = await chrome.storage.local.get(SAVED_QUEUES_STORAGE_KEY);
  savedQueues = (Array.isArray(result[SAVED_QUEUES_STORAGE_KEY]) ? result[SAVED_QUEUES_STORAGE_KEY] : []).filter((list) => list && list.id && Array.isArray(list.items));
  renderSavedQueueSelect();
}
function renderSavedQueueSelect() {
  savedQueueSelect.innerHTML = '';
  loadQueueBtn.disabled = savedQueues.length === 0;
  deleteSavedQueueBtn.disabled = savedQueues.length === 0;
  if (!savedQueues.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = tr('no_saved_lists');
    savedQueueSelect.appendChild(option);
    return;
  }
  for (const list of savedQueues) {
    const option = document.createElement('option');
    option.value = list.id;
    option.textContent = `${list.name} (${list.items.length})`;
    savedQueueSelect.appendChild(option);
  }
}
async function saveNamedQueue() {
  if (!queueItems.length) { showToast(tr('queue_empty_cannot_save'), { warning: true }); return; }
  const name = queueNameInput.value.trim() || `Queue ${new Date().toLocaleString()}`;
  const now = new Date().toISOString();
  let list = savedQueues.find((item) => item.name === name);
  const snapshotItems = serializeQueueItems(queueItems);
  if (list) {
    list.items = snapshotItems;
    list.updatedAt = now;
  } else {
    list = { id: `saved-${Date.now()}`, name, items: snapshotItems, createdAt: now, updatedAt: now };
    savedQueues.push(list);
  }
  await persistSavedQueues();
  renderSavedQueueSelect();
  savedQueueSelect.value = list.id;
  showToast(tr('queue_saved', [name]));
}
async function loadNamedQueue() {
  const list = savedQueues.find((item) => item.id === savedQueueSelect.value);
  if (!list) { showToast(tr('no_queue_to_load'), { warning: true }); return; }
  if (playbackState.playing) await stopQueuePlayback({ reason: tr('loaded_another_queue'), closePlaybackTabs: true, silentToast: true });
  queueItems = list.items.filter((item) => item && item.videoId && Number.isFinite(Number(item.startSec))).map(cloneForQueue);
  await persistQueue();
  renderQueue();
  showToast(tr('queue_loaded', [list.name]));
}
async function deleteNamedQueue() {
  const id = savedQueueSelect.value;
  const list = savedQueues.find((item) => item.id === id);
  if (!list) return;
  savedQueues = savedQueues.filter((item) => item.id !== id);
  await persistSavedQueues();
  renderSavedQueueSelect();
  showToast(tr('queue_deleted', [list.name]));
}
async function addSongToQueue(libraryId) { const row = findSongRow(libraryId); if (!row) return; queueItems.push(cloneForQueue(row)); await persistQueue(); renderQueue(); }
async function addVideoSongsToQueue(videoId) {
  const rows = rowsForVideo(videoId);
  if (!rows.length) return;
  queueItems.push(...rows.map(cloneForQueue));
  await persistQueue();
  renderQueue();
  showToast(tr('queue_added_video', [rows.length, rows[0].videoTitle]));
}
async function insertRowsIntoQueue(rows, index) {
  const validRows = rows.filter(Boolean);
  if (!validRows.length) return;
  const insertIndex = Math.max(0, Math.min(queueItems.length, Number(index) || 0));
  queueItems.splice(insertIndex, 0, ...validRows.map(cloneForQueue));
  if (playbackState.activeQueueId) playbackState.activeIndex = queueItems.findIndex((item) => item.queueId === playbackState.activeQueueId);
  await persistQueue();
  renderQueue();
  const label = validRows.length === 1 ? validRows[0].title : `${validRows[0].videoTitle} / ${songsLabel(validRows.length)}`;
  setStatus(queueStatus, tr('queue_inserted_at', [insertIndex + 1, label]));
}
async function removeQueueItem(queueId) { queueItems = queueItems.filter((item) => item.queueId !== queueId); await persistQueue(); renderQueue(); }
function shuffledCopy(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}
async function shuffleQueue() {
  if (queueItems.length < 2) return;
  if (playbackState.playing && playbackState.activeIndex >= 0) {
    const lockedItems = queueItems.slice(0, playbackState.activeIndex + 1);
    const pendingItems = shuffledCopy(queueItems.slice(playbackState.activeIndex + 1));
    queueItems = lockedItems.concat(pendingItems);
  } else {
    queueItems = shuffledCopy(queueItems);
  }
  if (playbackState.activeQueueId) playbackState.activeIndex = queueItems.findIndex((item) => item.queueId === playbackState.activeQueueId);
  await persistQueue();
  renderQueue();
  setStatus(queueStatus, tr('shuffled'));
}
async function clearQueue() {
  if (!queueItems.length) return;
  if (!window.confirm(tr('delete_queue_confirm'))) return;
  if (playbackState.playing) await stopQueuePlayback({ reason: tr('stopped'), silentToast: true });
  queueItems = [];
  await persistQueue();
  renderQueue();
  setStatus(queueStatus, '');
}

function renderQueue() {
  queueCountBadge.textContent = songsLabel(queueItems.length);
  clearQueueBtn.disabled = !queueItems.length || playbackState.playing;
  queueList.innerHTML = '';
  if (!queueItems.length) {
    queueList.innerHTML = `<div class="queue-row empty-row"><div class="queue-media-group"><div class="queue-drag-placeholder"></div><div class="queue-media placeholder-media">-</div></div><div><div class="queue-title-line"><span class="queue-title">${escapeHtml(tr('queue_empty'))}</span></div><div class="queue-meta">${escapeHtml(tr('drag_songs_here'))}</div></div><button class="queue-action" type="button" disabled>${escapeHtml(tr('remove'))}</button></div>`;
    renderPlayer();
    return;
  }
  queueItems.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `queue-row${playbackState.activeQueueId === item.queueId ? ' playing' : ''}`;
    row.dataset.queueId = item.queueId;
    row.innerHTML = `<div class="queue-media-group"><button class="queue-drag-handle" type="button" aria-label="${escapeHtml(tr('drag_reorder_queue'))}" title="${escapeHtml(tr('drag_reorder_queue'))}"><span class="queue-grip" aria-hidden="true">⋮⋮</span></button><div class="queue-media"><img class="queue-thumb" src="${thumbnailUrl(item.videoId)}" alt=""></div></div><div><div class="queue-title-line"><span class="queue-title">${escapeHtml(item.title)}</span><span class="queue-time">${formatRange(item.startSec, item.endSec)}</span></div><div class="queue-meta"><span>${escapeHtml(item.videoTitle)}</span></div></div><button class="queue-action" type="button" data-remove-queue-id="${escapeHtml(item.queueId)}">${escapeHtml(tr('remove'))}</button>`;
    queueList.appendChild(row);
  });
  renderPlayer();
}

function renderPlayer() {
  const item = currentQueueItem();
  if (!item) {
    nowPlayingCover.src = emptyCoverUrl();
    nowPlayingCover.classList.add('is-empty');
    nowPlayingTitle.textContent = tr('no_track_selected');
    nowPlayingVideoTitle.textContent = tr('drag_songs_to_queue');
    nowPlayingTime.textContent = '--:--';
    playPauseBtn.dataset.state = 'play';
    shuffleQueueBtn.disabled = true;
    prevTrackBtn.disabled = true;
    playPauseBtn.disabled = true;
    nextTrackBtn.disabled = true;
    stopQueueBtn.disabled = true;
    return;
  }

  nowPlayingCover.src = thumbnailUrl(item.videoId);
  nowPlayingCover.classList.remove('is-empty');
  nowPlayingTitle.textContent = item.title;
  nowPlayingVideoTitle.textContent = item.videoTitle;
  nowPlayingTime.textContent = formatRange(item.startSec, item.endSec);
  playPauseBtn.dataset.state = playbackState.playing && !playbackState.paused ? 'pause' : 'play';
  shuffleQueueBtn.disabled = queueItems.length < 2;
  prevTrackBtn.disabled = queueItems.length < 2 || (playbackState.playing && playbackState.activeIndex <= 0);
  playPauseBtn.disabled = false;
  nextTrackBtn.disabled = queueItems.length < 2 || (playbackState.playing && playbackState.activeIndex >= queueItems.length - 1);
  stopQueueBtn.disabled = !playbackState.playing;
}

async function syncQueueOrderFromDom() {
  const orderedIds = Array.from(queueList.querySelectorAll('.queue-row[data-queue-id]')).map((row) => row.dataset.queueId);
  const nextItems = orderedIds.map((id) => queueItems.find((item) => item.queueId === id)).filter(Boolean);
  if (nextItems.length !== queueItems.length) { renderQueue(); return; }
  queueItems = nextItems;
  if (playbackState.activeQueueId) playbackState.activeIndex = queueItems.findIndex((item) => item.queueId === playbackState.activeQueueId);
  await persistQueue();
  renderQueue();
}

function getQueueDragAfterElement(y) {
  const rows = Array.from(queueList.querySelectorAll('.queue-row[data-queue-id]:not(.queue-dragging)'));
  return rows.reduce((closest, row) => {
    const box = row.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: row };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function moveQueueDragGhost(event) {
  if (!queueDrag) return;
  queueDrag.ghost.style.left = `${event.clientX - queueDrag.offsetX}px`;
  queueDrag.ghost.style.top = `${event.clientY - queueDrag.offsetY}px`;
  const afterElement = getQueueDragAfterElement(event.clientY);
  if (afterElement) queueList.insertBefore(queueDrag.itemElement, afterElement);
  else queueList.appendChild(queueDrag.itemElement);
}

async function finishQueueDrag() {
  if (!queueDrag) return;
  const { itemElement, ghost } = queueDrag;
  itemElement.classList.remove('queue-dragging');
  ghost.remove();
  document.body.style.cursor = '';
  document.removeEventListener('pointermove', moveQueueDragGhost);
  queueDrag = null;
  await syncQueueOrderFromDom();
}

function startQueueDrag(event) {
  const handle = event.target.closest('.queue-drag-handle');
  const row = event.target.closest('.queue-row[data-queue-id]');
  if (!handle || !row || event.button !== 0 || queueItems.length < 2) return;
  event.preventDefault();
  const rect = row.getBoundingClientRect();
  const ghost = row.cloneNode(true);
  ghost.classList.add('queue-drag-ghost');
  Object.assign(ghost.style, {
    position: 'fixed',
    width: `${rect.width}px`,
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  document.body.appendChild(ghost);
  row.classList.add('queue-dragging');
  document.body.style.cursor = 'grabbing';
  queueDrag = {
    itemElement: row,
    ghost,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  document.addEventListener('pointermove', moveQueueDragGhost);
  document.addEventListener('pointerup', () => runQueueAction(finishQueueDrag), { once: true });
}

function getLibraryDragRows(row) {
  if (row.dataset.videoId) return rowsForVideo(row.dataset.videoId);
  const item = findSongRow(row.dataset.libraryId);
  return item ? [item] : [];
}

function getQueueDropIndex(clientX, clientY) {
  const rect = queueList.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
  const rows = Array.from(queueList.querySelectorAll('.queue-row[data-queue-id]:not(.queue-dragging)'));
  if (!rows.length) return 0;
  for (let index = 0; index < rows.length; index += 1) {
    const rowRect = rows[index].getBoundingClientRect();
    if (clientY < rowRect.top + rowRect.height / 2) return index;
  }
  return rows.length;
}

function removeLibraryDropPreview() {
  queueList.querySelector('.library-drop-preview')?.remove();
}

function createLibraryDropPreview(rows) {
  const first = rows[0];
  const isGroup = rows.length > 1;
  const title = isGroup ? first.videoTitle : first.title;
  const timeText = isGroup ? `${rows.length} songs` : formatRange(first.startSec, first.endSec);
  const metaText = isGroup ? `整場歌單 ${formatSeconds(rows.reduce((sum, row) => sum + segmentDuration(row), 0))}` : first.videoTitle;
  const preview = document.createElement('div');
  preview.className = 'queue-row library-drop-preview';
  preview.innerHTML = `<div class="queue-media-group"><button class="queue-drag-handle" type="button" disabled aria-label="插入位置預覽"><span class="queue-grip" aria-hidden="true">⋮⋮</span></button><div class="queue-media"><img class="queue-thumb" src="${thumbnailUrl(first.videoId)}" alt=""></div></div><div><div class="queue-title-line"><span class="queue-title">${escapeHtml(title)}</span><span class="queue-time">${escapeHtml(timeText)}</span></div><div class="queue-meta"><span>${escapeHtml(metaText)}</span></div></div><button class="queue-action" type="button" disabled>Insert</button>`;
  return preview;
}

function updateLibraryDropPreview(index) {
  removeLibraryDropPreview();
  if (!Number.isInteger(index)) return;
  const preview = createLibraryDropPreview(libraryDrag.rows);
  const rows = Array.from(queueList.querySelectorAll('.queue-row[data-queue-id]'));
  const beforeElement = rows[index] || (rows.length ? null : queueList.querySelector('.empty-row'));
  if (beforeElement) queueList.insertBefore(preview, beforeElement);
  else queueList.appendChild(preview);
}

function moveLibraryDragGhost(event) {
  if (!libraryDrag) return;
  libraryDrag.ghost.style.left = `${event.clientX - libraryDrag.offsetX}px`;
  libraryDrag.ghost.style.top = `${event.clientY - libraryDrag.offsetY}px`;
  libraryDrag.dropIndex = getQueueDropIndex(event.clientX, event.clientY);
  updateLibraryDropPreview(libraryDrag.dropIndex);
}

async function finishLibraryDrag() {
  if (!libraryDrag) return;
  const { sourceElement, ghost, rows, dropIndex } = libraryDrag;
  sourceElement.classList.remove('library-dragging');
  ghost.remove();
  document.body.style.cursor = '';
  document.removeEventListener('pointermove', moveLibraryDragGhost);
  libraryDrag = null;
  removeLibraryDropPreview();
  if (Number.isInteger(dropIndex)) await insertRowsIntoQueue(rows, dropIndex);
}

function startLibraryDrag(event) {
  const handle = event.target.closest('.song-drag-handle');
  const row = event.target.closest('.song-row[data-library-id], .video-group-row[data-video-id]');
  if (!handle || !row || event.button !== 0) return;
  const rows = getLibraryDragRows(row);
  if (!rows.length) return;
  event.preventDefault();
  const rect = row.getBoundingClientRect();
  const ghost = row.cloneNode(true);
  ghost.classList.add('library-drag-ghost');
  Object.assign(ghost.style, {
    position: 'fixed',
    width: `${rect.width}px`,
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  document.body.appendChild(ghost);
  row.classList.add('library-dragging');
  document.body.style.cursor = 'grabbing';
  libraryDrag = {
    sourceElement: row,
    rows,
    ghost,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    dropIndex: null,
  };
  document.addEventListener('pointermove', moveLibraryDragGhost);
  document.addEventListener('pointerup', () => runQueueAction(finishLibraryDrag), { once: true });
}

function getYoutubeUrl(item) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}&t=${Math.max(0, Math.floor(Number(item.startSec) || 0))}s&autoplay=1`;
}

async function sendQueueControl(tabId, patch = {}) {
  const response = await chrome.tabs.sendMessage(tabId, { action: 'workbenchQueueControl', patch });
  if (!response || !response.success) throw new Error(response?.message || 'YouTube player is not ready.');
  return response;
}

function isTransientQueueControlError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('receiving end does not exist')
    || message.includes('message channel closed')
    || message.includes('asynchronous response')
    || message.includes('extension context invalidated')
    || message.includes('no youtube video element')
    || message.includes('youtube player is not ready');
}

function tabUrlMatchesVideo(url, videoId) {
  if (!videoId) return true;
  try {
    const parsed = new URL(url || '');
    return parsed.searchParams.get('v') === videoId || parsed.pathname.includes(`/${videoId}`);
  } catch (error) {
    return false;
  }
}

async function waitForQueueTabReady(tabId, expectedVideoId = null, timeoutMs = 20000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (expectedVideoId && !tabUrlMatchesVideo(tab.url, expectedVideoId)) {
        await wait(250);
        continue;
      }
      if (tab.status === 'loading') {
        await wait(250);
        continue;
      }
      const snapshot = await sendQueueControl(tabId, {});
      if (expectedVideoId && snapshot.videoId !== expectedVideoId) {
        await wait(250);
        continue;
      }
      return snapshot;
    } catch (error) {
      lastError = error;
      if (!isTransientQueueControlError(error)) await wait(500);
      else await wait(250);
    }
  }
  throw new Error(lastError?.message || 'Timed out waiting for YouTube tab.');
}

async function getStudioWindowId() {
  try {
    const currentTab = await chrome.tabs.getCurrent();
    if (Number.isFinite(currentTab?.windowId)) return currentTab.windowId;
  } catch (error) {
    // Fall back to the current window below.
  }
  const currentWindow = await chrome.windows.getCurrent();
  if (!Number.isFinite(currentWindow?.id)) throw new Error('Failed to locate Playlist Studio window.');
  return currentWindow.id;
}

async function createPlaybackTab(item, { focused = true, preload = false } = {}) {
  const windowId = await getStudioWindowId();
  const tab = await chrome.tabs.create({
    windowId,
    url: getYoutubeUrl(item),
    active: Boolean(focused),
  });
  const tabId = tab?.id;
  if (!Number.isFinite(tabId)) throw new Error('Failed to create playback tab.');
  await waitForQueueTabReady(tabId, item.videoId);
  if (preload) {
    await sendQueueControl(tabId, { currentTime: item.startSec, muted: true, command: 'pause' }).catch(() => {});
  }
  return { windowId: tab.windowId || windowId, tabId, videoId: item.videoId, queueId: item.queueId, preload };
}

async function closeHandle(handle) {
  if (!handle?.tabId) return;
  try {
    await chrome.tabs.remove(handle.tabId);
  } catch (error) {
    // Tab was already closed.
  }
}

async function closeAllPlaybackTabs() {
  const handles = playbackState.activeHandle ? [playbackState.activeHandle] : [];
  for (const handle of playbackState.preloadHandles.values()) handles.push(handle);
  await Promise.all(handles.map(closeHandle));
}

async function ensureHandleAlive(handle) {
  if (!handle?.tabId) throw new Error('Playback tab was closed.');
  try {
    const tab = await chrome.tabs.get(handle.tabId);
    handle.windowId = tab.windowId;
  } catch (error) {
    throw new Error('Playback tab was closed by the user.');
  }
}

async function focusHandle(handle) {
  if (!handle) return;
  try {
    const tab = await chrome.tabs.get(handle.tabId);
    handle.windowId = tab.windowId;
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(handle.tabId, { active: true });
  } catch (error) {
    // Tab may have been closed between checks.
  }
}

async function navigateHandle(handle, item) {
  await chrome.tabs.update(handle.tabId, { url: getYoutubeUrl(item) });
  await waitForQueueTabReady(handle.tabId, item.videoId);
  handle.videoId = item.videoId;
  handle.queueId = item.queueId;
  return handle;
}

async function prepareActiveHandle(item, usePreload, runId) {
  if (playbackState.runId !== runId) throw new Error('Playback stopped.');
  const preloaded = playbackState.preloadHandles.get(item.queueId);
  if (usePreload && preloaded) {
    playbackState.preloadHandles.delete(item.queueId);
    const previous = playbackState.activeHandle;
    playbackState.activeHandle = preloaded;
    playbackState.activeVideoId = item.videoId;
    await focusHandle(preloaded);
    if (previous && previous.tabId !== preloaded.tabId) await closeHandle(previous);
    return preloaded;
  }
  if (!playbackState.activeHandle) {
    playbackState.activeHandle = await createPlaybackTab(item, { focused: true });
    playbackState.activeVideoId = item.videoId;
    return playbackState.activeHandle;
  }
  await ensureHandleAlive(playbackState.activeHandle);
  if (playbackState.activeVideoId !== item.videoId) {
    if (usePreload) {
      const previous = playbackState.activeHandle;
      playbackState.activeHandle = await createPlaybackTab(item, { focused: true });
      playbackState.activeVideoId = item.videoId;
      await closeHandle(previous);
    } else {
      await navigateHandle(playbackState.activeHandle, item);
      playbackState.activeVideoId = item.videoId;
    }
  }
  playbackState.activeHandle.queueId = item.queueId;
  return playbackState.activeHandle;
}

async function preloadUpcomingTabs(currentIndex, currentTimeSec, runId) {
  if (!advancedPreloadToggle.checked || playbackState.runId !== runId) return;
  const currentItem = queueItems[currentIndex];
  if (!currentItem) return;
  const preloadLookaheadSec = getAdvancedPreloadLookaheadSec();
  let secondsUntilTransition = Math.max(0, currentItem.endSec - currentTimeSec);
  for (let nextIndex = currentIndex + 1; nextIndex < queueItems.length; nextIndex += 1) {
    if (secondsUntilTransition > preloadLookaheadSec) break;
    const previous = queueItems[nextIndex - 1];
    const next = queueItems[nextIndex];
    if (next.videoId !== previous.videoId && !playbackState.preloadHandles.has(next.queueId)) {
      try {
        playbackState.preloadHandles.set(next.queueId, await createPlaybackTab(next, { focused: false, preload: true }));
        setStatus(queueStatus, `Preloaded ${next.title}`);
      } catch (error) {
        showToast(`預開緩衝失敗：${error?.message || String(error)}`, { warning: true });
      }
    }
    secondsUntilTransition += Math.max(0, next.endSec - next.startSec);
  }
}

async function playQueue(startIndex = 0) {
  if (!queueItems.length || playbackState.playing) return;
  const runId = playbackState.runId + 1;
  playbackState = { ...createIdlePlaybackState(), runId, playing: true };
  stopQueueBtn.disabled = false;
  clearQueueBtn.disabled = true;
  setStatus(queueStatus, advancedPreloadToggle.checked ? 'Playing with advanced preload...' : 'Playing with page navigation...');

  try {
    for (let index = Math.max(0, Math.min(queueItems.length - 1, Number(startIndex) || 0)); index < queueItems.length;) {
      if (playbackState.runId !== runId) break;
      const item = queueItems[index];
      playbackState.activeIndex = index;
      playbackState.activeQueueId = item.queueId;
      playbackState.pausedPolls = 0;
      playbackState.requestedIndex = null;
      playbackState.paused = false;
      renderQueue();

      const handle = await prepareActiveHandle(item, advancedPreloadToggle.checked, runId);
      await ensureHandleAlive(handle);
      await sendQueueControl(handle.tabId, { currentTime: item.startSec, muted: false, command: 'play' });
      const playCommandAt = Date.now();
      setStatus(queueStatus, `Playing ${index + 1}/${queueItems.length}: ${item.title}`);

      while (playbackState.runId === runId) {
        await wait(PLAYBACK_POLL_MS);
        await ensureHandleAlive(handle);

        if (Number.isInteger(playbackState.requestedIndex)) {
          index = Math.max(0, Math.min(queueItems.length - 1, playbackState.requestedIndex));
          break;
        }

        const snapshot = await sendQueueControl(handle.tabId, {});
        if (snapshot.paused) {
          if (playbackState.paused) {
            playbackState.pausedPolls = 0;
            continue;
          } else if (Date.now() - playCommandAt < 3500) {
            playbackState.pausedPolls = 0;
            continue;
          } else {
            playbackState.pausedPolls += 1;
            if (playbackState.pausedPolls >= 3) throw new Error('Playback was paused by the user or browser.');
          }
        } else {
          playbackState.pausedPolls = 0;
        }
        const currentTime = Number(snapshot.currentTime) || 0;
        await preloadUpcomingTabs(index, currentTime, runId);
        if (snapshot.ended || currentTime >= item.endSec) break;
      }

      if (Number.isInteger(playbackState.requestedIndex)) {
        index = Math.max(0, Math.min(queueItems.length - 1, playbackState.requestedIndex));
        playbackState.requestedIndex = null;
      } else {
        index += 1;
      }
    }

    if (playbackState.runId === runId) {
      await stopQueuePlayback({ reason: 'Queue finished.', closePlaybackTabs: true, silentToast: true });
      showToast('播放佇列已完成。');
    }
  } catch (error) {
    if (playbackState.runId === runId) {
      await stopQueuePlayback({ reason: error?.message || String(error), closePlaybackTabs: true, warning: true });
    }
  }
}

async function stopQueuePlayback({ reason = 'Stopped.', closePlaybackTabs = true, warning = false, silentToast = false } = {}) {
  const wasPlaying = playbackState.playing;
  playbackState.runId += 1;
  playbackState.playing = false;
  playbackState.paused = false;
  playbackState.activeIndex = -1;
  playbackState.requestedIndex = null;
  playbackState.activeQueueId = null;
  if (closePlaybackTabs) await closeAllPlaybackTabs();
  playbackState.activeHandle = null;
  playbackState.activeVideoId = null;
  playbackState.preloadHandles = new Map();
  playbackState.pausedPolls = 0;
  stopQueueBtn.disabled = true;
  clearQueueBtn.disabled = false;
  setStatus(queueStatus, reason);
  renderQueue();
  if (wasPlaying && !silentToast) showToast(reason, { warning });
}

async function togglePlayPause() {
  if (!queueItems.length) return;
  if (!playbackState.playing) {
    await playQueue(0);
    return;
  }
  if (!playbackState.activeHandle) return;

  if (playbackState.paused) {
    playbackState.paused = false;
    await sendQueueControl(playbackState.activeHandle.tabId, { command: 'play' });
    setStatus(queueStatus, `Playing ${playbackState.activeIndex + 1}/${queueItems.length}`);
  } else {
    playbackState.paused = true;
    await sendQueueControl(playbackState.activeHandle.tabId, { command: 'pause' });
    setStatus(queueStatus, 'Paused.');
  }
  renderPlayer();
}

async function jumpToQueueIndex(index) {
  if (!queueItems.length) return;
  const target = Math.max(0, Math.min(queueItems.length - 1, index));
  if (!playbackState.playing) {
    await playQueue(target);
    return;
  }
  playbackState.paused = false;
  playbackState.requestedIndex = target;
  renderPlayer();
}

async function playPreviousTrack() {
  const current = playbackState.playing ? playbackState.activeIndex : 0;
  await jumpToQueueIndex(current - 1);
}

async function playNextTrack() {
  const current = playbackState.playing ? playbackState.activeIndex : -1;
  await jumpToQueueIndex(current + 1);
}

async function runQueueAction(action) {
  try {
    await action();
  } catch (error) {
    const message = error?.message || String(error);
    setStatus(queueStatus, message);
    showToast(message, { warning: true });
    renderPlayer();
  }
}

window.YTJDev = {
  ...(window.YTJDev || {}),
  getLanguageState: () => ({
    activeLanguage: resolveWorkbenchLanguage(),
    userLanguage: normalizeLanguagePreference(userPreferences.language),
    previewOverride: localePreviewOverride,
  }),
  setLanguagePreview: (language) => {
    localePreviewOverride = normalizeLanguagePreference(language);
    applyWorkbenchLanguage();
    return window.YTJDev.getLanguageState();
  },
  clearLanguagePreview: () => {
    localePreviewOverride = 'auto';
    applyWorkbenchLanguage();
    return window.YTJDev.getLanguageState();
  },
  setLanguage: async (language) => {
    localePreviewOverride = 'auto';
    await saveUserPreferences({ language });
    renderSettingsForm({ minSegmentDurationSec: offlineMinSegmentSec?.value || DEFAULT_MIN_SEGMENT_DURATION_SEC });
    return window.YTJDev.getLanguageState();
  },
};

function bindEvents() {
  sidebarToggle.addEventListener('click', () => {
    const collapsed = appShell.classList.toggle('sidebar-collapsed');
    sidebarToggle.setAttribute('aria-label', collapsed ? tr('sidebar_expand') : tr('sidebar_collapse'));
    sidebarToggle.title = collapsed ? tr('sidebar_expand') : tr('sidebar_collapse');
  });
  for (const item of navItems) item.addEventListener('click', () => setActiveView(item.dataset.view));
  offlineAnalyzeBtn.addEventListener('click', analyzeOfflineAudio);
  offlineSaveBtn.addEventListener('click', saveOfflineSegments);
  offlineMinSegmentSec.addEventListener('change', () => {
    const value = normalizeMinSegmentDurationSec(readNumberInput(offlineMinSegmentSec, DEFAULT_MIN_SEGMENT_DURATION_SEC));
    offlineMinSegmentSec.value = String(value);
    if (settingsMinSegmentSec) settingsMinSegmentSec.value = String(value);
    saveSongDetectionConfig({ minSegmentDurationSec: value })
      .catch((error) => showToast(tr('settings_save_failed', [error?.message || String(error)]), { warning: true }));
  });
  offlineSplitMedleyToggle.addEventListener('change', () => {
    saveUserPreferences({ offlineSplitMedleyDefault: Boolean(offlineSplitMedleyToggle.checked) })
      .then(() => renderSettingsForm({ minSegmentDurationSec: offlineMinSegmentSec.value }))
      .catch((error) => showToast(tr('settings_save_failed', [error?.message || String(error)]), { warning: true }));
  });
  refreshGlobalBtn.addEventListener('click', refreshGlobalPlaylist);
  refreshDatabaseBtn.addEventListener('click', () => runDatabaseAction(() => refreshDatabaseEditor()));
  databaseSearch.addEventListener('input', renderDatabaseVideoList);
  databaseVideoList.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-delete-db-video-id]');
    if (deleteButton) {
      event.stopPropagation();
      runDatabaseAction(() => deleteDatabaseVideo(deleteButton.dataset.deleteDbVideoId));
      return;
    }
    const row = event.target.closest('.database-video-row[data-video-id]');
    if (!row) return;
    selectDatabaseVideo(row.dataset.videoId);
  });
  databaseVideoList.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('.database-video-row[data-video-id]');
    if (!row) return;
    event.preventDefault();
    selectDatabaseVideo(row.dataset.videoId);
  });
  databaseAddItemBtn.addEventListener('click', () => runDatabaseAction(addDatabaseItem));
  databaseTrackList.addEventListener('change', (event) => {
    const input = event.target.closest('[data-db-field][data-item-id]');
    if (input) runDatabaseAction(() => updateDatabaseTrackField(input));
  });
  databaseTrackList.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-delete-db-item-id]');
    if (deleteButton) runDatabaseAction(() => deleteDatabaseItem(deleteButton.dataset.deleteDbItemId));
  });
  databaseTrackList.addEventListener('pointerdown', startDatabaseDrag);
  groupToggleBtn.addEventListener('click', () => {
    libraryGrouped = !libraryGrouped;
    groupToggleBtn.textContent = libraryGrouped ? tr('expand') : tr('collapse');
    groupToggleBtn.setAttribute('aria-pressed', String(libraryGrouped));
    renderGlobalPlaylist();
  });
  globalSearch.addEventListener('input', renderGlobalPlaylist);
  shuffleQueueBtn.addEventListener('click', () => runQueueAction(shuffleQueue));
  prevTrackBtn.addEventListener('click', () => runQueueAction(playPreviousTrack));
  playPauseBtn.addEventListener('click', () => runQueueAction(togglePlayPause));
  nextTrackBtn.addEventListener('click', () => runQueueAction(playNextTrack));
  advancedPreloadToggle.addEventListener('change', () => {
    saveUserPreferences({ advancedPreloadDefault: Boolean(advancedPreloadToggle.checked) })
      .then(() => renderSettingsForm({ minSegmentDurationSec: offlineMinSegmentSec.value }))
      .catch((error) => showToast(tr('settings_save_failed', [error?.message || String(error)]), { warning: true }));
  });
  stopQueueBtn.addEventListener('click', () => runQueueAction(() => stopQueuePlayback({ reason: 'Stopped by user.', closePlaybackTabs: true })));
  clearQueueBtn.addEventListener('click', () => runQueueAction(clearQueue));
  saveQueueBtn.addEventListener('click', () => runQueueAction(saveNamedQueue));
  loadQueueBtn.addEventListener('click', () => runQueueAction(loadNamedQueue));
  deleteSavedQueueBtn.addEventListener('click', () => runQueueAction(deleteNamedQueue));
  globalPlaylistList.addEventListener('pointerdown', startLibraryDrag);
  queueList.addEventListener('click', async (event) => {
    const removeButton = event.target.closest('[data-remove-queue-id]');
    if (removeButton) await runQueueAction(() => removeQueueItem(removeButton.dataset.removeQueueId));
  });
  queueList.addEventListener('pointerdown', startQueueDrag);
  saveSettingsBtn?.addEventListener('click', () => {
    saveSettingsFromForm().catch((error) => {
      const message = tr('settings_save_failed', [error?.message || String(error)]);
      setStatus(settingsStatus, message);
      showToast(message, { warning: true });
    });
  });
  settingsLanguageSelect?.addEventListener('change', () => {
    saveSettingsFromForm().catch((error) => {
      const message = tr('settings_save_failed', [error?.message || String(error)]);
      setStatus(settingsStatus, message);
      showToast(message, { warning: true });
    });
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && Object.keys(changes).some((key) => key.startsWith('playlist_'))) {
      if (suppressPlaylistStorageEvents > 0 || Date.now() - lastInternalPlaylistWriteAt < 1000) return;
      schedulePlaylistViewsRefresh();
    }
    if (areaName === 'local' && changes[APP_PREFERENCES_KEY]) {
      userPreferences = normalizeUserPreferences(changes[APP_PREFERENCES_KEY].newValue || {});
      renderSettingsForm({ minSegmentDurationSec: offlineMinSegmentSec?.value || DEFAULT_MIN_SEGMENT_DURATION_SEC });
      applyWorkbenchLanguage();
    }
  });
}

async function init() {
  await loadUserPreferences();
  bindEvents();
  applyWorkbenchLanguage();
  setActiveView('global');
  setStatus(modelStatus, globalThis.ort ? 'Model: ONNX Runtime loaded' : 'Model: ONNX Runtime missing');
  const detectionConfig = await loadSongDetectionConfig();
  offlineMinSegmentSec.value = String(normalizeMinSegmentDurationSec(detectionConfig.minSegmentDurationSec));
  offlineSplitMedleyToggle.checked = Boolean(userPreferences.offlineSplitMedleyDefault);
  advancedPreloadToggle.checked = Boolean(userPreferences.advancedPreloadDefault);
  renderSettingsForm(detectionConfig);
  await refreshGlobalPlaylist();
  await refreshDatabaseEditor();
  await restoreSavedQueues();
  await restoreQueue();
}

init().catch((error) => {
  setStatus(offlineStatus, `Init error: ${error?.message || String(error)}`);
  showToast(`Studio init error: ${error?.message || String(error)}`, { warning: true });
});
