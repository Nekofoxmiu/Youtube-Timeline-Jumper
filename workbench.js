import { FIRERED_AED_DETECTOR_VERSION } from './lib/songDetection/fireredAedDetector.js';
import { splitSongSegmentsByBoundaries } from './lib/songDetection/boundaryDetector.js';
import { smoothFireRedAnalyses } from './lib/songDetection/globalSmoothing.js';
import { AUTO_SONG_TYPE, buildPlaylistMeta, formatSeconds, normalizePlaylist, normalizePlaylistItem, parseTimeToken, serializePlaylist } from './lib/playlistCore.js';
import { decodeM4aFileWithWebCodecs, decodeM4aWithWebCodecs, loadM4aAudioSourceFromFile } from './lib/audio/mp4AacWebCodecsDecoder.js';

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
const OFFLINE_LONG_AUDIO_THRESHOLD_SEC = 60 * 60;
const OFFLINE_LONG_AUDIO_CHUNK_SEC = 60 * 60;
const OFFLINE_LONG_AUDIO_OVERLAP_SEC = 90;
const OFFLINE_UI_PROGRESS_THROTTLE_MS = 250;
const OFFLINE_WORKER_SAMPLE_RATE = 16000;
const OFFLINE_TRANSFER_COPY_CHUNK_FRAMES = OFFLINE_WORKER_SAMPLE_RATE * 20;
const OFFLINE_WAVEFORM_MIN_ZOOM = 1;
const OFFLINE_WAVEFORM_MAX_ZOOM = 64;
const OFFLINE_VISUAL_GAIN_MAX = 4;
const OFFLINE_VIEW_SCROLL_MAX = 10000;
const OFFLINE_AUDIO_DEBUG_KEY = 'ytjOfflineAudioDebug';
const OFFLINE_AUDIO_DEBUG_BUFFER_MAX = 300;
const OFFLINE_SUPPORTED_AUDIO_EXTENSIONS = new Set(['m4a', 'mp4']);
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
    settings_visual_editor: 'Generate waveform/spectrogram editor by default for offline analysis',
    settings_high_resolution_visuals: 'Enable high-resolution spectrogram by default for offline analysis',
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
    offline_supported_formats: 'Only .m4a and .mp4 are supported.',
    start_seconds: 'Start seconds',
    end_seconds: 'End seconds',
    end_seconds_placeholder: 'Blank means end of file',
    save_to_video_id: 'Save to videoId',
    video_id_example: 'Example: -25jwY-5MT7I',
    display_title: 'Display title',
    optional_playlist_meta: 'Optional, saved to playlist meta',
    split_medley_label: 'Split medley',
    visual_editor_label: 'Waveform/spectrogram editor',
    high_resolution_visuals_label: 'High-resolution spectrogram',
    analyze_local_audio: 'Analyze Local Audio',
    pause_analysis: 'Pause',
    resume_analysis: 'Resume',
    stop_analysis: 'Stop',
    run_medley_split: 'Run Medley Split',
    save_segments: 'Save Segments',
    save_all_segments: 'Save All',
    offline_batch_queue: 'Batch Queue',
    offline_batch_empty: 'Select one or more audio files to create batch jobs.',
    offline_batch_selected: 'Selected',
    offline_batch_queued: 'Queued',
    offline_batch_running: 'Running',
    offline_batch_done: 'Done',
    offline_batch_error: 'Error',
    offline_batch_saved: 'Saved',
    offline_delete_batch_confirm: 'Delete batch job "$1"?',
    offline_batch_deleted: 'Batch job deleted.',
    offline_batch_stopped: 'Stopped',
    offline_batch_paused: 'Paused',
    offline_multi_file_eyebrow: 'Multi-file setup',
    offline_multi_file_staging_notice: 'Multiple supported files selected. Each file will become an independent batch job; shared videoId, title, start, and end fields will not be applied.',
    offline_multi_file_notice: 'Multiple files were added as independent jobs. Select each row to edit its videoId, title, range, and save target before saving.',
    offline_multi_file_setup_progress: 'Set target videoId for each file before analysis: $1/$2 ready.',
    offline_multi_file_requires_setup: 'Fill videoId for each selected file first, or use "Skip setup" for full-file analysis without save targets.',
    offline_skip_multi_setup: 'Skip setup, analyze full files',
    offline_analysis_paused: 'Offline analysis paused.',
    offline_analysis_resumed: 'Offline analysis resumed.',
    offline_analysis_stopped: 'Offline analysis stopped.',
    offline_runtime: 'Runtime: $1',
    offline_runtime_wasm_threads: 'WASM $1 thread(s)',
    offline_runtime_webgpu: 'WebGPU',
    offline_runtime_wasm_fallback: 'WASM fallback',
    offline_player_eyebrow: 'Waveform Editor',
    offline_player_title: 'Audio Player',
    offline_view_spectrogram: 'Spectrogram',
    offline_view_waveform: 'Waveform',
    offline_follow_playhead: 'Follow playhead',
    offline_volume: 'Volume',
    offline_visual_gain: 'Gain',
    offline_waveform_empty: 'Waveform and detected segments will appear after analysis.',
    offline_waveform_hint: 'Click to seek, drag segments to edit timing, scroll to pan, Ctrl+scroll to zoom, and double-click empty space to add a segment.',
    offline_audio_unavailable: 'This audio file cannot be played directly here, but waveform editing is still available.',
    offline_delete_segment_confirm: 'Delete "$1"?',
    offline_segment_added: 'Segment added.',
    offline_segment_deleted: 'Segment deleted.',
    offline_manual_edits_confirm: 'This will rebuild detected segments and discard waveform edits for the selected job. Continue?',
    offline_no_queued_jobs: 'There are no queued jobs to analyze.',
    offline_play: 'Play',
    offline_pause: 'Pause',
    boundary_keep_split: 'Keep split',
    boundary_split_applied: 'Medley split applied: $1 boundary candidate(s).',
    boundary_split_no_candidates: 'No medley boundary candidates found.',
    boundary_split_requires_done: 'Analyze the selected job before running medley split.',
    saved_all_segments: 'Saved $1 batch job(s).',
    batch_job_needs_video_id: 'Batch job "$1" needs a videoId before saving.',
    refresh_failed: 'Refresh failed: $1',
    select_audio_file: 'Select an audio file first.',
    unsupported_offline_audio_file: 'Unsupported audio file "$1". Offline analysis currently accepts only .m4a and .mp4.',
    unsupported_offline_audio_files: '$1 unsupported file(s) were ignored. Offline analysis currently accepts only .m4a and .mp4.',
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
    settings_visual_editor: '離線分析預設產生波型 / 頻譜編輯器',
    settings_high_resolution_visuals: '離線分析預設啟用高解析頻譜圖',
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
    offline_supported_formats: '僅支援 .m4a 與 .mp4。',
    start_seconds: '開始秒數',
    end_seconds: '結束秒數',
    end_seconds_placeholder: '留空代表檔案結尾',
    save_to_video_id: '儲存到 videoId',
    video_id_example: '例如 -25jwY-5MT7I',
    display_title: '顯示標題',
    optional_playlist_meta: '可選，寫入 playlist meta',
    split_medley_label: '串燒切分',
    visual_editor_label: '波型 / 頻譜編輯器',
    high_resolution_visuals_label: '高解析頻譜圖',
    analyze_local_audio: '分析本機音訊',
    pause_analysis: '暫停',
    resume_analysis: '繼續',
    stop_analysis: '停止',
    run_medley_split: '執行串燒切分',
    save_segments: '儲存片段',
    save_all_segments: '全部儲存',
    offline_batch_queue: '批次佇列',
    offline_batch_empty: '選擇一個或多個音訊檔以建立批次工作。',
    offline_batch_selected: '已選取',
    offline_batch_queued: '等待中',
    offline_batch_running: '分析中',
    offline_batch_done: '完成',
    offline_batch_error: '錯誤',
    offline_batch_saved: '已儲存',
    offline_delete_batch_confirm: '刪除批次工作「$1」？',
    offline_batch_deleted: '批次工作已刪除。',
    offline_batch_stopped: '已停止',
    offline_batch_paused: '已暫停',
    offline_multi_file_eyebrow: '多檔設定',
    offline_multi_file_staging_notice: '已選取多個支援檔案。每個檔案會建立獨立批次工作；共用的 videoId、標題、開始與結束欄位不會套用。',
    offline_multi_file_notice: '已將多個檔案加入為獨立工作。儲存前請逐列選取並編輯 videoId、標題與分析範圍。',
    offline_multi_file_setup_progress: '分析前請為每個檔案設定目標 videoId：$1/$2 已完成。',
    offline_multi_file_requires_setup: '請先為每個選取檔案填入 videoId，或使用「跳過設定」直接全檔辨識。',
    offline_skip_multi_setup: '跳過設定，全檔辨識',
    offline_analysis_paused: '離線分析已暫停。',
    offline_analysis_resumed: '離線分析已繼續。',
    offline_analysis_stopped: '離線分析已停止。',
    offline_runtime: '執行後端：$1',
    offline_runtime_wasm_threads: 'WASM $1 執行緒',
    offline_runtime_webgpu: 'WebGPU',
    offline_runtime_wasm_fallback: 'WASM fallback',
    offline_player_eyebrow: '波型編輯',
    offline_player_title: '音訊播放器',
    offline_view_spectrogram: '頻譜圖',
    offline_view_waveform: '波型圖',
    offline_follow_playhead: '跟隨播放位置',
    offline_volume: '音量',
    offline_visual_gain: '增益',
    offline_waveform_empty: '分析完成後會顯示波型與偵測片段。',
    offline_waveform_hint: '點擊可跳轉，拖曳片段可調整時間，滾輪平移，Ctrl+滾輪縮放，雙擊空白處可新增片段。',
    offline_audio_unavailable: '此音訊檔無法在頁面中直接播放，但仍可使用波型編輯。',
    offline_delete_segment_confirm: '刪除「$1」？',
    offline_segment_added: '已新增片段。',
    offline_segment_deleted: '已刪除片段。',
    offline_manual_edits_confirm: '這會重建偵測片段並覆蓋目前選取工作的波型編輯，是否繼續？',
    offline_no_queued_jobs: '目前沒有等待分析的工作。',
    offline_play: '播放',
    offline_pause: '暫停',
    boundary_keep_split: '保留切分',
    boundary_split_applied: '已套用串燒切分：$1 個候選切點。',
    boundary_split_no_candidates: '沒有找到串燒切分候選點。',
    boundary_split_requires_done: '請先完成選取工作的分析再執行串燒切分。',
    saved_all_segments: '已儲存 $1 個批次工作。',
    batch_job_needs_video_id: '批次工作「$1」需要 videoId 才能儲存。',
    refresh_failed: '重新整理失敗：$1',
    select_audio_file: '請先選擇音訊檔。',
    unsupported_offline_audio_file: '不支援的音訊檔「$1」。離線分析目前只接受 .m4a 與 .mp4。',
    unsupported_offline_audio_files: '已忽略 $1 個不支援的檔案。離線分析目前只接受 .m4a 與 .mp4。',
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
const offlinePauseBtn = $('offlinePauseBtn');
const offlineStopBtn = $('offlineStopBtn');
const offlineSplitBtn = $('offlineSplitBtn');
const offlineSaveBtn = $('offlineSaveBtn');
const offlineSaveAllBtn = $('offlineSaveAllBtn');
const offlineSplitMedleyToggle = $('offlineSplitMedleyToggle');
const offlineVisualEditorToggle = $('offlineVisualEditorToggle');
const offlineHighResolutionToggle = $('offlineHighResolutionToggle');
const offlineMultiFileStaging = $('offlineMultiFileStaging');
const offlineMultiFileStatus = $('offlineMultiFileStatus');
const offlineMultiFileTabs = $('offlineMultiFileTabs');
const offlineSkipMultiSetupBtn = $('offlineSkipMultiSetupBtn');
const offlineProgressBar = $('offlineProgressBar');
const offlineStatus = $('offlineStatus');
const offlineRuntimeStatus = $('offlineRuntimeStatus');
const offlineSummary = $('offlineSummary');
const offlinePlayerPanel = $('offlinePlayerPanel');
const offlineAudioPlayer = $('offlineAudioPlayer');
const offlinePlayPauseBtn = $('offlinePlayPauseBtn');
const offlineSpectrogramModeBtn = $('offlineSpectrogramModeBtn');
const offlineWaveformModeBtn = $('offlineWaveformModeBtn');
const offlineFollowPlayheadToggle = $('offlineFollowPlayheadToggle');
const offlineVolumeSlider = $('offlineVolumeSlider');
const offlineVisualGainSlider = $('offlineVisualGainSlider');
const offlineZoomOutBtn = $('offlineZoomOutBtn');
const offlineZoomInBtn = $('offlineZoomInBtn');
const offlinePlayerTime = $('offlinePlayerTime');
const offlineWaveformShell = $('offlineWaveformShell');
const offlineWaveformCanvas = $('offlineWaveformCanvas');
const offlineWaveformOverlay = $('offlineWaveformOverlay');
const offlinePlayhead = $('offlinePlayhead');
const offlineViewScrollBar = $('offlineViewScrollBar');
const offlineWaveformEmpty = $('offlineWaveformEmpty');
const offlineSegmentEditor = $('offlineSegmentEditor');
const offlineSegmentTitleInput = $('offlineSegmentTitleInput');
const offlineSegmentStartInput = $('offlineSegmentStartInput');
const offlineSegmentEndInput = $('offlineSegmentEndInput');
const offlineDeleteSegmentBtn = $('offlineDeleteSegmentBtn');
const offlineBatchCount = $('offlineBatchCount');
const offlineBatchList = $('offlineBatchList');
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
const settingsVisualEditorDefault = $('settingsVisualEditorDefault');
const settingsHighResolutionDefault = $('settingsHighResolutionDefault');
const settingsAdvancedPreloadDefault = $('settingsAdvancedPreloadDefault');
const settingsAdvancedPreloadLookaheadSec = $('settingsAdvancedPreloadLookaheadSec');
const saveSettingsBtn = $('saveSettingsBtn');
const settingsStatus = $('settingsStatus');

let offlineSegments = [];
let offlineBoundarySplit = null;
let offlineBatchJobs = [];
let selectedOfflineJobId = null;
let offlineBatchRunning = false;
let offlineBatchControl = {
  paused: false,
  stopped: false,
  currentAbortController: null,
  currentJobId: null,
};
let offlineFormMode = 'staging';
let offlineStagedFiles = [];
let selectedOfflineStagedIndex = 0;
let offlineSegmentIdCounter = 0;
let offlineWaveformDrag = null;
let offlineWaveformResizeObserver = null;
let offlineBatchRenderQueued = false;
let offlineLastBatchRenderAt = 0;
let offlinePlaybackRafId = null;
let offlineAudioDebugLastTimeupdateAt = 0;
let offlineAudioDebugEvents = [];
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
  offlineVisualEditorDefault: true,
  offlineHighResolutionDefault: false,
  advancedPreloadDefault: false,
  advancedPreloadLookaheadSec: DEFAULT_PRELOAD_LOOKAHEAD_SEC,
};

function createIdlePlaybackState() { return { runId: 0, playing: false, paused: false, activeIndex: -1, requestedIndex: null, activeQueueId: null, activeHandle: null, activeVideoId: null, preloadHandles: new Map(), pausedPolls: 0 }; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function toFiniteNumber(value, fallback = null) { const num = Number(value); return Number.isFinite(num) ? num : fallback; }
function readNumberInput(input, fallback = null) { const text = String(input?.value || '').trim(); return text ? toFiniteNumber(text, fallback) : fallback; }
function normalizeOptionalSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, num) : null;
}
function formatSecondsInputValue(value) {
  if (value === null || value === undefined || value === '') return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return Number.isInteger(num) ? String(num) : num.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
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
function syncOfflineVisualOptionState() {
  const enabled = offlineVisualEditorToggle?.checked !== false;
  if (offlineHighResolutionToggle) {
    offlineHighResolutionToggle.disabled = !enabled;
  }
  if (settingsHighResolutionDefault) {
    settingsHighResolutionDefault.disabled = settingsVisualEditorDefault ? !settingsVisualEditorDefault.checked : false;
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
  if (offlinePlayerPanel) {
    updateOfflinePlayerButton(!offlineAudioPlayer?.paused);
    renderOfflineWaveform(getSelectedOfflineJob());
  }
  renderOfflineMultiFileStaging();
}
function normalizeUserPreferences(raw = {}) {
  return {
    ...raw,
    language: normalizeLanguagePreference(raw.language),
    offlineSplitMedleyDefault: Boolean(raw.offlineSplitMedleyDefault),
    offlineVisualEditorDefault: raw.offlineVisualEditorDefault !== false,
    offlineHighResolutionDefault: Boolean(raw.offlineHighResolutionDefault),
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
      offlineVisualEditorDefault: true,
      offlineHighResolutionDefault: false,
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
function nextAnimationFrame() {
  if (document.visibilityState !== 'visible') return wait(0);
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
function createOfflineAbortError(message = tr('offline_analysis_stopped')) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
function isOfflineAbortError(error) {
  return error?.name === 'AbortError';
}
function throwIfOfflineSignalAborted(signal) {
  if (signal?.aborted) throw createOfflineAbortError();
}
async function waitWhileOfflineBatchPaused(signal = null) {
  while (offlineBatchControl.paused && !offlineBatchControl.stopped && !signal?.aborted) {
    setStatus(offlineStatus, tr('offline_analysis_paused'));
    await wait(250);
  }
  throwIfOfflineSignalAborted(signal);
  if (offlineBatchControl.stopped) throw createOfflineAbortError();
}
function setStatus(element, message) { if (element) element.textContent = message; }
function setProgress(element, ratio) { if (element) element.style.width = `${Math.round(clamp(ratio, 0, 1) * 100)}%`; }
function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function numericSeries(value) {
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value) && typeof value.length === 'number') return value;
  return [];
}
function showToast(message, { warning = false, timeout = 4200 } = {}) { const toast = document.createElement('div'); toast.className = `toast-card${warning ? ' warning' : ''}`; toast.textContent = message; toastHost.appendChild(toast); setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(6px)'; setTimeout(() => toast.remove(), 220); }, timeout); }
function renderChips(container, items) { if (!container) return; container.innerHTML = ''; for (const item of items) { const chip = document.createElement('span'); chip.className = 'summary-chip'; chip.textContent = item; container.appendChild(chip); } }
function fileBaseName(fileName) { return String(fileName || '').replace(/\.[^.]+$/, '').trim(); }
function isLikelyYouTubeVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(value || '').trim());
}
function findYouTubeVideoIdFromBack(value) {
  const text = String(value || '');
  for (let index = text.length - 11; index >= 0; index -= 1) {
    const candidate = text.slice(index, index + 11);
    if (!isLikelyYouTubeVideoId(candidate)) continue;
    const before = index > 0 ? text.charAt(index - 1) : '';
    const after = index + 11 < text.length ? text.charAt(index + 11) : '';
    if ((before && /[A-Za-z0-9]/.test(before)) || (after && /[A-Za-z0-9]/.test(after))) continue;
    return candidate;
  }
  return '';
}
function extractYouTubeVideoIdFromText(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const urlMatch = text.match(/(?:youtube\.com\/(?:watch\?[^#\s]*?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?=$|[^\w-])/i);
  if (urlMatch && isLikelyYouTubeVideoId(urlMatch[1])) return urlMatch[1];

  return findYouTubeVideoIdFromBack(fileBaseName(text)) || findYouTubeVideoIdFromBack(text);
}
function makeOfflineJobId() { return `offline-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function makeOfflineSegmentId() {
  offlineSegmentIdCounter += 1;
  return `offline-segment-${Date.now()}-${offlineSegmentIdCounter}-${Math.random().toString(36).slice(2, 8)}`;
}
function getSelectedOfflineJob() { return offlineBatchJobs.find((job) => job.id === selectedOfflineJobId) || null; }
function offlineStatusLabel(status) { return tr(`offline_batch_${String(status || 'queued').toLowerCase()}`); }
function formatOfflineRuntimeInfo(runtimeInfo) {
  if (!runtimeInfo || typeof runtimeInfo !== 'object') return '';
  const provider = String(runtimeInfo.executionProvider || 'wasm').toLowerCase();
  if (provider === 'webgpu') return tr('offline_runtime_webgpu');
  const threads = Number.isFinite(Number(runtimeInfo.numThreads))
    ? Math.max(1, Math.floor(Number(runtimeInfo.numThreads)))
    : 1;
  const label = tr('offline_runtime_wasm_threads', [threads]);
  return runtimeInfo.providerAttempts?.length || runtimeInfo.webGpuRunFallbackError
    ? `${label}, ${tr('offline_runtime_wasm_fallback')}`
    : label;
}
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
  if (settingsVisualEditorDefault) {
    settingsVisualEditorDefault.checked = userPreferences.offlineVisualEditorDefault !== false;
  }
  if (settingsHighResolutionDefault) {
    settingsHighResolutionDefault.checked = Boolean(userPreferences.offlineHighResolutionDefault);
    settingsHighResolutionDefault.disabled = settingsVisualEditorDefault ? !settingsVisualEditorDefault.checked : false;
  }
  if (settingsAdvancedPreloadDefault) {
    settingsAdvancedPreloadDefault.checked = Boolean(userPreferences.advancedPreloadDefault);
  }
  if (settingsAdvancedPreloadLookaheadSec) {
    settingsAdvancedPreloadLookaheadSec.value = String(normalizePreloadLookaheadSec(userPreferences.advancedPreloadLookaheadSec));
  }
  updateAdvancedPreloadLabel();
  syncOfflineVisualOptionState();
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
    offlineVisualEditorDefault: settingsVisualEditorDefault?.checked !== false,
    offlineHighResolutionDefault: Boolean(settingsVisualEditorDefault?.checked !== false && settingsHighResolutionDefault?.checked),
    advancedPreloadDefault: Boolean(settingsAdvancedPreloadDefault?.checked),
    advancedPreloadLookaheadSec,
  });

  if (offlineSplitMedleyToggle) offlineSplitMedleyToggle.checked = Boolean(userPreferences.offlineSplitMedleyDefault);
  if (offlineVisualEditorToggle) offlineVisualEditorToggle.checked = userPreferences.offlineVisualEditorDefault !== false;
  if (offlineHighResolutionToggle) offlineHighResolutionToggle.checked = Boolean(userPreferences.offlineHighResolutionDefault);
  syncOfflineVisualOptionState();
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
  if (selectedView === 'offline') requestAnimationFrame(() => renderOfflineWaveform(getSelectedOfflineJob()));
}
function segmentDuration(item) { return Math.max(0, (Number(item?.endSec) || 0) - (Number(item?.startSec) || 0)); }
function thumbnailUrl(videoId) { return `https://i.ytimg.com/vi/${encodeURIComponent(videoId || '')}/mqdefault.jpg`; }
function formatUrlSeconds(seconds) {
  const value = Math.max(0, Math.round((Number(seconds) || 0) * 1000) / 1000);
  if (Number.isInteger(value)) return String(value);
  return String(value).replace(/0+$/, '').replace(/\.$/, '');
}
function emptyCoverUrl() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"></svg>';
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
function makeQueueId() { queueIdCounter += 1; return `queue-${Date.now()}-${queueIdCounter}-${Math.random().toString(36).slice(2, 8)}`; }
function serializeQueueItems(items) { return items.map(({ queueId, ...item }) => ({ ...item })); }
function formatRange(startSec, endSec) { return `${formatSeconds(startSec)} ~ ${formatSeconds(endSec)} (${formatSeconds(Math.max(0, Number(endSec) - Number(startSec)))})`; }
function formatSecondsFixedMillis(seconds) {
  const sec = roundOfflineTime(seconds);
  const h = Math.floor(sec / 3600);
  const remainderAfterHours = sec - (h * 3600);
  const m = Math.floor(remainderAfterHours / 60);
  const s = roundOfflineTime(remainderAfterHours - (m * 60));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}
function parseTimeField(value, fallback = 0) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Number(text));
  if (/^\d+:\d{1,2}(?:\.\d+)?$/.test(text) || /^\d+:\d{1,2}:\d{1,2}(?:\.\d+)?$/.test(text)) return parseTimeToken(text);
  return fallback;
}
function roundOfflineTime(value) { return Math.round(Math.max(0, Number(value) || 0) * 1000) / 1000; }
function getOfflineWaveformRange(job) {
  const waveform = job?.waveform || null;
  const startCandidates = [
    waveform?.startSec,
    job?.startSec,
    job?.requestedStartSec,
    job?.segments?.[0]?.startSec,
    0,
  ];
  const startSec = Math.max(0, Number(startCandidates.find((value) => Number.isFinite(Number(value)))) || 0);
  const segmentEnd = Array.isArray(job?.segments) && job.segments.length
    ? Math.max(...job.segments.map((segment) => Number(segment.endSec) || 0))
    : 0;
  const playerDuration = offlineAudioPlayer
    && offlineAudioPlayer.dataset.jobId === job?.id
    && Number.isFinite(Number(offlineAudioPlayer.duration))
    ? Number(offlineAudioPlayer.duration)
    : 0;
  const endCandidates = [
    waveform?.endSec,
    job?.endSec,
    job?.requestedEndSec,
    segmentEnd,
    playerDuration,
    startSec + 60,
  ];
  let endSec = Number(endCandidates.find((value) => Number.isFinite(Number(value)) && Number(value) > startSec));
  if (!Number.isFinite(endSec) || endSec <= startSec) endSec = startSec + 60;
  return { startSec, endSec, durationSec: Math.max(1, endSec - startSec) };
}
function getOfflineWaveformZoom(job) {
  return clamp(Number(job?.waveformZoom) || 1, OFFLINE_WAVEFORM_MIN_ZOOM, OFFLINE_WAVEFORM_MAX_ZOOM);
}
function getOfflineWaveformView(job) {
  const range = getOfflineWaveformRange(job);
  const zoom = getOfflineWaveformZoom(job);
  const visibleDurationSec = Math.max(1, range.durationSec / zoom);
  const fallbackCenter = Number.isFinite(Number(job?.playbackCurrentSec))
    ? Number(job.playbackCurrentSec)
    : range.startSec + (range.durationSec / 2);
  const rawCenter = Number(job?.waveformViewCenterSec);
  const centerSec = clamp(Number.isFinite(rawCenter) ? rawCenter : fallbackCenter, range.startSec, range.endSec);
  let startSec = centerSec - (visibleDurationSec / 2);
  let endSec = centerSec + (visibleDurationSec / 2);
  if (startSec < range.startSec) {
    endSec += range.startSec - startSec;
    startSec = range.startSec;
  }
  if (endSec > range.endSec) {
    startSec -= endSec - range.endSec;
    endSec = range.endSec;
  }
  startSec = Math.max(range.startSec, startSec);
  endSec = Math.min(range.endSec, Math.max(startSec + 1, endSec));
  return { ...range, viewStartSec: startSec, viewEndSec: endSec, viewDurationSec: Math.max(1, endSec - startSec), zoom };
}
function timeToOfflineRatio(job, timeSec) {
  const view = getOfflineWaveformView(job);
  return clamp((Number(timeSec) - view.viewStartSec) / view.viewDurationSec, 0, 1);
}
function offlinePointerTime(event) {
  const job = getSelectedOfflineJob();
  if (!job || !offlineWaveformShell) return 0;
  const rect = offlineWaveformShell.getBoundingClientRect();
  const ratio = rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0;
  const view = getOfflineWaveformView(job);
  return roundOfflineTime(view.viewStartSec + (ratio * view.viewDurationSec));
}
function getSelectedOfflineSegment(job) {
  if (!job || !Array.isArray(job.segments)) return null;
  return job.segments.find((segment) => segment.id === job.selectedSegmentId) || null;
}
function ensureOfflineSegmentIds(job) {
  if (!job || !Array.isArray(job.segments)) return [];
  job.segments.forEach((segment, index) => {
    if (!segment.id) segment.id = makeOfflineSegmentId();
    if (!String(segment.title || '').trim()) segment.title = `Offline Auto Song #${index + 1}`;
  });
  if (job.selectedSegmentId && !getSelectedOfflineSegment(job)) job.selectedSegmentId = null;
  return job.segments;
}
function sortOfflineSegments(job) {
  if (!job || !Array.isArray(job.segments)) return;
  job.segments.sort((a, b) => (Number(a.startSec) || 0) - (Number(b.startSec) || 0));
}
function markOfflineManualEdit(job) {
  if (!job) return;
  job.manualEdits = true;
  job.boundarySplit = job.boundarySplit || null;
}
function revokeOfflineJobUrls(jobs) {
  for (const job of jobs || []) {
    if (job?.audioUrl) URL.revokeObjectURL(job.audioUrl);
    job.audioUrl = '';
  }
}
function updateOfflinePlayerButton(isPlaying = false) {
  if (!offlinePlayPauseBtn) return;
  offlinePlayPauseBtn.dataset.state = isPlaying ? 'pause' : 'play';
  const label = isPlaying ? tr('offline_pause') : tr('offline_play');
  offlinePlayPauseBtn.title = label;
  offlinePlayPauseBtn.setAttribute('aria-label', label);
}
function syncOfflineAudioVolume() {
  if (!offlineAudioPlayer || !offlineVolumeSlider) return;
  const volume = clamp(Number(offlineVolumeSlider.value), 0, 1);
  const nextVolume = Number.isFinite(volume) ? volume : 1;
  offlineAudioPlayer.volume = nextVolume;
  offlineAudioPlayer.muted = nextVolume <= 0;
}
function updateOfflinePlayerTime(job = getSelectedOfflineJob()) {
  if (!offlinePlayerTime) return;
  if (!job) {
    offlinePlayerTime.textContent = '00:00:00 / 00:00:00';
    return;
  }
  const range = getOfflineWaveformRange(job);
  const currentSec = Number(job?.playbackCurrentSec);
  const displayCurrent = Number.isFinite(currentSec) ? clamp(currentSec, range.startSec, range.endSec) : range.startSec;
  offlinePlayerTime.textContent = `${formatSecondsFixedMillis(displayCurrent)} / ${formatSecondsFixedMillis(range.endSec)}`;
}
function updateOfflineZoomButtons(job = getSelectedOfflineJob()) {
  const zoom = getOfflineWaveformZoom(job);
  const disabled = !job;
  if (offlineZoomOutBtn) offlineZoomOutBtn.disabled = disabled || zoom <= OFFLINE_WAVEFORM_MIN_ZOOM;
  if (offlineZoomInBtn) offlineZoomInBtn.disabled = disabled || zoom >= OFFLINE_WAVEFORM_MAX_ZOOM;
}
function updateOfflineViewScrollBar(job = getSelectedOfflineJob()) {
  if (!offlineViewScrollBar) return;
  if (!job) {
    offlineViewScrollBar.disabled = true;
    offlineViewScrollBar.value = '0';
    return;
  }
  const view = getOfflineWaveformView(job);
  const scrollableDurationSec = Math.max(0, view.durationSec - view.viewDurationSec);
  offlineViewScrollBar.disabled = scrollableDurationSec <= 0.001;
  const ratio = scrollableDurationSec > 0
    ? clamp((view.viewStartSec - view.startSec) / scrollableDurationSec, 0, 1)
    : 0;
  offlineViewScrollBar.value = String(Math.round(ratio * OFFLINE_VIEW_SCROLL_MAX));
}
function isOfflineWaveformFollowPlayhead(job = getSelectedOfflineJob()) {
  return job?.waveformFollowPlayhead !== false;
}
function updateOfflineFollowPlayheadToggle(job = getSelectedOfflineJob()) {
  if (!offlineFollowPlayheadToggle) return;
  offlineFollowPlayheadToggle.disabled = !job;
  offlineFollowPlayheadToggle.checked = Boolean(job) && isOfflineWaveformFollowPlayhead(job);
}
function setOfflineWaveformViewCenter(job, centerSec, { render = true } = {}) {
  if (!job) return;
  const view = getOfflineWaveformView(job);
  const nextCenter = clamp(Number(centerSec) || view.viewStartSec, view.startSec, view.endSec);
  job.waveformViewCenterSec = nextCenter;
  if (render) renderOfflineWaveform(job);
}
function setOfflineWaveformViewStart(job, startSec, { render = true } = {}) {
  if (!job) return;
  const view = getOfflineWaveformView(job);
  const maxStartSec = Math.max(view.startSec, view.endSec - view.viewDurationSec);
  const nextStartSec = clamp(Number(startSec) || view.startSec, view.startSec, maxStartSec);
  job.waveformViewCenterSec = nextStartSec + (view.viewDurationSec / 2);
  if (render) renderOfflineWaveform(job);
}
function setOfflineWaveformViewFromScroll(value) {
  const job = getSelectedOfflineJob();
  if (!job) return;
  const view = getOfflineWaveformView(job);
  const scrollableDurationSec = Math.max(0, view.durationSec - view.viewDurationSec);
  if (scrollableDurationSec <= 0.001) return;
  const ratio = clamp((Number(value) || 0) / OFFLINE_VIEW_SCROLL_MAX, 0, 1);
  job.waveformFollowPlayhead = false;
  setOfflineWaveformViewStart(job, view.startSec + (scrollableDurationSec * ratio));
}
function setOfflineWaveformFollowPlayhead(enabled) {
  const job = getSelectedOfflineJob();
  if (!job) return;
  job.waveformFollowPlayhead = Boolean(enabled);
  if (job.waveformFollowPlayhead) {
    const range = getOfflineWaveformRange(job);
    const current = Number.isFinite(Number(job.playbackCurrentSec))
      ? Number(job.playbackCurrentSec)
      : range.startSec;
    setOfflineWaveformViewCenter(job, current);
  } else {
    updateOfflineFollowPlayheadToggle(job);
  }
}
function maybeFollowOfflinePlayhead(job = getSelectedOfflineJob()) {
  if (!job || !isOfflineWaveformFollowPlayhead(job)) return false;
  const view = getOfflineWaveformView(job);
  const current = Number.isFinite(Number(job.playbackCurrentSec))
    ? Number(job.playbackCurrentSec)
    : view.viewStartSec;
  const ratio = (current - view.viewStartSec) / view.viewDurationSec;
  if (ratio < 0.25 || ratio > 0.75) {
    setOfflineWaveformViewCenter(job, current);
    return true;
  }
  return false;
}
function renderOfflinePlayhead(job = getSelectedOfflineJob()) {
  if (!offlinePlayhead) return;
  const ratio = job ? timeToOfflineRatio(job, job.playbackCurrentSec ?? getOfflineWaveformRange(job).startSec) : 0;
  offlinePlayhead.style.left = `${ratio * 100}%`;
  updateOfflinePlayerTime(job);
  updateOfflineZoomButtons(job);
  updateOfflineViewScrollBar(job);
}
function isOfflineAudioDebugEnabled() {
  try {
    const value = localStorage.getItem(OFFLINE_AUDIO_DEBUG_KEY);
    return value !== '0' && value !== 'false';
  } catch (error) {
    return true;
  }
}
function isOfflineAudioConsoleDebugEnabled() {
  try {
    const value = localStorage.getItem(OFFLINE_AUDIO_DEBUG_KEY);
    return value === 'console' || value === 'verbose';
  } catch (error) {
    return false;
  }
}
function serializeTimeRanges(ranges) {
  const output = [];
  if (!ranges) return output;
  for (let index = 0; index < ranges.length; index += 1) {
    output.push({
      start: Math.round(ranges.start(index) * 1000) / 1000,
      end: Math.round(ranges.end(index) * 1000) / 1000,
    });
  }
  return output;
}
function offlineAudioErrorSnapshot(error = offlineAudioPlayer?.error) {
  if (!error) return null;
  return {
    name: error.name || null,
    code: error.code || null,
    message: error.message || String(error),
  };
}
function offlineAudioDebugSnapshot(job = getSelectedOfflineJob()) {
  let range = null;
  try {
    range = job ? getOfflineWaveformRange(job) : null;
  } catch (error) {
    range = { error: error?.message || String(error) };
  }
  return {
    timestamp: new Date().toISOString(),
    visibilityState: document.visibilityState,
    selectedOfflineJobId,
    job: job ? {
      id: job.id,
      fileName: job.fileName,
      status: job.status,
      startSec: job.startSec ?? null,
      endSec: job.endSec ?? null,
      requestedStartSec: job.requestedStartSec ?? null,
      requestedEndSec: job.requestedEndSec ?? null,
      playbackCurrentSec: job.playbackCurrentSec ?? null,
      pendingPlaybackStartSec: job.pendingPlaybackStartSec ?? null,
      pendingSeekInProgress: job.pendingSeekInProgress ?? null,
      pendingPlayAfterLoad: job.pendingPlayAfterLoad ?? null,
    playbackUnavailable: job.playbackUnavailable ?? null,
    waveformFollowPlayhead: job.waveformFollowPlayhead ?? null,
    waveformZoom: job.waveformZoom ?? null,
    visualGain: job.visualGain ?? null,
    waveformViewCenterSec: job.waveformViewCenterSec ?? null,
      waveformStartSec: job.waveform?.startSec ?? null,
      waveformEndSec: job.waveform?.endSec ?? null,
      segmentCount: Array.isArray(job.segments) ? job.segments.length : null,
    } : null,
    range,
    audio: offlineAudioPlayer ? {
      datasetJobId: offlineAudioPlayer.dataset.jobId || '',
      hasSrc: Boolean(offlineAudioPlayer.getAttribute('src')),
      readyState: offlineAudioPlayer.readyState,
      networkState: offlineAudioPlayer.networkState,
      paused: offlineAudioPlayer.paused,
      ended: offlineAudioPlayer.ended,
      seeking: offlineAudioPlayer.seeking,
      currentTime: Number.isFinite(Number(offlineAudioPlayer.currentTime)) ? Number(offlineAudioPlayer.currentTime) : null,
      duration: Number.isFinite(Number(offlineAudioPlayer.duration)) ? Number(offlineAudioPlayer.duration) : null,
      buffered: serializeTimeRanges(offlineAudioPlayer.buffered),
      seekable: serializeTimeRanges(offlineAudioPlayer.seekable),
      error: offlineAudioErrorSnapshot(),
    } : null,
  };
}
function debugOfflineAudio(eventName, details = {}, { force = false } = {}) {
  if (!force && !isOfflineAudioDebugEnabled()) return;
  const event = {
    eventName,
    ...offlineAudioDebugSnapshot(),
    details,
  };
  offlineAudioDebugEvents.push(event);
  if (offlineAudioDebugEvents.length > OFFLINE_AUDIO_DEBUG_BUFFER_MAX) {
    offlineAudioDebugEvents = offlineAudioDebugEvents.slice(-OFFLINE_AUDIO_DEBUG_BUFFER_MAX);
  }
  if (force || isOfflineAudioConsoleDebugEnabled()) {
    console.debug(`[YTJ offline audio] ${eventName}`, event);
  }
}
function installOfflineAudioDebugInterface() {
  window.__ytjOfflineAudioDebug = {
    enable() {
      localStorage.setItem(OFFLINE_AUDIO_DEBUG_KEY, '1');
      debugOfflineAudio('debug-enabled');
      return 'YTJ offline audio debug buffer enabled. Use dump() to read buffered events.';
    },
    enableConsole() {
      localStorage.setItem(OFFLINE_AUDIO_DEBUG_KEY, 'console');
      debugOfflineAudio('debug-console-enabled', {}, { force: true });
      return 'YTJ offline audio console logging enabled.';
    },
    disable() {
      localStorage.setItem(OFFLINE_AUDIO_DEBUG_KEY, '0');
      return 'YTJ offline audio debug disabled.';
    },
    clear() {
      offlineAudioDebugEvents = [];
      return 'YTJ offline audio debug buffer cleared.';
    },
    dump(label = 'manual-dump') {
      debugOfflineAudio(label);
      return {
        snapshot: offlineAudioDebugSnapshot(),
        events: offlineAudioDebugEvents.slice(),
      };
    },
    dumpText(label = 'manual-dump') {
      return JSON.stringify(this.dump(label), null, 2);
    },
  };
  debugOfflineAudio('debug-interface-ready', {
    disable: `localStorage.setItem('${OFFLINE_AUDIO_DEBUG_KEY}', '0')`,
    enableBuffer: `localStorage.setItem('${OFFLINE_AUDIO_DEBUG_KEY}', '1')`,
    enableConsole: `localStorage.setItem('${OFFLINE_AUDIO_DEBUG_KEY}', 'console')`,
    dump: 'window.__ytjOfflineAudioDebug.dump()',
    dumpText: 'window.__ytjOfflineAudioDebug.dumpText()',
  });
}
function unloadOfflineAudioPlayer() {
  if (!offlineAudioPlayer) return;
  const job = getSelectedOfflineJob();
  debugOfflineAudio('unload-before', { reason: 'unloadOfflineAudioPlayer' });
  if (job && offlineAudioPlayer.dataset.jobId === job.id) {
    job.pendingPlaybackStartSec = null;
    job.pendingPlayAfterLoad = false;
  }
  offlineAudioPlayer.pause();
  offlineAudioPlayer.removeAttribute('src');
  offlineAudioPlayer.dataset.jobId = '';
  offlineAudioPlayer.load();
  updateOfflinePlayerButton(false);
  debugOfflineAudio('unload-after', { reason: 'unloadOfflineAudioPlayer' });
}
function syncOfflineAudioPlayerToJob(job) {
  if (!offlineAudioPlayer || !offlinePlayPauseBtn) return;
  debugOfflineAudio('sync-to-job', { nextJobId: job?.id || null });
  if (!job) {
    unloadOfflineAudioPlayer();
    offlinePlayPauseBtn.disabled = true;
    updateOfflinePlayerTime(null);
    updateOfflineZoomButtons(null);
    renderOfflinePlayhead(null);
    return;
  }

  if (offlineAudioPlayer.dataset.jobId !== job.id) {
    unloadOfflineAudioPlayer();
  }

  // Do not call audio.load() when merely selecting a batch row. Large m4a files can
  // block the UI while Chrome parses metadata. Load lazily when the user presses Play.
  offlinePlayPauseBtn.disabled = !job.audioUrl || Boolean(job.playbackUnavailable);
  renderOfflinePlayhead(job);
}
function ensureOfflineAudioLoaded(job) {
  debugOfflineAudio('ensure-load-enter', { jobId: job?.id || null, hasAudioUrl: Boolean(job?.audioUrl) });
  if (!offlineAudioPlayer || !job || !job.audioUrl) return false;
  if (offlineAudioPlayer.dataset.jobId === job.id && offlineAudioPlayer.getAttribute('src')) {
    syncOfflineAudioVolume();
    debugOfflineAudio('ensure-load-reuse', { jobId: job.id });
    return true;
  }
  unloadOfflineAudioPlayer();
  job.playbackUnavailable = false;
  offlineAudioPlayer.src = job.audioUrl;
  offlineAudioPlayer.dataset.jobId = job.id;
  syncOfflineAudioVolume();
  offlineAudioPlayer.load();
  debugOfflineAudio('ensure-load-after-load', { jobId: job.id });
  return true;
}
function isFatalOfflineAudioPlaybackError(error) {
  const name = String(error?.name || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  const mediaErrorCode = offlineAudioPlayer?.error?.code || 0;
  const sourceNotSupportedCode = typeof MediaError !== 'undefined' && Number(MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)
    ? Number(MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)
    : 4;
  return name.includes('notsupported')
    || message.includes('not supported')
    || message.includes('no supported source')
    || mediaErrorCode === sourceNotSupportedCode;
}
function setOfflineAudioCurrentTime(job, timeSec) {
  if (!job || !offlineAudioPlayer || offlineAudioPlayer.dataset.jobId !== job.id) {
    debugOfflineAudio('set-current-time-skip', { reason: 'job-or-player-mismatch', targetSec: timeSec });
    return false;
  }
  if (offlineAudioPlayer.readyState < HTMLMediaElement.HAVE_METADATA) {
    debugOfflineAudio('set-current-time-wait-metadata', { targetSec: timeSec });
    return false;
  }
  const boundedTime = clamp(
    Number(timeSec) || 0,
    0,
    Math.max(Number(timeSec) || 0, Number(offlineAudioPlayer.duration) || 0)
  );
  const currentTime = Number(offlineAudioPlayer.currentTime);
  if (Number.isFinite(currentTime) && Math.abs(currentTime - boundedTime) < 0.05) {
    job.playbackCurrentSec = boundedTime;
    debugOfflineAudio('set-current-time-noop', { targetSec: timeSec, boundedTime, currentTime });
    return true;
  }
  try {
    offlineAudioPlayer.currentTime = boundedTime;
  } catch (error) {
    debugOfflineAudio('set-current-time-failed', { targetSec: timeSec, boundedTime, error: error?.message || String(error) });
    return false;
  }
  job.playbackCurrentSec = boundedTime;
  debugOfflineAudio('set-current-time-ok', { targetSec: timeSec, boundedTime });
  return true;
}
function hasOfflinePendingSeek(job) {
  const value = job?.pendingPlaybackStartSec;
  return value !== null
    && value !== undefined
    && value !== ''
    && Number.isFinite(Number(value));
}
function applyOfflinePendingSeek(job) {
  if (!hasOfflinePendingSeek(job)) return true;
  const pendingTime = Number(job.pendingPlaybackStartSec);
  if (job.pendingSeekInProgress) {
    debugOfflineAudio('apply-pending-seek-skip-reentrant', { pendingTime });
    return false;
  }
  debugOfflineAudio('apply-pending-seek-enter', { pendingTime });
  job.pendingSeekInProgress = true;
  job.pendingPlaybackStartSec = null;
  try {
    if (!setOfflineAudioCurrentTime(job, pendingTime)) {
      job.pendingPlaybackStartSec = pendingTime;
      debugOfflineAudio('apply-pending-seek-deferred', { pendingTime });
      return false;
    }
    debugOfflineAudio('apply-pending-seek-done', { pendingTime });
    return true;
  } finally {
    job.pendingSeekInProgress = false;
  }
}
function getOfflinePlaybackTargetSec(job) {
  const range = getOfflineWaveformRange(job);
  const mediaCurrent = offlineAudioPlayer
    && offlineAudioPlayer.dataset.jobId === job?.id
    && Number.isFinite(Number(offlineAudioPlayer.currentTime))
    ? Number(offlineAudioPlayer.currentTime)
    : null;
  if (Number.isFinite(mediaCurrent) && mediaCurrent > 0) {
    const target = clamp(mediaCurrent, range.startSec, range.endSec);
    debugOfflineAudio('playback-target-media-current', { mediaCurrent, target });
    return target;
  }
  const current = Number(job?.playbackCurrentSec);
  const target = Number.isFinite(current)
    ? clamp(current, range.startSec, range.endSec)
    : range.startSec;
  debugOfflineAudio('playback-target-job-current', { current, target });
  return target;
}
function startOfflinePlaybackRaf() {
  if (offlinePlaybackRafId) return;
  const tick = () => {
    offlinePlaybackRafId = null;
    handleOfflineAudioTimeUpdate();
    if (offlineAudioPlayer && !offlineAudioPlayer.paused) {
      offlinePlaybackRafId = requestAnimationFrame(tick);
    }
  };
  offlinePlaybackRafId = requestAnimationFrame(tick);
}
function stopOfflinePlaybackRaf() {
  if (!offlinePlaybackRafId) return;
  cancelAnimationFrame(offlinePlaybackRafId);
  offlinePlaybackRafId = null;
}
function seekOfflinePlayer(timeSec, { autoplay = false, centerView = false } = {}) {
  const job = getSelectedOfflineJob();
  if (!job) return;
  const range = getOfflineWaveformRange(job);
  const nextTime = roundOfflineTime(clamp(Number(timeSec) || range.startSec, range.startSec, range.endSec));
  debugOfflineAudio('seek-request', { timeSec, autoplay, centerView, nextTime });
  job.playbackCurrentSec = nextTime;
  if (centerView || (autoplay && isOfflineWaveformFollowPlayhead(job))) {
    job.waveformViewCenterSec = nextTime;
  }
  if (autoplay && offlineAudioPlayer && !offlineAudioPlayer.getAttribute('src')) {
    ensureOfflineAudioLoaded(job);
  }
  if (offlineAudioPlayer && offlineAudioPlayer.dataset.jobId === job.id && offlineAudioPlayer.getAttribute('src') && !job.playbackUnavailable) {
    job.pendingPlaybackStartSec = nextTime;
    applyOfflinePendingSeek(job);
    if (autoplay) {
      job.pendingPlayAfterLoad = false;
      offlineAudioPlayer.play().catch(() => {});
    }
  }
  renderOfflinePlayhead(job);
}
function clearOfflineWaveformCanvas() {
  if (!offlineWaveformCanvas) return;
  const context = offlineWaveformCanvas.getContext('2d');
  if (!context) return;
  const rect = offlineWaveformCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  offlineWaveformCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  offlineWaveformCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
  context.clearRect(0, 0, offlineWaveformCanvas.width, offlineWaveformCanvas.height);
}
function getOfflineVisualMode(job = getSelectedOfflineJob()) {
  return job?.visualMode === 'waveform' ? 'waveform' : 'spectrogram';
}
function updateOfflineVisualModeButtons(job = getSelectedOfflineJob()) {
  const mode = getOfflineVisualMode(job);
  if (offlineSpectrogramModeBtn) offlineSpectrogramModeBtn.classList.toggle('active', mode === 'spectrogram');
  if (offlineWaveformModeBtn) offlineWaveformModeBtn.classList.toggle('active', mode === 'waveform');
}
function setOfflineVisualMode(mode) {
  const job = getSelectedOfflineJob();
  if (!job) return;
  job.visualMode = mode === 'waveform' ? 'waveform' : 'spectrogram';
  renderOfflineWaveform(job);
}
function getOfflineVisualGain(job = getSelectedOfflineJob()) {
  const gain = Number(job?.visualGain);
  return Number.isFinite(gain) ? clamp(gain, 0, OFFLINE_VISUAL_GAIN_MAX) : 1;
}
function updateOfflineVisualGainSlider(job = getSelectedOfflineJob()) {
  if (!offlineVisualGainSlider) return;
  offlineVisualGainSlider.disabled = !job;
  offlineVisualGainSlider.max = String(OFFLINE_VISUAL_GAIN_MAX);
  offlineVisualGainSlider.step = '0.05';
  offlineVisualGainSlider.value = String(getOfflineVisualGain(job));
}
function setOfflineVisualGain(value) {
  const job = getSelectedOfflineJob();
  if (!job) return;
  job.visualGain = getOfflineVisualGain({ visualGain: value });
  updateOfflineVisualGainSlider(job);
  renderOfflineWaveform(job);
}
function hslToRgb(hue, saturation, lightness) {
  const h = (((Number(hue) || 0) % 360) + 360) % 360 / 360;
  const s = clamp((Number(saturation) || 0) / 100, 0, 1);
  const l = clamp((Number(lightness) || 0) / 100, 0, 1);
  if (s === 0) {
    const gray = Math.round(l * 255);
    return [gray, gray, gray];
  }
  const hueToRgb = (p, q, tValue) => {
    let t = tValue;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + ((q - p) * 6 * t);
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + ((q - p) * ((2 / 3) - t) * 6);
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - (l * s);
  const p = (2 * l) - q;
  return [
    Math.round(hueToRgb(p, q, h + (1 / 3)) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - (1 / 3)) * 255),
  ];
}
function aegisubHslToRgb(hue255, saturation255, lightness255) {
  return hslToRgb(
    (clamp(Number(hue255) || 0, 0, 255) / 255) * 360,
    (clamp(Number(saturation255) || 0, 0, 255) / 255) * 100,
    (clamp(Number(lightness255) || 0, 0, 255) / 255) * 100
  );
}
function aegisubAudioSchemeColor({ hueOffset, hueScale, saturationOffset, saturationScale, lightnessOffset, lightnessScale }, value) {
  const t = clamp(Number(value) || 0, 0, 1);
  return aegisubHslToRgb(
    hueOffset + (t * hueScale),
    saturationOffset + (t * saturationScale),
    lightnessOffset + (t * lightnessScale)
  );
}
// Aegisub reference: AudioColorScheme builds palette entries by mapping signal strength through HSL.
// https://sources.debian.org/src/aegisub/3.4.2%2Bds-3/src/audio_colorscheme.cpp
function spectrogramColor(value, gain = 1, valueScale = 255) {
  const normalized = clamp(((Number(value) || 0) / Math.max(1, Number(valueScale) || 255)) * getOfflineVisualGain({ visualGain: gain }), 0, 1);
  return aegisubAudioSchemeColor({
    hueOffset: 191,
    hueScale: -128,
    saturationOffset: 127,
    saturationScale: 128,
    lightnessOffset: 0,
    lightnessScale: 255,
  }, normalized);
}
function chooseOfflineRulerInterval(durationSec) {
  const target = Math.max(1, Number(durationSec) / 8);
  const intervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return intervals.find((interval) => interval >= target) || intervals[intervals.length - 1];
}
function formatOfflineRulerLabel(timeSec, intervalSec) {
  const total = Math.max(0, Math.round(Number(timeSec) || 0));
  if (intervalSec >= 60 && total % 3600 !== 0) {
    return String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function drawOfflineTimeRuler(context, view, width, height, rulerHeight) {
  const major = chooseOfflineRulerInterval(view.viewDurationSec);
  const minor = major / 10;
  const timeToX = (timeSec) => ((timeSec - view.viewStartSec) / view.viewDurationSec) * width;

  context.fillStyle = 'rgba(0, 4, 13, 0.96)';
  context.fillRect(0, 0, width, rulerHeight);
  context.strokeStyle = 'rgba(68, 190, 255, 0.32)';
  context.lineWidth = 1;

  const firstMinor = Math.ceil(view.viewStartSec / minor) * minor;
  for (let time = firstMinor; time <= view.viewEndSec + 0.001; time += minor) {
    const x = Math.round(timeToX(time)) + 0.5;
    const isMajor = Math.abs((time / major) - Math.round(time / major)) < 0.001;
    context.beginPath();
    context.moveTo(x, isMajor ? 0 : rulerHeight - 5);
    context.lineTo(x, isMajor ? height : rulerHeight);
    context.strokeStyle = isMajor ? 'rgba(84, 203, 255, 0.68)' : 'rgba(84, 203, 255, 0.34)';
    context.stroke();
  }

  context.font = `${Math.max(10, Math.round(rulerHeight * 0.62))}px Consolas, monospace`;
  context.textBaseline = 'top';
  context.fillStyle = '#6ed3ff';
  const firstMajor = Math.ceil(view.viewStartSec / major) * major;
  for (let time = firstMajor; time <= view.viewEndSec + 0.001; time += major) {
    const x = clamp(timeToX(time) + 2, 0, width - 34);
    context.fillText(formatOfflineRulerLabel(time, major), x, 1);
  }
}
function buildAegisubRenderRows(spectrogram, rowCount) {
  const binCount = Math.max(1, Math.floor(Number(spectrogram?.binCount) || Number(spectrogram?.bandCount) || 1));
  const minBand = Math.max(1, Math.floor(Number(spectrogram?.minBand) || 1));
  const maxBand = Math.max(minBand + 1, Math.min(binCount, Math.floor(Number(spectrogram?.maxBand) || binCount)));
  const logRatio = clamp(Number(spectrogram?.logRatio) || 0, 0, 1);
  const scaleLog = Math.log(maxBand / minBand);
  const rows = [];
  let previousBin = minBand;
  let currentBin = minBand;
  for (let row = 0; row < rowCount; row += 1) {
    let nextBin = maxBand;
    if (row + 1 < rowCount) {
      const position = (row + 1) / rowCount;
      const linearBin = minBand + (position * (maxBand - minBand));
      const logBin = minBand * Math.exp(position * scaleLog);
      nextBin = linearBin + (logRatio * (logBin - linearBin));
    }
    rows.push({ previousBin, currentBin, nextBin });
    previousBin = currentBin;
    currentBin = nextBin;
  }
  return rows;
}
function sampleAegisubBinCacheValue(values, column, binCount, row) {
  const base = column * binCount;
  if (row.nextBin - row.previousBin < 2) {
    const bin0 = Math.min(binCount - 1, Math.max(0, Math.floor(row.currentBin)));
    const bin1 = Math.min(binCount - 1, bin0 + 1);
    const fraction = row.currentBin - bin0;
    const value0 = Number(values[base + bin0]) || 0;
    const value1 = Number(values[base + bin1]) || 0;
    return value0 + (fraction * (value1 - value0));
  }
  let fromBin = Math.floor((row.previousBin + row.currentBin) * 0.5);
  let toBin = Math.floor((row.currentBin + row.nextBin) * 0.5);
  fromBin = Math.min(Math.max(0, fromBin), binCount - 2);
  toBin = Math.min(Math.max(fromBin + 1, toBin), binCount - 1);
  let value = 0;
  for (let bin = fromBin; bin < toBin; bin += 1) {
    const nextValue = Number(values[base + bin]) || 0;
    if (nextValue > value) value = nextValue;
  }
  return value;
}
function renderOfflineSpectrogramCanvas(context, job, width, height) {
  const spectrogram = job?.spectrogram || null;
  const values = numericSeries(spectrogram?.values);
  const columnCount = Math.floor(Number(spectrogram?.columnCount) || 0);
  const storedRowCount = Math.floor(Number(spectrogram?.binCount) || Number(spectrogram?.bandCount) || 0);
  if (!values.length || !columnCount || !storedRowCount) return false;

  const view = getOfflineWaveformView(job);
  const visualGain = getOfflineVisualGain(job);
  const spectrogramStartSec = Number(spectrogram.startSec) || view.startSec;
  const spectrogramDurationSec = Math.max(1, Number(spectrogram.durationSec) || (Number(spectrogram.endSec) - spectrogramStartSec) || view.durationSec);
  const valueScale = Math.max(1, Number(spectrogram.valueScale) || 255);
  const rulerHeight = Math.min(30, Math.max(18, Math.round(height * 0.12)));
  const scrollbarReserve = 18;
  const spectrogramHeight = Math.max(1, height - rulerHeight - scrollbarReserve);
  const image = context.createImageData(width, spectrogramHeight);
  const pixels = image.data;
  const isAegisubBinCache = spectrogram.renderer === 'aegisub-spectrum-bin-cache-v1';
  const maxColumnsPerPixel = isAegisubBinCache || spectrogram.renderer === 'aegisub-spectrum-like-v1' ? 48 : 1;
  const renderRows = isAegisubBinCache ? buildAegisubRenderRows(spectrogram, spectrogramHeight) : null;

  for (let x = 0; x < width; x += 1) {
    const startTimeSec = view.viewStartSec + ((x / Math.max(1, width)) * view.viewDurationSec);
    const endTimeSec = view.viewStartSec + (((x + 1) / Math.max(1, width)) * view.viewDurationSec);
    const startColumn = Math.min(columnCount - 1, Math.max(0, Math.floor(clamp((startTimeSec - spectrogramStartSec) / spectrogramDurationSec, 0, 1) * columnCount)));
    const endColumn = Math.min(columnCount, Math.max(startColumn + 1, Math.ceil(clamp((endTimeSec - spectrogramStartSec) / spectrogramDurationSec, 0, 1) * columnCount)));
    const columnStep = Math.max(1, Math.floor((endColumn - startColumn) / maxColumnsPerPixel));
    for (let y = 0; y < spectrogramHeight; y += 1) {
      let value = 0;
      if (isAegisubBinCache) {
        const row = renderRows[Math.max(0, spectrogramHeight - 1 - y)];
        for (let column = startColumn; column < endColumn; column += columnStep) {
          const nextValue = sampleAegisubBinCacheValue(values, column, storedRowCount, row);
          if (nextValue > value) value = nextValue;
        }
      } else {
        const bandRatio = 1 - (y / Math.max(1, spectrogramHeight - 1));
        const band = Math.min(storedRowCount - 1, Math.floor(bandRatio * storedRowCount));
        for (let column = startColumn; column < endColumn; column += columnStep) {
          const nextValue = values[(column * storedRowCount) + band] || 0;
          if (nextValue > value) value = nextValue;
        }
      }
      const [r, g, b] = spectrogramColor(value, visualGain, valueScale);
      const index = ((y * width) + x) * 4;
      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
      pixels[index + 3] = 255;
    }
  }

  context.putImageData(image, 0, rulerHeight);
  context.fillStyle = 'rgba(0, 0, 0, 0.12)';
  context.fillRect(0, rulerHeight, width, spectrogramHeight);
  context.fillStyle = 'rgba(92, 47, 146, 0.12)';
  context.fillRect(0, rulerHeight, width, spectrogramHeight);
  context.fillStyle = 'rgba(255, 255, 255, 0.06)';
  for (let line = 1; line < 4; line += 1) {
    const y = rulerHeight + Math.round((line / 4) * spectrogramHeight);
    context.fillRect(0, y, width, 1);
  }
  drawOfflineTimeRuler(context, view, width, height - scrollbarReserve, rulerHeight);
  return true;
}
function renderOfflineWaveformPeaksCanvas(context, job, width, height) {
  const waveform = job?.waveform || null;
  const minPeaks = numericSeries(waveform?.min);
  const maxPeaks = numericSeries(waveform?.max);
  const avgMinPeaks = numericSeries(waveform?.avgMin);
  const avgMaxPeaks = numericSeries(waveform?.avgMax);
  const peakCount = Math.min(minPeaks.length, maxPeaks.length);
  if (!peakCount) return false;
  const view = getOfflineWaveformView(job);
  const visualGain = getOfflineVisualGain(job);
  const waveformStartSec = Number(waveform.startSec) || view.startSec;
  const waveformDurationSec = Math.max(1, Number(waveform.durationSec) || (Number(waveform.endSec) - waveformStartSec) || view.durationSec);
  const waveformValueScale = Math.max(1, Number(waveform.valueScale) || 1);
  const rulerHeight = Math.min(30, Math.max(18, Math.round(height * 0.12)));
  const scrollbarReserve = 18;
  const waveformTop = rulerHeight;
  const waveformHeight = Math.max(1, height - rulerHeight - scrollbarReserve);
  const midY = waveformTop + (waveformHeight / 2);
  const maxSamplesPerPixel = 96;

  context.fillStyle = 'rgba(1, 2, 8, 0.94)';
  context.fillRect(0, waveformTop, width, waveformHeight);
  context.fillStyle = 'rgba(92, 47, 146, 0.08)';
  context.fillRect(0, waveformTop, width, waveformHeight);
  context.strokeStyle = 'rgba(116, 237, 255, 0.25)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, midY + 0.5);
  context.lineTo(width, midY + 0.5);
  context.stroke();

  // Aegisub reference: Maximum + Average waveform style renders peak and average lobes separately.
  // https://sources.debian.org/src/aegisub/3.4.2%2Bds-3/src/audio_renderer_waveform.cpp
  context.strokeStyle = 'rgba(59, 211, 255, 0.82)';
  context.beginPath();
  for (let x = 0; x < width; x += 1) {
    const startTimeSec = view.viewStartSec + ((x / Math.max(1, width)) * view.viewDurationSec);
    const endTimeSec = view.viewStartSec + (((x + 1) / Math.max(1, width)) * view.viewDurationSec);
    const startIndex = Math.min(peakCount - 1, Math.max(0, Math.floor(clamp((startTimeSec - waveformStartSec) / waveformDurationSec, 0, 1) * peakCount)));
    const endIndex = Math.min(peakCount, Math.max(startIndex + 1, Math.ceil(clamp((endTimeSec - waveformStartSec) / waveformDurationSec, 0, 1) * peakCount)));
    const peakStep = Math.max(1, Math.floor((endIndex - startIndex) / maxSamplesPerPixel));
    let minValue = 0;
    let maxValue = 0;
    for (let index = startIndex; index < endIndex; index += peakStep) {
      minValue = Math.min(minValue, (Number(minPeaks[index]) || 0) / waveformValueScale);
      maxValue = Math.max(maxValue, (Number(maxPeaks[index]) || 0) / waveformValueScale);
    }
    minValue = clamp(minValue * visualGain, -1, 1);
    maxValue = clamp(maxValue * visualGain, -1, 1);
    const y1 = midY - (maxValue * waveformHeight * 0.48);
    const y2 = midY - (minValue * waveformHeight * 0.48);
    context.moveTo(x + 0.5, y1);
    context.lineTo(x + 0.5, y2);
  }
  context.stroke();

  if (avgMinPeaks.length && avgMaxPeaks.length) {
    context.strokeStyle = 'rgba(210, 255, 232, 0.92)';
    context.beginPath();
    for (let x = 0; x < width; x += 1) {
      const startTimeSec = view.viewStartSec + ((x / Math.max(1, width)) * view.viewDurationSec);
      const endTimeSec = view.viewStartSec + (((x + 1) / Math.max(1, width)) * view.viewDurationSec);
      const startIndex = Math.min(peakCount - 1, Math.max(0, Math.floor(clamp((startTimeSec - waveformStartSec) / waveformDurationSec, 0, 1) * peakCount)));
      const endIndex = Math.min(peakCount, Math.max(startIndex + 1, Math.ceil(clamp((endTimeSec - waveformStartSec) / waveformDurationSec, 0, 1) * peakCount)));
      const avgStep = Math.max(1, Math.floor((endIndex - startIndex) / maxSamplesPerPixel));
      let avgMin = 0;
      let avgMax = 0;
      let count = 0;
      for (let index = startIndex; index < endIndex; index += avgStep) {
        avgMin += (Number(avgMinPeaks[index]) || 0) / waveformValueScale;
        avgMax += (Number(avgMaxPeaks[index]) || 0) / waveformValueScale;
        count += 1;
      }
      if (count > 0) {
        avgMin = clamp((avgMin / count) * visualGain, -1, 1);
        avgMax = clamp((avgMax / count) * visualGain, -1, 1);
        context.moveTo(x + 0.5, midY - (avgMax * waveformHeight * 0.48));
        context.lineTo(x + 0.5, midY - (avgMin * waveformHeight * 0.48));
      }
    }
    context.stroke();
  }
  context.strokeStyle = 'rgba(116, 237, 255, 0.55)';
  context.beginPath();
  context.moveTo(0, midY + 0.5);
  context.lineTo(width, midY + 0.5);
  context.stroke();
  drawOfflineTimeRuler(context, view, width, height - scrollbarReserve, rulerHeight);
  return true;
}
function renderOfflineWaveformCanvas(job) {
  if (!offlineWaveformCanvas) return;
  const rect = offlineWaveformCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const pixelWidth = Math.max(1, Math.floor(width * dpr));
  const pixelHeight = Math.max(1, Math.floor(height * dpr));
  offlineWaveformCanvas.width = pixelWidth;
  offlineWaveformCanvas.height = pixelHeight;
  const context = offlineWaveformCanvas.getContext('2d');
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  const mode = getOfflineVisualMode(job);
  if (mode === 'spectrogram') {
    const rendered = renderOfflineSpectrogramCanvas(context, job, pixelWidth, pixelHeight);
    if (rendered) return;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  renderOfflineWaveformPeaksCanvas(context, job, width, height);
}
function renderOfflineWaveformOverlay(job) {
  if (!offlineWaveformOverlay) return;
  offlineWaveformOverlay.innerHTML = '';
  if (!job) return;
  ensureOfflineSegmentIds(job);
  const view = getOfflineWaveformView(job);
  for (const segment of job.segments || []) {
    if (Number(segment.endSec) < view.viewStartSec || Number(segment.startSec) > view.viewEndSec) continue;
    const startRatio = timeToOfflineRatio(job, Math.max(segment.startSec, view.viewStartSec));
    const endRatio = timeToOfflineRatio(job, Math.min(segment.endSec, view.viewEndSec));
    const widthRatio = Math.max(0.001, endRatio - startRatio);
    const element = document.createElement('div');
    element.className = `offline-wave-segment${segment.id === job.selectedSegmentId ? ' selected' : ''}`;
    element.dataset.offlineSegmentId = segment.id;
    element.style.left = `${startRatio * 100}%`;
    element.style.width = `${widthRatio * 100}%`;
    element.style.minWidth = '5px';
    element.title = `${segment.title || ''} ${formatSeconds(segment.startSec)} - ${formatSeconds(segment.endSec)}`;
    element.innerHTML = `<span class="offline-wave-handle start" data-wave-action="resize-start"></span><span class="offline-wave-segment-label">${escapeHtml(segment.title || '')}</span><span class="offline-wave-handle end" data-wave-action="resize-end"></span>`;
    offlineWaveformOverlay.appendChild(element);
  }
  if (offlineWaveformEmpty) {
    offlineWaveformEmpty.hidden = Boolean(job.waveform || job.spectrogram || (Array.isArray(job.segments) && job.segments.length));
  }
  renderOfflinePlayhead(job);
}
function renderOfflineSegmentEditor(job) {
  if (!offlineSegmentEditor) return;
  const segment = getSelectedOfflineSegment(job);
  offlineSegmentEditor.hidden = !segment;
  if (!segment) return;
  offlineSegmentTitleInput.value = segment.title || '';
  offlineSegmentStartInput.value = formatSecondsFixedMillis(segment.startSec);
  offlineSegmentEndInput.value = formatSecondsFixedMillis(segment.endSec);
}
function shouldShowOfflinePlayer(job) {
  if (!job) return false;
  const isComplete = job.status === 'done' || job.status === 'saved';
  return isComplete && Boolean(job.waveform || job.spectrogram);
}
function renderOfflineWaveform(job) {
  if (offlinePlayerPanel) offlinePlayerPanel.hidden = !shouldShowOfflinePlayer(job);
  if (!job) {
    clearOfflineWaveformCanvas();
    if (offlineWaveformOverlay) offlineWaveformOverlay.innerHTML = '';
    if (offlineWaveformEmpty) offlineWaveformEmpty.hidden = false;
    renderOfflineSegmentEditor(null);
    updateOfflineZoomButtons(null);
    updateOfflineVisualModeButtons(null);
    updateOfflineFollowPlayheadToggle(null);
    updateOfflineVisualGainSlider(null);
    updateOfflineViewScrollBar(null);
    renderOfflinePlayhead(null);
    return;
  }
  updateOfflineVisualModeButtons(job);
  updateOfflineFollowPlayheadToggle(job);
  updateOfflineVisualGainSlider(job);
  updateOfflineViewScrollBar(job);
  renderOfflineWaveformCanvas(job);
  renderOfflineWaveformOverlay(job);
  renderOfflineSegmentEditor(job);
}
function updateOfflineEditedViews(job, { sort = true, renderBatch = true } = {}) {
  if (!job) return;
  ensureOfflineSegmentIds(job);
  if (sort) sortOfflineSegments(job);
  offlineSegments = job.segments || [];
  renderOfflineWaveform(job);
  renderSegments(offlineResults, offlineSegments, job.selectedSegmentId);
  setOfflineActionState();
  if (renderBatch) renderOfflineBatchList();
}
function selectOfflineSegment(segmentId, { seek = false } = {}) {
  const job = getSelectedOfflineJob();
  if (!job) return;
  ensureOfflineSegmentIds(job);
  job.selectedSegmentId = segmentId;
  const segment = getSelectedOfflineSegment(job);
  if (seek && segment) seekOfflinePlayer(segment.startSec, { centerView: true });
  updateOfflineEditedViews(job, { sort: false, renderBatch: false });
}
function addOfflineSegmentAt(timeSec) {
  const job = getSelectedOfflineJob();
  if (!job) return;
  const range = getOfflineWaveformRange(job);
  const startSec = roundOfflineTime(clamp(timeSec, range.startSec, Math.max(range.startSec, range.endSec - 1)));
  const endSec = roundOfflineTime(Math.min(range.endSec, startSec + 60));
  const adjustedStart = endSec - startSec < 1 ? Math.max(range.startSec, endSec - 60) : startSec;
  const segment = {
    id: makeOfflineSegmentId(),
    startSec: roundOfflineTime(adjustedStart),
    endSec: Math.max(roundOfflineTime(adjustedStart + 1), endSec),
    title: `Offline Auto Song #${(job.segments || []).length + 1}`,
    confidence: 1,
    provisional: false,
  };
  job.segments = Array.isArray(job.segments) ? job.segments : [];
  job.segments.push(segment);
  job.selectedSegmentId = segment.id;
  markOfflineManualEdit(job);
  updateOfflineEditedViews(job, { renderBatch: true });
  setStatus(offlineStatus, tr('offline_segment_added'));
}
function deleteSelectedOfflineSegment() {
  const job = getSelectedOfflineJob();
  const segment = getSelectedOfflineSegment(job);
  if (!job || !segment) return;
  deleteOfflineSegmentById(segment.id);
}
function deleteOfflineSegmentById(segmentId) {
  const job = getSelectedOfflineJob();
  if (!job || !segmentId) return;
  const segment = (job.segments || []).find((item) => item.id === segmentId);
  if (!segment) return;
  if (!window.confirm(tr('offline_delete_segment_confirm', [segment.title || tr('untitled_item')]))) return;
  job.segments = job.segments.filter((item) => item.id !== segment.id);
  job.selectedSegmentId = null;
  markOfflineManualEdit(job);
  updateOfflineEditedViews(job, { renderBatch: true });
  setStatus(offlineStatus, tr('offline_segment_deleted'));
}
function updateSelectedOfflineSegmentField(field, value) {
  const job = getSelectedOfflineJob();
  const segment = getSelectedOfflineSegment(job);
  if (!job || !segment) return;
  const range = getOfflineWaveformRange(job);
  const previousDuration = Math.max(1, Number(segment.endSec) - Number(segment.startSec));
  if (field === 'title') {
    segment.title = String(value || '').trim() || tr('untitled_item');
  } else if (field === 'startSec') {
    segment.startSec = roundOfflineTime(clamp(parseTimeField(value, segment.startSec), range.startSec, range.endSec - 1));
    if (segment.endSec <= segment.startSec) segment.endSec = roundOfflineTime(Math.min(range.endSec, segment.startSec + previousDuration));
  } else if (field === 'endSec') {
    segment.endSec = roundOfflineTime(clamp(parseTimeField(value, segment.endSec), segment.startSec + 1, range.endSec));
  }
  markOfflineManualEdit(job);
  updateOfflineEditedViews(job, { renderBatch: false });
}
function applyOfflineWaveformDrag(event) {
  if (!offlineWaveformDrag) return;
  const { action, segmentId, originalStartSec, originalEndSec, pointerStartSec } = offlineWaveformDrag;
  const job = getSelectedOfflineJob();
  if (!job) return;
  const range = getOfflineWaveformRange(job);
  const pointerSec = offlinePointerTime(event);

  if (action === 'seek') {
    seekOfflinePlayer(pointerSec);
    return;
  }

  const segment = job.segments.find((item) => item.id === segmentId);
  if (!segment) return;
  const originalDuration = Math.max(1, originalEndSec - originalStartSec);
  if (action === 'resize-start') {
    segment.startSec = roundOfflineTime(clamp(pointerSec, range.startSec, originalEndSec - 1));
  } else if (action === 'resize-end') {
    segment.endSec = roundOfflineTime(clamp(pointerSec, originalStartSec + 1, range.endSec));
  } else if (action === 'move') {
    const delta = pointerSec - pointerStartSec;
    const nextStart = clamp(originalStartSec + delta, range.startSec, range.endSec - originalDuration);
    segment.startSec = roundOfflineTime(nextStart);
    segment.endSec = roundOfflineTime(nextStart + originalDuration);
  }
  markOfflineManualEdit(job);
  updateOfflineEditedViews(job, { sort: false, renderBatch: false });
}
function finishOfflineWaveformDrag() {
  if (!offlineWaveformDrag) return;
  document.body.style.cursor = '';
  document.removeEventListener('pointermove', applyOfflineWaveformDrag);
  offlineWaveformDrag = null;
  const job = getSelectedOfflineJob();
  if (job) updateOfflineEditedViews(job);
}
function startOfflineWaveformPointer(event) {
  if (!offlineWaveformShell || event.button !== 0) return;
  if (event.target === offlineViewScrollBar || event.target.closest?.('.offline-view-scrollbar')) return;
  const job = getSelectedOfflineJob();
  if (!job) return;
  const segmentElement = event.target.closest('.offline-wave-segment[data-offline-segment-id]');
  const handle = event.target.closest('[data-wave-action]');
  event.preventDefault();
  if (segmentElement) {
    const segmentId = segmentElement.dataset.offlineSegmentId;
    const segment = job.segments.find((item) => item.id === segmentId);
    if (!segment) return;
    job.selectedSegmentId = segmentId;
    const action = handle?.dataset.waveAction || 'move';
    offlineWaveformDrag = {
      action,
      segmentId,
      originalStartSec: Number(segment.startSec) || 0,
      originalEndSec: Number(segment.endSec) || 0,
      pointerStartSec: offlinePointerTime(event),
    };
    segmentElement.classList.add('dragging');
    document.body.style.cursor = action === 'move' ? 'grabbing' : 'ew-resize';
    updateOfflineEditedViews(job, { sort: false, renderBatch: false });
  } else {
    offlineWaveformDrag = { action: 'seek' };
    seekOfflinePlayer(offlinePointerTime(event));
  }
  document.addEventListener('pointermove', applyOfflineWaveformDrag);
  document.addEventListener('pointerup', finishOfflineWaveformDrag, { once: true });
}
function handleOfflineWaveformDoubleClick(event) {
  if (event.target.closest('.offline-wave-segment')) return;
  if (event.target === offlineViewScrollBar || event.target.closest?.('.offline-view-scrollbar')) return;
  addOfflineSegmentAt(offlinePointerTime(event));
}
function handleOfflineResultsClick(event) {
  const deleteButton = event.target.closest('[data-delete-offline-segment-id]');
  if (deleteButton) {
    event.preventDefault();
    event.stopPropagation();
    deleteOfflineSegmentById(deleteButton.dataset.deleteOfflineSegmentId);
    return;
  }
  const row = event.target.closest('[data-offline-segment-id]');
  if (!row) return;
  selectOfflineSegment(row.dataset.offlineSegmentId, { seek: true });
}
function setOfflineWaveformZoom(nextZoom, anchorSec = null) {
  const job = getSelectedOfflineJob();
  if (!job) return;
  const previousView = getOfflineWaveformView(job);
  const previousZoom = previousView.zoom;
  const zoom = clamp(Number(nextZoom) || previousZoom, OFFLINE_WAVEFORM_MIN_ZOOM, OFFLINE_WAVEFORM_MAX_ZOOM);
  if (Math.abs(zoom - previousZoom) < 0.001) return;
  const anchor = Number.isFinite(Number(anchorSec))
    ? clamp(Number(anchorSec), previousView.viewStartSec, previousView.viewEndSec)
    : clamp(
      Number.isFinite(Number(job.playbackCurrentSec))
        ? Number(job.playbackCurrentSec)
        : previousView.viewStartSec + (previousView.viewDurationSec / 2),
      previousView.viewStartSec,
      previousView.viewEndSec
    );
  const anchorRatio = clamp((anchor - previousView.viewStartSec) / previousView.viewDurationSec, 0, 1);
  const fullRange = getOfflineWaveformRange(job);
  const nextDuration = Math.max(1, fullRange.durationSec / zoom);
  job.waveformZoom = zoom;
  job.waveformViewCenterSec = anchor + ((0.5 - anchorRatio) * nextDuration);
  renderOfflineWaveform(job);
}
function zoomOfflineWaveform(delta, anchorSec = null) {
  const job = getSelectedOfflineJob();
  if (!job) return;
  const current = getOfflineWaveformZoom(job);
  const factor = delta > 0 ? 1.35 : 1 / 1.35;
  setOfflineWaveformZoom(current * factor, anchorSec);
}
function normalizeOfflineWheelDelta(event) {
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? Math.max(240, offlineWaveformShell?.clientWidth || 800)
      : 1;
  const deltaX = Number(event.deltaX) * unit;
  const deltaY = Number(event.deltaY) * unit;
  return Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
}
function panOfflineWaveform(deltaPixels) {
  const job = getSelectedOfflineJob();
  if (!job || !offlineWaveformShell) return;
  const view = getOfflineWaveformView(job);
  const width = Math.max(240, offlineWaveformShell.clientWidth || 800);
  const deltaSec = (Number(deltaPixels) / width) * view.viewDurationSec;
  if (!Number.isFinite(deltaSec) || Math.abs(deltaSec) < 0.001) return;
  job.waveformFollowPlayhead = false;
  setOfflineWaveformViewCenter(
    job,
    view.viewStartSec + (view.viewDurationSec / 2) + deltaSec
  );
}
function handleOfflineWaveformWheel(event) {
  const job = getSelectedOfflineJob();
  if (!job) return;
  event.preventDefault();
  const delta = normalizeOfflineWheelDelta(event);
  if (event.ctrlKey || event.metaKey) {
    zoomOfflineWaveform(delta < 0 ? 1 : -1, offlinePointerTime(event));
    return;
  }
  panOfflineWaveform(delta);
}
async function toggleOfflineAudioPlayback() {
  const job = getSelectedOfflineJob();
  debugOfflineAudio('toggle-enter', { jobId: job?.id || null });
  if (!job || !offlineAudioPlayer || job.playbackUnavailable) return;
  if (offlineAudioPlayer.paused) {
    if (!ensureOfflineAudioLoaded(job)) return;
    const targetSec = getOfflinePlaybackTargetSec(job);
    debugOfflineAudio('toggle-play-target', { targetSec });
    job.playbackCurrentSec = targetSec;
    if (isOfflineWaveformFollowPlayhead(job)) job.waveformViewCenterSec = targetSec;
    job.pendingPlayAfterLoad = false;
    job.pendingPlaybackStartSec = targetSec;
    applyOfflinePendingSeek(job);
    renderOfflinePlayhead(job);
    try {
      debugOfflineAudio('play-call-before', { targetSec });
      await offlineAudioPlayer.play();
      debugOfflineAudio('play-call-resolved', { targetSec });
      job.pendingPlayAfterLoad = false;
    } catch (error) {
      debugOfflineAudio('play-call-rejected', {
        targetSec,
        error: error?.message || String(error),
        errorName: error?.name || null,
        fatal: isFatalOfflineAudioPlaybackError(error),
      }, { force: true });
      job.pendingPlayAfterLoad = false;
      if (isFatalOfflineAudioPlaybackError(error)) {
        job.playbackUnavailable = true;
        job.pendingPlaybackStartSec = null;
        offlinePlayPauseBtn.disabled = true;
        setStatus(offlineStatus, tr('offline_audio_unavailable'));
      } else {
        job.playbackUnavailable = false;
        offlinePlayPauseBtn.disabled = false;
        updateOfflinePlayerButton(false);
      }
    }
  } else {
    debugOfflineAudio('toggle-pause');
    job.pendingPlaybackStartSec = null;
    job.pendingPlayAfterLoad = false;
    offlineAudioPlayer.pause();
  }
}
async function handleOfflineAudioReady(event = null) {
  const job = getSelectedOfflineJob();
  debugOfflineAudio('audio-ready-event', { event: event?.type || 'ready', jobId: job?.id || null });
  if (!job || !offlineAudioPlayer || offlineAudioPlayer.dataset.jobId !== job.id) return;
  job.playbackUnavailable = false;
  offlinePlayPauseBtn.disabled = false;
  const hasPendingSeek = hasOfflinePendingSeek(job);
  if (hasPendingSeek) {
    applyOfflinePendingSeek(job);
  }
  offlinePlayPauseBtn.disabled = false;
  renderOfflinePlayhead(job);
  job.pendingPlayAfterLoad = false;
}
function handleOfflineAudioError() {
  const job = getSelectedOfflineJob();
  debugOfflineAudio('audio-error-event', { jobId: job?.id || null }, { force: true });
  if (!job || !offlineAudioPlayer || offlineAudioPlayer.dataset.jobId !== job.id) return;
  job.playbackUnavailable = true;
  offlinePlayPauseBtn.disabled = true;
  updateOfflinePlayerButton(false);
  setStatus(offlineStatus, tr('offline_audio_unavailable'));
}
function handleOfflineAudioTimeUpdate() {
  const job = getSelectedOfflineJob();
  if (!job || !offlineAudioPlayer || offlineAudioPlayer.dataset.jobId !== job.id) return;
  const now = performance.now();
  const hasPendingSeek = hasOfflinePendingSeek(job);
  if (hasPendingSeek || now - offlineAudioDebugLastTimeupdateAt > 1000) {
    offlineAudioDebugLastTimeupdateAt = now;
    debugOfflineAudio('timeupdate-enter', { throttled: true });
  }
  if (hasPendingSeek) {
    applyOfflinePendingSeek(job);
    renderOfflinePlayhead(job);
    debugOfflineAudio('timeupdate-return-pending');
    return;
  }
  const range = getOfflineWaveformRange(job);
  const current = Number.isFinite(Number(offlineAudioPlayer.currentTime)) ? Number(offlineAudioPlayer.currentTime) : range.startSec;
  if (current > range.endSec) {
    offlineAudioPlayer.pause();
    offlineAudioPlayer.currentTime = range.endSec;
    job.playbackCurrentSec = range.endSec;
  } else if (current + 0.05 < range.startSec && offlineAudioPlayer.readyState >= HTMLMediaElement.HAVE_METADATA) {
    try {
      offlineAudioPlayer.currentTime = range.startSec;
    } catch (error) {
      // Keep UI bounded even if the container rejects this seek momentarily.
    }
    job.playbackCurrentSec = range.startSec;
  } else {
    job.playbackCurrentSec = clamp(current, range.startSec, range.endSec);
  }
  if (maybeFollowOfflinePlayhead(job)) return;
  renderOfflinePlayhead(job);
}
function handleOfflineAudioPlay() { debugOfflineAudio('audio-play-event'); updateOfflinePlayerButton(true); startOfflinePlaybackRaf(); }
function handleOfflineAudioPause() { debugOfflineAudio('audio-pause-event'); updateOfflinePlayerButton(false); stopOfflinePlaybackRaf(); }
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

function renderSegments(container, segments, selectedSegmentId = null) {
  if (!container) return;
  container.innerHTML = '<div class="result-row header"><span>Start</span><span>End</span><span>Title</span><span>Confidence</span><span></span></div>';
  if (!segments.length) { container.insertAdjacentHTML('beforeend', '<div class="result-row"><span>-</span><span>-</span><span>No segments detected</span><span>-</span><span></span></div>'); return; }
  segments.forEach((segment, index) => {
    const title = segment.title || `Offline Auto Song #${index + 1}`;
    const reasonText = Array.isArray(segment.boundaryReasons) && segment.boundaryReasons.length
      ? ` (${segment.boundaryReasons.join(', ')})`
      : '';
    const selectedClass = segment.id && segment.id === selectedSegmentId ? ' selected' : '';
    const segmentAttr = segment.id ? ` data-offline-segment-id="${escapeHtml(segment.id)}"` : '';
    const deleteButton = segment.id
      ? `<button class="result-delete-btn" type="button" data-delete-offline-segment-id="${escapeHtml(segment.id)}" title="${escapeHtml(tr('delete'))}" aria-label="${escapeHtml(tr('delete'))}">×</button>`
      : '';
    container.insertAdjacentHTML('beforeend', `<div class="result-row${selectedClass}"${segmentAttr}><span>${formatSeconds(segment.startSec)}</span><span>${formatSeconds(segment.endSec)}</span><span>${escapeHtml(title)}${escapeHtml(reasonText)}</span><span>${Math.round((segment.confidence || 0) * 100)}%</span><span>${deleteButton}</span></div>`);
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

function boundaryId(boundary) {
  return `${boundary.sourceSegmentIndex ?? 0}:${Number(boundary.timeSec).toFixed(3)}`;
}

function buildSegmentsFromSelectedBoundaries(job) {
  const baseSegments = Array.isArray(job?.baseSegments) ? job.baseSegments : [];
  const boundaries = Array.isArray(job?.boundarySplit?.boundaries) ? job.boundarySplit.boundaries : [];
  const selection = job?.boundarySelection || {};
  const output = [];

  baseSegments.forEach((segment, parentIndex) => {
    const selected = boundaries
      .filter((boundary) => Number(boundary.sourceSegmentIndex) === parentIndex && selection[boundaryId(boundary)] !== false)
      .sort((a, b) => Number(a.timeSec) - Number(b.timeSec));

    if (!selected.length) {
      output.push({ ...segment });
      return;
    }

    const points = [segment.startSec, ...selected.map((boundary) => Number(boundary.timeSec)), segment.endSec];
    for (let index = 0; index < points.length - 1; index += 1) {
      const boundary = index > 0 ? selected[index - 1] : selected[0];
      output.push({
        ...segment,
        startSec: points[index],
        endSec: points[index + 1],
        title: `Offline Auto Song #${parentIndex + 1}-${index + 1}`,
        splitBy: job.boundarySplit.detectorVersion,
        sourceSegmentId: `offline-auto-song-${parentIndex + 1}`,
        splitSourceSegmentIndex: parentIndex,
        splitPartIndex: index + 1,
        splitPartCount: points.length - 1,
        boundaryConfidence: boundary ? boundary.confidence : null,
        boundaryReasons: boundary ? boundary.reasons : [],
        medleySplit: true,
      });
    }
  });

  return output.map((segment) => ({
    ...segment,
    startSec: Math.round(Number(segment.startSec || 0) * 1000) / 1000,
    endSec: Math.round(Number(segment.endSec || 0) * 1000) / 1000,
  }));
}

function applyBoundarySelection(job) {
  if (!job || !job.boundarySplit) return;
  job.segments = buildSegmentsFromSelectedBoundaries(job);
  job.manualEdits = false;
  job.selectedSegmentId = null;
  ensureOfflineSegmentIds(job);
  job.summary = [
    ...(job.summary || []).filter((item) => !String(item).startsWith('split ')),
    `split ${job.segments.length}/${job.baseSegments?.length || job.segments.length} segment(s)`,
  ];
  renderOfflineBatchList();
  if (job.id === selectedOfflineJobId) renderSelectedOfflineJob();
}

function renderBoundarySelection(container, job) {
  if (!container) return;
  const splitResult = job?.boundarySplit || null;
  const boundaries = Array.isArray(splitResult?.boundaries) ? splitResult.boundaries : [];
  if (!splitResult || !boundaries.length) {
    renderBoundaryDebug(container, splitResult, Boolean(splitResult));
    return;
  }

  container.innerHTML = '';
  container.hidden = false;
  const header = document.createElement('div');
  header.className = 'boundary-debug-header';
  header.innerHTML = `<div><span class="eyebrow">Medley Boundary Debug</span><h3>串燒切點</h3></div><span class="panel-badge">${boundaries.length} candidate(s)</span>`;
  container.appendChild(header);

  const list = document.createElement('div');
  list.className = 'boundary-debug-list boundary-select-list';
  list.innerHTML = '<div class="boundary-debug-row header boundary-select-row"><span>Keep</span><span>Time</span><span>Reason</span><span>Metrics</span></div>';
  boundaries.forEach((boundary) => {
    const id = boundaryId(boundary);
    if (!job.boundarySelection) job.boundarySelection = {};
    if (!(id in job.boundarySelection)) job.boundarySelection[id] = true;
    const reasons = Array.isArray(boundary.reasons) && boundary.reasons.length ? boundary.reasons.join(', ') : '-';
    const metrics = boundary.metrics || {};
    const metricText = [
      `confidence ${Math.round((boundary.confidence || 0) * 100)}%`,
      `source #${(boundary.sourceSegmentIndex ?? 0) + 1}`,
      `aed ${formatBoundaryMetric(metrics.aedChange)}`,
      `structure ${formatBoundaryMetric(metrics.structureChange)}`,
      `rms ${formatBoundaryMetric(metrics.valleyRms, 5)}/${formatBoundaryMetric(metrics.energyRef, 5)}`,
      `singing ${formatBoundaryMetric(metrics.valleySinging)}/${formatBoundaryMetric(metrics.singingRef)}`,
    ].join(' · ');
    const row = document.createElement('label');
    row.className = 'boundary-debug-row boundary-select-row';
    row.innerHTML = `<span><input type="checkbox" data-boundary-id="${escapeHtml(id)}" ${job.boundarySelection[id] !== false ? 'checked' : ''}> ${escapeHtml(tr('boundary_keep_split'))}</span><span>${formatSeconds(boundary.timeSec)}</span><span>${escapeHtml(reasons)}</span><span>${escapeHtml(metricText)}</span>`;
    list.appendChild(row);
  });
  list.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-boundary-id]');
    if (!input) return;
    const previousValue = job.boundarySelection[input.dataset.boundaryId] !== false;
    if (job.manualEdits && previousValue !== input.checked && !window.confirm(tr('offline_manual_edits_confirm'))) {
      input.checked = previousValue;
      return;
    }
    job.boundarySelection[input.dataset.boundaryId] = input.checked;
    applyBoundarySelection(job);
  });
  container.appendChild(list);
}

function offlineFileSignature(file) {
  return [
    file?.name || '',
    file?.size || 0,
    file?.lastModified || 0,
  ].join('::');
}

function createOfflineBatchJob(file, index, options = {}) {
  const isSingleFileSelection = options.fileCount === 1;
  const sharedTitle = String(options.title || '').trim();
  const sharedVideoId = String(options.videoId || '').trim();
  const parsedVideoId = extractYouTubeVideoIdFromText(file?.name || '');
  return {
    id: makeOfflineJobId(),
    file,
    fileKey: offlineFileSignature(file),
    fileName: file.name || `audio-${index + 1}`,
    audioUrl: URL.createObjectURL(file),
    playbackCurrentSec: 0,
    pendingPlaybackStartSec: null,
    pendingPlayAfterLoad: false,
    playbackUnavailable: false,
    waveformZoom: 1,
    waveformViewCenterSec: null,
    waveformFollowPlayhead: true,
    visualGain: 1,
    visualMode: 'spectrogram',
    generateVisuals: options.generateVisuals !== false,
    highResolutionVisuals: Boolean(options.highResolutionVisuals),
    visualsStatus: 'idle',
    visualsError: null,
    visualsRequested: false,
    videoId: isSingleFileSelection ? (sharedVideoId || parsedVideoId) : '',
    title: (isSingleFileSelection && sharedTitle) ? sharedTitle : (fileBaseName(file.name) || `Offline Audio ${index + 1}`),
    requestedStartSec: isSingleFileSelection ? Math.max(0, Number(options.requestedStartSec) || 0) : 0,
    requestedEndSec: isSingleFileSelection ? normalizeOptionalSeconds(options.requestedEndSec) : null,
    minSegmentDurationSec: normalizeMinSegmentDurationSec(options.minSegmentDurationSec),
    splitMedley: Boolean(options.splitMedley),
    status: 'queued',
    progress: 0,
    statusMessage: tr('offline_batch_queued'),
    runtimeInfo: null,
    waveform: null,
    spectrogram: null,
    baseSegments: [],
    analyses: [],
    boundarySelection: {},
    segments: [],
    boundarySplit: null,
    excludedMusicOnlySpans: [],
    droppedMusicOnlySegments: [],
    result: null,
    error: null,
    selectedSegmentId: null,
    manualEdits: false,
    summary: [],
    pendingSeekInProgress: false,
  };
}

function createOfflineStagedFile(file, index) {
  const minSegmentDurationSec = normalizeMinSegmentDurationSec(
    readNumberInput(offlineMinSegmentSec, DEFAULT_MIN_SEGMENT_DURATION_SEC)
  );
  const parsedVideoId = extractYouTubeVideoIdFromText(file?.name || '');
  return {
    id: `offline-stage-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    fileKey: offlineFileSignature(file),
    fileName: file.name || `audio-${index + 1}`,
    videoId: parsedVideoId,
    title: fileBaseName(file.name) || `Offline Audio ${index + 1}`,
    requestedStartSec: 0,
    requestedEndSec: null,
    minSegmentDurationSec,
    splitMedley: Boolean(offlineSplitMedleyToggle?.checked),
    generateVisuals: offlineVisualEditorToggle?.checked !== false,
    highResolutionVisuals: Boolean(offlineVisualEditorToggle?.checked !== false && offlineHighResolutionToggle?.checked),
  };
}

function getSelectedOfflineStagedFile() {
  return offlineStagedFiles[selectedOfflineStagedIndex] || null;
}

function getOfflineStagedReadyCount() {
  return offlineStagedFiles.filter((item) => String(item.videoId || '').trim()).length;
}

function renderOfflineMultiFileStaging() {
  if (!offlineMultiFileStaging || !offlineMultiFileTabs) return;
  const active = offlineFormMode === 'multi-staging' && offlineStagedFiles.length > 1;
  offlineMultiFileStaging.hidden = !active;
  offlineMultiFileTabs.innerHTML = '';
  if (!active) return;

  const readyCount = getOfflineStagedReadyCount();
  if (offlineMultiFileStatus) {
    offlineMultiFileStatus.textContent = tr('offline_multi_file_setup_progress', [readyCount, offlineStagedFiles.length]);
  }
  offlineStagedFiles.forEach((item, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `offline-multi-tab${index === selectedOfflineStagedIndex ? ' active' : ''}${String(item.videoId || '').trim() ? ' ready' : ''}`;
    tab.dataset.offlineStagedIndex = String(index);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', index === selectedOfflineStagedIndex ? 'true' : 'false');
    tab.innerHTML = `
      <span class="offline-multi-tab-index">${index + 1}</span>
      <span class="offline-multi-tab-title">${escapeHtml(item.title || fileBaseName(item.fileName) || item.fileName)}</span>
      <span class="offline-multi-tab-state">${String(item.videoId || '').trim() ? '✓' : '!'}</span>
    `;
    offlineMultiFileTabs.appendChild(tab);
  });
}

function syncSelectedOfflineStagedFileFromForm({ render = true } = {}) {
  if (offlineFormMode !== 'multi-staging') return;
  const staged = getSelectedOfflineStagedFile();
  if (!staged) return;
  staged.videoId = offlineVideoId.value.trim();
  staged.title = offlineTitle.value.trim() || fileBaseName(staged.fileName) || staged.fileName;
  staged.requestedStartSec = Math.max(0, readNumberInput(offlineStartSec, 0));
  staged.requestedEndSec = normalizeOptionalSeconds(readNumberInput(offlineEndSec, null));
  staged.minSegmentDurationSec = normalizeMinSegmentDurationSec(
    readNumberInput(offlineMinSegmentSec, staged.minSegmentDurationSec ?? DEFAULT_MIN_SEGMENT_DURATION_SEC),
    staged.minSegmentDurationSec ?? DEFAULT_MIN_SEGMENT_DURATION_SEC
  );
  staged.splitMedley = Boolean(offlineSplitMedleyToggle?.checked);
  staged.generateVisuals = offlineVisualEditorToggle?.checked !== false;
  staged.highResolutionVisuals = Boolean(staged.generateVisuals && offlineHighResolutionToggle?.checked);
  if (render) renderOfflineMultiFileStaging();
}

function syncSelectedOfflineStagedFileToForm() {
  const staged = getSelectedOfflineStagedFile();
  if (!staged) return;
  offlineFormMode = 'multi-staging';
  offlineVideoId.value = staged.videoId || '';
  offlineTitle.value = staged.title || '';
  offlineTitle.dataset.autoFilled = 'true';
  if (offlineStartSec) offlineStartSec.value = formatSecondsInputValue(staged.requestedStartSec ?? 0);
  if (offlineEndSec) offlineEndSec.value = formatSecondsInputValue(staged.requestedEndSec);
  if (offlineMinSegmentSec) offlineMinSegmentSec.value = String(normalizeMinSegmentDurationSec(staged.minSegmentDurationSec));
  if (offlineSplitMedleyToggle) offlineSplitMedleyToggle.checked = Boolean(staged.splitMedley);
  if (offlineVisualEditorToggle) offlineVisualEditorToggle.checked = staged.generateVisuals !== false;
  if (offlineHighResolutionToggle) offlineHighResolutionToggle.checked = Boolean(staged.highResolutionVisuals);
  syncOfflineVisualOptionState();
}

function syncOfflineFormDataFromInputs({ render = true } = {}) {
  if (offlineFormMode === 'multi-staging') {
    syncSelectedOfflineStagedFileFromForm({ render });
    return;
  }
  syncSelectedOfflineJobFromForm({ render });
}

function selectOfflineStagedFile(index) {
  const nextIndex = Math.max(0, Math.min(offlineStagedFiles.length - 1, Number(index) || 0));
  syncSelectedOfflineStagedFileFromForm({ render: false });
  selectedOfflineStagedIndex = nextIndex;
  syncSelectedOfflineStagedFileToForm();
  renderOfflineMultiFileStaging();
}

function startOfflineMultiFileStaging(files) {
  const supportedFiles = Array.from(files || []).filter(isSupportedOfflineAudioFile);
  offlineStagedFiles = supportedFiles.map((file, index) => createOfflineStagedFile(file, index));
  selectedOfflineStagedIndex = 0;
  offlineFormMode = 'multi-staging';
  syncSelectedOfflineStagedFileToForm();
  renderOfflineMultiFileStaging();
  setStatus(offlineStatus, tr('offline_multi_file_staging_notice'));
}

function clearOfflineMultiFileStaging() {
  offlineStagedFiles = [];
  selectedOfflineStagedIndex = 0;
  if (offlineMultiFileStaging) offlineMultiFileStaging.hidden = true;
  if (offlineMultiFileTabs) offlineMultiFileTabs.innerHTML = '';
  if (offlineMultiFileStatus) offlineMultiFileStatus.textContent = '';
}

function createOfflineBatchJobsFromStagedFiles(stagedFiles, options = {}) {
  const items = Array.from(stagedFiles || []).filter((item) => item?.file && isSupportedOfflineAudioFile(item.file));
  if (!items.length) return [];
  const existingKeys = new Set(offlineBatchJobs.map((job) => job.fileKey || offlineFileSignature(job.file)));
  const newJobs = [];
  const fullFileRange = Boolean(options.fullFileRange);
  items.forEach((item) => {
    const key = item.fileKey || offlineFileSignature(item.file);
    if (existingKeys.has(key)) return;
    existingKeys.add(key);
    const jobOptions = fullFileRange
      ? {
        ...options,
        fileCount: items.length,
        videoId: '',
        title: '',
        requestedStartSec: 0,
        requestedEndSec: null,
        minSegmentDurationSec: normalizeMinSegmentDurationSec(options.minSegmentDurationSec ?? item.minSegmentDurationSec),
        splitMedley: Boolean(options.splitMedley ?? item.splitMedley),
        generateVisuals: options.generateVisuals !== false,
        highResolutionVisuals: Boolean(options.generateVisuals !== false && options.highResolutionVisuals),
      }
      : {
        ...options,
        fileCount: 1,
        videoId: item.videoId,
        title: item.title,
        requestedStartSec: item.requestedStartSec,
        requestedEndSec: item.requestedEndSec,
        minSegmentDurationSec: normalizeMinSegmentDurationSec(item.minSegmentDurationSec),
        splitMedley: Boolean(item.splitMedley),
        generateVisuals: item.generateVisuals !== false,
        highResolutionVisuals: Boolean(item.generateVisuals !== false && item.highResolutionVisuals),
      };
    newJobs.push(createOfflineBatchJob(item.file, offlineBatchJobs.length + newJobs.length, jobOptions));
  });

  if (newJobs.length) {
    offlineBatchJobs.push(...newJobs);
    selectedOfflineJobId = newJobs[0].id;
  }
  renderOfflineBatchList();
  renderSelectedOfflineJob();
  return newJobs;
}

function createOfflineBatchJobsFromFiles(files, options = {}) {
  const selectedFiles = Array.from(files || []);
  if (!selectedFiles.length) return [];
  showUnsupportedOfflineAudioFiles(selectedFiles);
  const supportedFiles = selectedFiles.filter(isSupportedOfflineAudioFile);
  if (!supportedFiles.length) return [];
  syncOfflineFormDataFromInputs({ render: false });

  const existingKeys = new Set(offlineBatchJobs.map((job) => job.fileKey || offlineFileSignature(job.file)));
  const newJobs = [];
  supportedFiles.forEach((file) => {
    const key = offlineFileSignature(file);
    if (existingKeys.has(key)) return;
    existingKeys.add(key);
    newJobs.push(createOfflineBatchJob(file, offlineBatchJobs.length + newJobs.length, {
      ...options,
      fileCount: supportedFiles.length,
    }));
  });

  if (newJobs.length) {
    offlineBatchJobs.push(...newJobs);
  }
  if (newJobs.length && supportedFiles.length > 1) {
    showToast(tr('offline_multi_file_notice'), { timeout: 7200 });
    setStatus(offlineStatus, tr('offline_multi_file_notice'));
  }
  if (newJobs.length) {
    selectedOfflineJobId = newJobs[0].id;
  } else if (!selectedOfflineJobId || !offlineBatchJobs.some((job) => job.id === selectedOfflineJobId)) {
    selectedOfflineJobId = offlineBatchJobs[0]?.id || null;
  }
  if (options.syncForm !== false) syncSelectedOfflineJobToForm({ mode: 'selected' });
  renderOfflineBatchList();
  renderSelectedOfflineJob();
  return newJobs;
}

function syncSelectedOfflineJobFromForm({ render = true } = {}) {
  if (offlineFormMode !== 'selected') return;
  const job = getSelectedOfflineJob();
  if (!job) return;
  job.videoId = offlineVideoId.value.trim();
  job.title = offlineTitle.value.trim();
  job.requestedStartSec = Math.max(0, readNumberInput(offlineStartSec, 0));
  job.requestedEndSec = normalizeOptionalSeconds(readNumberInput(offlineEndSec, null));
  job.minSegmentDurationSec = normalizeMinSegmentDurationSec(
    readNumberInput(offlineMinSegmentSec, job.minSegmentDurationSec ?? DEFAULT_MIN_SEGMENT_DURATION_SEC),
    job.minSegmentDurationSec ?? DEFAULT_MIN_SEGMENT_DURATION_SEC
  );
  job.splitMedley = Boolean(offlineSplitMedleyToggle?.checked);
  job.generateVisuals = offlineVisualEditorToggle?.checked !== false;
  job.highResolutionVisuals = Boolean(job.generateVisuals && offlineHighResolutionToggle?.checked);
  if (render) renderOfflineBatchList();
}

function syncSelectedOfflineJobToForm({ mode = 'selected' } = {}) {
  offlineFormMode = mode;
  const job = getSelectedOfflineJob();
  if (!job) {
    offlineVideoId.value = '';
    offlineTitle.value = '';
    return;
  }
  offlineVideoId.value = job.videoId || '';
  offlineTitle.value = job.title || '';
  if (offlineStartSec) offlineStartSec.value = formatSecondsInputValue(job.requestedStartSec ?? 0);
  if (offlineEndSec) offlineEndSec.value = formatSecondsInputValue(job.requestedEndSec);
  if (offlineMinSegmentSec) offlineMinSegmentSec.value = String(normalizeMinSegmentDurationSec(job.minSegmentDurationSec));
  if (offlineSplitMedleyToggle) offlineSplitMedleyToggle.checked = Boolean(job.splitMedley);
  if (offlineVisualEditorToggle) offlineVisualEditorToggle.checked = job.generateVisuals !== false;
  if (offlineHighResolutionToggle) offlineHighResolutionToggle.checked = Boolean(job.highResolutionVisuals);
  syncOfflineVisualOptionState();
}

function clearOfflineStagingForm() {
  offlineFormMode = 'staging';
  if (offlineAudioInput) offlineAudioInput.value = '';
  if (offlineStartSec) offlineStartSec.value = '';
  if (offlineEndSec) offlineEndSec.value = '';
  if (offlineVideoId) offlineVideoId.value = '';
  if (offlineTitle) {
    offlineTitle.value = '';
    offlineTitle.dataset.autoFilled = 'false';
  }
}
function autofillOfflineTitleFromSelectedFile() {
  if (!offlineAudioInput || !offlineTitle || offlineFormMode === 'selected') return;
  const files = Array.from(offlineAudioInput.files || []);
  if (files.length !== 1) return;
  const parsedVideoId = extractYouTubeVideoIdFromText(files[0].name);
  if (parsedVideoId && offlineVideoId && !offlineVideoId.value.trim()) {
    offlineVideoId.value = parsedVideoId;
  }
  const currentTitle = offlineTitle.value.trim();
  const wasAutoFilled = offlineTitle.dataset.autoFilled === 'true';
  if (currentTitle && !wasAutoFilled) return;
  const nextTitle = fileBaseName(files[0].name);
  if (!nextTitle) return;
  offlineTitle.value = nextTitle;
  offlineTitle.dataset.autoFilled = 'true';
}

function setOfflineActionState() {
  const selected = getSelectedOfflineJob();
  offlineAnalyzeBtn.disabled = false;
  if (offlineSkipMultiSetupBtn) {
    offlineSkipMultiSetupBtn.disabled = offlineBatchRunning || !(offlineFormMode === 'multi-staging' && offlineStagedFiles.length > 1);
  }
  if (offlinePauseBtn) {
    offlinePauseBtn.disabled = !offlineBatchRunning;
    offlinePauseBtn.textContent = tr(offlineBatchControl.paused ? 'resume_analysis' : 'pause_analysis');
  }
  if (offlineStopBtn) {
    offlineStopBtn.disabled = !offlineBatchRunning;
  }
  if (offlineSplitBtn) {
    offlineSplitBtn.disabled = offlineBatchRunning
      || !selected
      || selected.status === 'queued'
      || selected.status === 'running'
      || !Array.isArray(selected.analyses)
      || !selected.analyses.length;
  }
  offlineSaveBtn.disabled = offlineBatchRunning || !selected || !selected.segments.length;
  if (offlineSaveAllBtn) {
    offlineSaveAllBtn.disabled = offlineBatchRunning || !offlineBatchJobs.some((job) => job.segments.length);
  }
}

function selectOfflineJob(jobId) {
  if (jobId === selectedOfflineJobId) return;
  syncOfflineFormDataFromInputs({ render: false });
  if (offlineAudioPlayer && !offlineAudioPlayer.paused) offlineAudioPlayer.pause();
  selectedOfflineJobId = jobId;
  clearOfflineMultiFileStaging();
  syncSelectedOfflineJobToForm({ mode: 'selected' });
  renderOfflineBatchList();
  renderSelectedOfflineJob();
}

function deleteOfflineBatchJob(jobId) {
  const index = offlineBatchJobs.findIndex((job) => job.id === jobId);
  if (index < 0) return;
  const job = offlineBatchJobs[index];
  const title = job.title || fileBaseName(job.fileName) || job.fileName || tr('untitled_item');
  if (!window.confirm(tr('offline_delete_batch_confirm', [title]))) return;

  syncOfflineFormDataFromInputs({ render: false });
  if (job.status === 'running' || offlineBatchControl.currentJobId === job.id) {
    offlineBatchControl.stopped = true;
    offlineBatchControl.paused = false;
    offlineBatchControl.currentAbortController?.abort();
  }
  job.deleted = true;
  job.cancelRequested = true;
  if (offlineAudioPlayer?.dataset.jobId === job.id) unloadOfflineAudioPlayer();
  if (job.audioUrl) URL.revokeObjectURL(job.audioUrl);
  offlineBatchJobs.splice(index, 1);

  if (selectedOfflineJobId === job.id) {
    const nextJob = offlineBatchJobs[index] || offlineBatchJobs[index - 1] || null;
    selectedOfflineJobId = nextJob?.id || null;
    if (nextJob) syncSelectedOfflineJobToForm({ mode: 'selected' });
    else {
      offlineFormMode = 'staging';
      if (offlineVideoId) offlineVideoId.value = '';
      if (offlineTitle) offlineTitle.value = '';
    }
  }

  setStatus(offlineStatus, tr('offline_batch_deleted'));
  renderOfflineBatchList();
  renderSelectedOfflineJob();
}

function renderOfflineBatchList() {
  if (!offlineBatchList) return;
  offlineBatchRenderQueued = false;
  offlineLastBatchRenderAt = performance.now();
  if (offlineBatchCount) offlineBatchCount.textContent = String(offlineBatchJobs.length);
  offlineBatchList.innerHTML = '';
  if (!offlineBatchJobs.length) {
    offlineBatchList.innerHTML = `<div class="offline-batch-row empty-row"><div><div class="offline-batch-title">${escapeHtml(tr('offline_batch_empty'))}</div></div></div>`;
    setOfflineActionState();
    return;
  }

  for (const job of offlineBatchJobs) {
    const row = document.createElement('div');
    row.className = `offline-batch-row ${job.id === selectedOfflineJobId ? 'active' : ''} status-${job.status}`;
    row.dataset.offlineJobId = job.id;
    const runtimeLabel = formatOfflineRuntimeInfo(job.runtimeInfo);
    const statusText = job.error
      ? `${offlineStatusLabel(job.status)}: ${job.error}`
      : job.statusMessage || offlineStatusLabel(job.status);
    row.innerHTML = `
      <button class="offline-batch-select" type="button" data-select-offline-job-id="${escapeHtml(job.id)}">
        <div class="offline-batch-main">
          <div class="offline-batch-title">${escapeHtml(job.title || fileBaseName(job.fileName) || job.fileName)}</div>
          <div class="offline-batch-meta">
            <span>${escapeHtml(job.fileName)}</span>
            <span>${escapeHtml(offlineStatusLabel(job.status))}</span>
            <span>${job.segments.length} segment(s)</span>
            ${runtimeLabel ? `<span>${escapeHtml(runtimeLabel)}</span>` : ''}
          </div>
          <div class="offline-batch-status">${escapeHtml(statusText)}</div>
        </div>
        <div class="offline-batch-progress"><span style="width:${Math.round(clamp(job.progress, 0, 1) * 100)}%"></span></div>
      </button>
      <button class="offline-batch-delete-btn" type="button" data-delete-offline-job-id="${escapeHtml(job.id)}" title="${escapeHtml(tr('delete'))}" aria-label="${escapeHtml(tr('delete'))}">×</button>
    `;
    offlineBatchList.appendChild(row);
  }
  setOfflineActionState();
}

function handleOfflineBatchListClick(event) {
  const deleteButton = event.target.closest('[data-delete-offline-job-id]');
  if (deleteButton) {
    event.preventDefault();
    event.stopPropagation();
    deleteOfflineBatchJob(deleteButton.dataset.deleteOfflineJobId);
    return;
  }
  const selectButton = event.target.closest('[data-select-offline-job-id]');
  if (selectButton) {
    selectOfflineJob(selectButton.dataset.selectOfflineJobId);
  }
}

function scheduleOfflineBatchListRender({ force = false } = {}) {
  if (force) {
    renderOfflineBatchList();
    return;
  }
  if (offlineBatchRenderQueued) return;
  const elapsed = performance.now() - offlineLastBatchRenderAt;
  offlineBatchRenderQueued = true;
  const delay = Math.max(0, OFFLINE_UI_PROGRESS_THROTTLE_MS - elapsed);
  setTimeout(() => {
    requestAnimationFrame(() => renderOfflineBatchList());
  }, delay);
}

function updateOfflineAnalysisProgressUi(job, { force = false } = {}) {
  if (!job) return;
  const now = performance.now();
  if (!force && now - (job.lastUiProgressAt || 0) < OFFLINE_UI_PROGRESS_THROTTLE_MS) return;
  job.lastUiProgressAt = now;
  if (job.id === selectedOfflineJobId) {
    setProgress(offlineProgressBar, job.progress);
    setStatus(offlineStatus, job.statusMessage);
  }
}

function renderSelectedOfflineJob() {
  const job = getSelectedOfflineJob();
  offlineSegments = job?.segments || [];
  offlineBoundarySplit = job?.boundarySplit || null;
  if (job) ensureOfflineSegmentIds(job);
  syncOfflineAudioPlayerToJob(job);
  setProgress(offlineProgressBar, job ? job.progress : 0);
  setStatus(offlineStatus, job?.statusMessage || '');
  const runtimeLabel = formatOfflineRuntimeInfo(job?.runtimeInfo);
  setStatus(offlineRuntimeStatus, runtimeLabel ? tr('offline_runtime', [runtimeLabel]) : '');
  renderChips(offlineSummary, job?.summary || []);
  renderOfflineWaveform(job);
  renderBoundarySelection(offlineBoundaryDebug, job);
  renderSegments(offlineResults, offlineSegments, job?.selectedSegmentId || null);
  setOfflineActionState();
  ensureOfflineJobVisuals(job);
}

function ensureOfflineBatchJobsFromInput() {
  return offlineBatchJobs;
}

function extensionOfFile(file) {
  const match = /\.([a-z0-9]+)$/i.exec(file?.name || '');
  return match ? match[1].toLowerCase() : '';
}

function isSupportedOfflineAudioFile(file) {
  return OFFLINE_SUPPORTED_AUDIO_EXTENSIONS.has(extensionOfFile(file));
}

function showUnsupportedOfflineAudioFiles(files) {
  const unsupported = Array.from(files || []).filter((file) => !isSupportedOfflineAudioFile(file));
  if (!unsupported.length) return [];
  const message = unsupported.length === 1
    ? tr('unsupported_offline_audio_file', [unsupported[0].name || 'unknown'])
    : tr('unsupported_offline_audio_files', [unsupported.length]);
  setStatus(offlineStatus, message);
  showToast(message, { warning: true, timeout: 5200 });
  return unsupported;
}

function isMp4AacLikeFile(file) {
  const ext = extensionOfFile(file);
  return ext === 'm4a' || ext === 'mp4';
}

function buildOfflineAnalysisChunks(startSec, endSec) {
  const chunks = [];
  let coreStartSec = Math.max(0, Number(startSec) || 0);
  const boundedEndSec = Math.max(coreStartSec, Number(endSec) || coreStartSec);
  while (coreStartSec < boundedEndSec - 0.001) {
    const coreEndSec = Math.min(boundedEndSec, coreStartSec + OFFLINE_LONG_AUDIO_CHUNK_SEC);
    chunks.push({
      index: chunks.length,
      coreStartSec,
      coreEndSec,
      decodeStartSec: Math.max(startSec, coreStartSec - OFFLINE_LONG_AUDIO_OVERLAP_SEC),
      decodeEndSec: Math.min(boundedEndSec, coreEndSec + OFFLINE_LONG_AUDIO_OVERLAP_SEC),
    });
    coreStartSec = coreEndSec;
  }
  return chunks;
}

function filterChunkCoreAnalyses(analyses, chunk, isLastChunk = false) {
  const minSec = Number(chunk.coreStartSec) - 0.001;
  const maxSec = Number(chunk.coreEndSec) + 0.001;
  return (Array.isArray(analyses) ? analyses : []).filter((frame) => {
    const timeSec = Number(frame?.timeSec);
    if (!Number.isFinite(timeSec)) return false;
    return timeSec >= minSec && (isLastChunk ? timeSec <= maxSec : timeSec < maxSec);
  });
}

function mergeAnalysisFrames(frames) {
  const byTime = new Map();
  for (const frame of Array.isArray(frames) ? frames : []) {
    const timeSec = Number(frame?.timeSec);
    if (!Number.isFinite(timeSec)) continue;
    byTime.set(Math.round(timeSec * 1000), { ...frame, timeSec });
  }
  return [...byTime.values()].sort((a, b) => a.timeSec - b.timeSec);
}

function cropSeries(series, startIndex, endIndex) {
  const source = numericSeries(series);
  const from = Math.max(0, Math.min(source.length, Math.floor(startIndex)));
  const to = Math.max(from, Math.min(source.length, Math.ceil(endIndex)));
  return source.slice(from, to);
}

function cropWaveformVisual(waveform, startSec, endSec) {
  const peakCount = Math.floor(Number(waveform?.peakCount) || Number(waveform?.min?.length) || 0);
  const visualStartSec = Number(waveform?.startSec) || 0;
  const durationSec = Math.max(0.001, Number(waveform?.durationSec) || (Number(waveform?.endSec) - visualStartSec) || 0);
  if (!peakCount || !durationSec) return null;
  const cropStartSec = Math.max(visualStartSec, Number(startSec));
  const cropEndSec = Math.min(visualStartSec + durationSec, Number(endSec));
  if (cropEndSec <= cropStartSec) return null;
  const startIndex = Math.floor(((cropStartSec - visualStartSec) / durationSec) * peakCount);
  const endIndex = Math.ceil(((cropEndSec - visualStartSec) / durationSec) * peakCount);
  const min = cropSeries(waveform.min, startIndex, endIndex);
  const max = cropSeries(waveform.max, startIndex, endIndex);
  const avgMin = cropSeries(waveform.avgMin, startIndex, endIndex);
  const avgMax = cropSeries(waveform.avgMax, startIndex, endIndex);
  const croppedCount = Math.min(min.length, max.length);
  if (!croppedCount) return null;
  return {
    ...waveform,
    startSec: cropStartSec,
    endSec: cropEndSec,
    durationSec: cropEndSec - cropStartSec,
    peakCount: croppedCount,
    min,
    max,
    avgMin,
    avgMax,
  };
}

function stitchWaveformVisuals(chunks) {
  const visuals = (Array.isArray(chunks) ? chunks : []).filter(Boolean);
  if (!visuals.length) return null;
  if (visuals.length === 1) return visuals[0];
  const first = visuals[0];
  const last = visuals[visuals.length - 1];
  const totalPeaks = visuals.reduce((sum, visual) => sum + Math.min(
    numericSeries(visual.min).length,
    numericSeries(visual.max).length
  ), 0);
  if (!totalPeaks) return null;
  const fields = ['min', 'max', 'avgMin', 'avgMax'];
  const output = { ...first };
  for (const field of fields) {
    const sample = numericSeries(first[field]);
    if (!sample.length) {
      output[field] = new Int16Array(0);
      continue;
    }
    const combined = new sample.constructor(totalPeaks);
    let offset = 0;
    for (const visual of visuals) {
      const series = numericSeries(visual[field]);
      const copyLength = Math.min(series.length, totalPeaks - offset);
      if (copyLength > 0) {
        combined.set(series.slice(0, copyLength), offset);
        offset += copyLength;
      }
    }
    output[field] = combined;
  }
  output.startSec = Number(first.startSec) || 0;
  output.endSec = Number(last.endSec) || output.startSec;
  output.durationSec = Math.max(0, output.endSec - output.startSec);
  output.peakCount = totalPeaks;
  return output;
}

function cropSpectrogramVisual(spectrogram, startSec, endSec) {
  const values = numericSeries(spectrogram?.values);
  const columnCount = Math.floor(Number(spectrogram?.columnCount) || 0);
  const rowCount = Math.floor(Number(spectrogram?.binCount) || Number(spectrogram?.bandCount) || 0);
  const visualStartSec = Number(spectrogram?.startSec) || 0;
  const durationSec = Math.max(0.001, Number(spectrogram?.durationSec) || (Number(spectrogram?.endSec) - visualStartSec) || 0);
  if (!values.length || !columnCount || !rowCount || !durationSec) return null;
  const cropStartSec = Math.max(visualStartSec, Number(startSec));
  const cropEndSec = Math.min(visualStartSec + durationSec, Number(endSec));
  if (cropEndSec <= cropStartSec) return null;
  const startColumn = Math.floor(((cropStartSec - visualStartSec) / durationSec) * columnCount);
  const endColumn = Math.ceil(((cropEndSec - visualStartSec) / durationSec) * columnCount);
  const boundedStart = Math.max(0, Math.min(columnCount, startColumn));
  const boundedEnd = Math.max(boundedStart, Math.min(columnCount, endColumn));
  const croppedColumns = boundedEnd - boundedStart;
  if (!croppedColumns) return null;
  const croppedValues = new values.constructor(croppedColumns * rowCount);
  const sourceStart = boundedStart * rowCount;
  const sourceEnd = boundedEnd * rowCount;
  croppedValues.set(values.slice(sourceStart, sourceEnd), 0);
  return {
    ...spectrogram,
    startSec: cropStartSec,
    endSec: cropEndSec,
    durationSec: cropEndSec - cropStartSec,
    columnCount: croppedColumns,
    values: croppedValues,
  };
}

function stitchSpectrogramVisuals(chunks) {
  const visuals = (Array.isArray(chunks) ? chunks : []).filter(Boolean);
  if (!visuals.length) return null;
  if (visuals.length === 1) return visuals[0];
  const first = visuals[0];
  const last = visuals[visuals.length - 1];
  const rowCount = Math.floor(Number(first.binCount) || Number(first.bandCount) || 0);
  const sample = numericSeries(first.values);
  if (!rowCount || !sample.length) return null;
  const compatible = visuals.filter((visual) => {
    const rows = Math.floor(Number(visual.binCount) || Number(visual.bandCount) || 0);
    const values = numericSeries(visual.values);
    return rows === rowCount && values.length && values.constructor === sample.constructor;
  });
  const totalColumns = compatible.reduce((sum, visual) => sum + Math.floor(numericSeries(visual.values).length / rowCount), 0);
  if (!totalColumns) return null;
  const combined = new sample.constructor(totalColumns * rowCount);
  let offset = 0;
  for (const visual of compatible) {
    const values = numericSeries(visual.values);
    const copyLength = Math.floor(values.length / rowCount) * rowCount;
    combined.set(values.slice(0, copyLength), offset);
    offset += copyLength;
  }
  return {
    ...first,
    startSec: Number(first.startSec) || 0,
    endSec: Number(last.endSec) || Number(first.endSec) || 0,
    durationSec: Math.max(0, (Number(last.endSec) || 0) - (Number(first.startSec) || 0)),
    columnCount: totalColumns,
    values: combined,
  };
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

async function sliceAudioBufferForWorker(audioBuffer, startFrame, endFrame, { onProgress = null, signal = null } = {}) {
  throwIfOfflineSignalAborted(signal);
  const boundedStart = Math.max(0, Math.min(audioBuffer.length, Math.floor(startFrame)));
  const boundedEnd = Math.max(boundedStart, Math.min(audioBuffer.length, Math.ceil(endFrame)));
  const sourceFrameCount = boundedEnd - boundedStart;
  const sourceSampleRate = Math.max(8000, Number(audioBuffer.sampleRate) || 48000);
  const targetSampleRate = OFFLINE_WORKER_SAMPLE_RATE;
  const targetFrameCount = Math.max(0, Math.ceil((sourceFrameCount / sourceSampleRate) * targetSampleRate));
  const channels = Math.max(1, Math.floor(Number(audioBuffer.numberOfChannels) || 1));
  const mono = new Float32Array(targetFrameCount);
  const channelData = Array.from({ length: channels }, (_, channel) => audioBuffer.getChannelData(channel));
  const sourceStep = sourceSampleRate / targetSampleRate;

  for (let offset = 0; offset < targetFrameCount; offset += OFFLINE_TRANSFER_COPY_CHUNK_FRAMES) {
    throwIfOfflineSignalAborted(signal);
    const nextOffset = Math.min(targetFrameCount, offset + OFFLINE_TRANSFER_COPY_CHUNK_FRAMES);
    for (let targetIndex = offset; targetIndex < nextOffset; targetIndex += 1) {
      const sourcePosition = boundedStart + (targetIndex * sourceStep);
      const leftIndex = Math.min(boundedEnd - 1, Math.max(boundedStart, Math.floor(sourcePosition)));
      const rightIndex = Math.min(boundedEnd - 1, leftIndex + 1);
      const fraction = sourcePosition - leftIndex;
      let sample = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        const data = channelData[channel];
        const left = data[leftIndex] || 0;
        const right = data[rightIndex] || left;
        sample += left + ((right - left) * fraction);
      }
      mono[targetIndex] = sample / channels;
    }
    if (onProgress) onProgress({
      channel: 0,
      channelCount: 1,
      ratio: nextOffset / Math.max(1, targetFrameCount),
    });
    await nextAnimationFrame();
  }

  return {
    audio: {
      sampleRate: targetSampleRate,
      sourceSampleRate,
      numberOfChannels: 1,
      length: targetFrameCount,
      channels: [mono],
    },
    transfer: [mono.buffer],
  };
}

function runOfflineAnalysisWorker(payload, transfer, callbacks = {}) {
  return new Promise((resolve, reject) => {
    const jobId = `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const worker = new Worker(chrome.runtime.getURL('lib/songDetection/offlineDetectionWorker.js'));
    const signal = callbacks.signal || null;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', abortHandler);
      worker.terminate();
      callback(value);
    };
    const abortHandler = () => finish(reject, createOfflineAbortError());
    if (signal?.aborted) {
      abortHandler();
      return;
    }
    if (signal) signal.addEventListener('abort', abortHandler, { once: true });

    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.jobId !== jobId) return;

      if (message.type === 'progress') {
        if (callbacks.onProgress) callbacks.onProgress(message);
        else {
          setProgress(offlineProgressBar, Number(message.ratio) || 0);
          if (message.message) setStatus(offlineStatus, message.message);
        }
      } else if (message.type === 'status') {
        if (callbacks.onStatus) callbacks.onStatus(message);
        else setStatus(offlineStatus, message.message || '');
      } else if (message.type === 'model-status') {
        if (callbacks.onModelStatus) callbacks.onModelStatus(message);
        else setStatus(modelStatus, message.message || '');
      } else if (message.type === 'waveform') {
        if (callbacks.onWaveform) callbacks.onWaveform(message);
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

function runOfflineVisualWorker(payload, transfer, callbacks = {}) {
  return new Promise((resolve, reject) => {
    const jobId = `offline-visual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const worker = new Worker(chrome.runtime.getURL('lib/songDetection/offlineDetectionWorker.js'));
    const signal = callbacks.signal || null;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', abortHandler);
      worker.terminate();
      callback(value);
    };
    const abortHandler = () => finish(reject, createOfflineAbortError());
    if (signal?.aborted) {
      abortHandler();
      return;
    }
    if (signal) signal.addEventListener('abort', abortHandler, { once: true });

    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.jobId !== jobId) return;

      if (message.type === 'status') {
        if (callbacks.onStatus) callbacks.onStatus(message);
      } else if (message.type === 'complete') {
        finish(resolve, message.result || {});
      } else if (message.type === 'error') {
        const error = new Error(message.error?.message || 'Offline visual worker failed.');
        if (message.error?.stack) error.stack = message.error.stack;
        finish(reject, error);
      }
    };

    worker.onerror = (event) => {
      finish(reject, new Error(event.message || 'Offline visual worker crashed.'));
    };

    worker.postMessage({
      type: 'render-offline-visuals',
      jobId,
      payload,
    }, transfer);
  });
}

async function ensureOfflineJobVisuals(job) {
  if (!job || !job.file) return;
  if (job.status !== 'done' && job.status !== 'saved') return;
  if (job.waveform || job.spectrogram) return;
  if (job.visualsStatus === 'running' || job.visualsStatus === 'done' || job.visualsStatus === 'error' || job.visualsStatus === 'skipped') return;
  if (job.generateVisuals === false) {
    job.visualsStatus = 'skipped';
    job.visualsError = null;
    return;
  }
  if (job.chunkedAnalysis) {
    job.visualsStatus = 'skipped';
    job.visualsError = 'Long audio visual rendering is skipped to avoid excessive memory use.';
    return;
  }
  if (offlineBatchRunning) return;

  job.visualsStatus = 'running';
  job.visualsRequested = true;
  job.visualsError = null;
  const previousStatusMessage = job.statusMessage || '';
  job.statusMessage = previousStatusMessage
    ? `${previousStatusMessage} Rendering waveform/spectrogram...`
    : 'Rendering waveform/spectrogram...';
  renderOfflineBatchList();
  if (job.id === selectedOfflineJobId) {
    setStatus(offlineStatus, job.statusMessage);
    renderOfflineWaveform(job);
  }

  let audioContext = null;
  try {
    audioContext = new AudioContext();
    let decodedAudio = await decodeAudioFile(audioContext, job.file, {
      startSec: Number(job.startSec) || 0,
      endSec: Number(job.endSec) || null,
    });
    let audioBuffer = decodedAudio.audioBuffer;
    const durationSec = decodedAudio.sourceDurationSec ?? audioBuffer.duration;
    const decodedStartSec = decodedAudio.decodedStartSec ?? 0;
    const startSec = Math.min(durationSec, Number(job.startSec) || 0);
    const endSec = Math.max(startSec, Math.min(durationSec, Number(job.endSec) || durationSec));
    const sampleRate = audioBuffer.sampleRate;
    const startFrame = Math.max(0, Math.floor((startSec - decodedStartSec) * sampleRate));
    const endFrame = Math.min(audioBuffer.length, Math.ceil((endSec - decodedStartSec) * sampleRate));
    if (endFrame <= startFrame) throw new Error('Selected range has no decodable audio samples for visual rendering.');

    const { audio, transfer } = await sliceAudioBufferForWorker(audioBuffer, startFrame, endFrame);
    decodedAudio.audioBuffer = null;
    decodedAudio = null;
    audioBuffer = null;
    await audioContext.close().catch(() => {});
    audioContext = null;

    const visualResult = await runOfflineVisualWorker({
      audio,
      startSec,
      endSec,
      highResolutionVisuals: Boolean(job.highResolutionVisuals),
    }, transfer, {
      onStatus(message) {
        if (job.id === selectedOfflineJobId) setStatus(offlineStatus, message.message || '');
      },
    });

    job.waveform = visualResult.waveform || null;
    job.spectrogram = visualResult.spectrogram || null;
    job.highResolutionVisuals = Boolean(visualResult.highResolutionVisuals || job.highResolutionVisuals);
    job.visualsStatus = job.waveform || job.spectrogram ? 'done' : 'error';
    job.visualsError = visualResult.visualError?.message || null;
    job.statusMessage = previousStatusMessage || `Done. Detected ${job.segments.length} segment(s).`;
    if (job.visualsError) {
      job.summary = [...(job.summary || []).filter((item) => !String(item).startsWith('visual unavailable')), `visual unavailable: ${job.visualsError}`];
    }
  } catch (error) {
    job.visualsStatus = 'error';
    job.visualsError = error?.message || String(error);
    job.statusMessage = previousStatusMessage || `Done. Detected ${job.segments.length} segment(s).`;
    job.summary = [...(job.summary || []).filter((item) => !String(item).startsWith('visual unavailable')), `visual unavailable: ${job.visualsError}`];
  } finally {
    if (audioContext) await audioContext.close().catch(() => {});
    renderOfflineBatchList();
    if (job.id === selectedOfflineJobId) {
      setStatus(offlineStatus, job.statusMessage);
      renderSelectedOfflineJob();
    }
  }
}

async function analyzeOfflineJobInChunks(job, jobConfig, source, audioContext) {
  const signal = jobConfig.signal || null;
  const startSec = Math.min(source.durationSec, jobConfig.requestedStartSec);
  const endSec = Math.max(startSec, Math.min(source.durationSec, jobConfig.requestedEndSec || source.durationSec));
  const chunks = buildOfflineAnalysisChunks(startSec, endSec);
  if (!chunks.length) {
    throw new Error(`Selected range has no decodable audio samples. File duration is ${formatSeconds(source.durationSec)}.`);
  }

  const allAnalyses = [];
  const waveformChunks = [];
  const spectrogramChunks = [];
  let runtimeInfo = null;
  let detectorVersion = null;
  let visualError = null;
  let visualChunkCount = 0;

  job.chunkedAnalysis = true;
  job.chunkedAnalysisChunks = chunks.length;
  job.generateVisuals = Boolean(jobConfig.generateVisuals);
  job.visualsStatus = jobConfig.generateVisuals ? 'running' : 'skipped';
  job.visualsError = null;
  job.startSec = startSec;
  job.endSec = endSec;
  job.sampleRate = source.sampleRate;
  job.decoderName = source.decoderName;
  job.statusMessage = `Analyzing long audio in ${chunks.length} chunk(s)...`;
  updateOfflineAnalysisProgressUi(job, { force: true });
  scheduleOfflineBatchListRender({ force: true });

  for (let index = 0; index < chunks.length; index += 1) {
    await waitWhileOfflineBatchPaused(signal);
    if (job.deleted) throw createOfflineAbortError();
    const chunk = chunks[index];
    const chunkLabel = `${index + 1}/${chunks.length}`;
    const rangeLabel = `${formatSeconds(chunk.coreStartSec)} - ${formatSeconds(chunk.coreEndSec)}`;
    const decodeLabel = `${formatSeconds(chunk.decodeStartSec)} - ${formatSeconds(chunk.decodeEndSec)}`;

    job.statusMessage = `Decoding chunk ${chunkLabel} (${decodeLabel})...`;
    job.progress = Math.max(job.progress || 0, index / chunks.length);
    updateOfflineAnalysisProgressUi(job, { force: true });
    scheduleOfflineBatchListRender();
    await nextAnimationFrame();
    throwIfOfflineSignalAborted(signal);

    let decodedAudio = source.file && source.audioSource
      ? await decodeM4aFileWithWebCodecs(source.file, source.audioSource, {
        audioContext,
        startSec: chunk.decodeStartSec,
        endSec: chunk.decodeEndSec,
        allowFullFileFallback: false,
      })
      : await decodeM4aWithWebCodecs(source.arrayBuffer, {
        audioContext,
        startSec: chunk.decodeStartSec,
        endSec: chunk.decodeEndSec,
        allowFullFileFallback: false,
      });
    let audioBuffer = decodedAudio.audioBuffer;
    const decodedStartSec = decodedAudio.decodedStartSec ?? chunk.decodeStartSec;
    const sampleRate = Math.max(8000, Number(audioBuffer.sampleRate) || source.sampleRate || 48000);
    const startFrame = Math.max(0, Math.floor((chunk.decodeStartSec - decodedStartSec) * sampleRate));
    const endFrame = Math.min(audioBuffer.length, Math.ceil((chunk.decodeEndSec - decodedStartSec) * sampleRate));
    if (endFrame <= startFrame) {
      decodedAudio.audioBuffer = null;
      decodedAudio = null;
      audioBuffer = null;
      throw new Error(`Chunk ${chunkLabel} has no decodable audio samples.`);
    }

    const { audio, transfer } = await sliceAudioBufferForWorker(audioBuffer, startFrame, endFrame, {
      signal,
      onProgress({ ratio }) {
        const localRatio = clamp(Number(ratio) || 0, 0, 1) * 0.08;
        job.progress = clamp((index + localRatio) / chunks.length, 0, 0.98);
        job.statusMessage = `Preparing chunk ${chunkLabel}... ${Math.round((Number(ratio) || 0) * 100)}%`;
        updateOfflineAnalysisProgressUi(job);
        scheduleOfflineBatchListRender();
      },
    });
    throwIfOfflineSignalAborted(signal);
    decodedAudio.audioBuffer = null;
    decodedAudio = null;
    audioBuffer = null;
    await nextAnimationFrame();

    const result = await runOfflineAnalysisWorker({
      audio,
      startSec: chunk.decodeStartSec,
      endSec: chunk.decodeEndSec,
      splitMedley: false,
      highResolutionVisuals: Boolean(jobConfig.highResolutionVisuals),
      generateVisuals: Boolean(jobConfig.generateVisuals),
      analysisOnly: true,
      minSegmentDurationSec: jobConfig.minSegmentDurationSec,
      chunkSec: OFFLINE_ANALYSIS_CHUNK_SEC,
      rangeLabel,
    }, transfer, {
      signal,
      onProgress(message) {
        const localRatio = 0.08 + (clamp(Number(message.ratio) || 0, 0, 1) * 0.92);
        job.progress = clamp((index + localRatio) / chunks.length, 0, 0.98);
        if (message.message) job.statusMessage = `Chunk ${chunkLabel}: ${message.message}`;
        updateOfflineAnalysisProgressUi(job);
        scheduleOfflineBatchListRender();
      },
      onStatus(message) {
        const text = message.message || '';
        job.statusMessage = text.toLowerCase().includes('rendering')
          ? `Visualizing chunk ${chunkLabel}: ${text}`
          : `Chunk ${chunkLabel}: ${text}`;
        if (job.id === selectedOfflineJobId) setStatus(offlineStatus, job.statusMessage);
        scheduleOfflineBatchListRender();
      },
      onModelStatus(message) {
        job.modelStatus = message.message || '';
        if (job.id === selectedOfflineJobId) setStatus(modelStatus, `${job.modelStatus} · chunk ${chunkLabel}`);
      },
    });

    runtimeInfo = result.runtimeInfo || runtimeInfo;
    detectorVersion = result.detectorVersion || detectorVersion;
    allAnalyses.push(...filterChunkCoreAnalyses(result.analyses, chunk, index === chunks.length - 1));
    job.analyses = mergeAnalysisFrames(allAnalyses);
    if (jobConfig.generateVisuals) {
      const croppedWaveform = cropWaveformVisual(result.waveform, chunk.coreStartSec, chunk.coreEndSec);
      const croppedSpectrogram = cropSpectrogramVisual(result.spectrogram, chunk.coreStartSec, chunk.coreEndSec);
      if (croppedWaveform || croppedSpectrogram) {
        visualChunkCount += 1;
        if (croppedWaveform) waveformChunks.push(croppedWaveform);
        if (croppedSpectrogram) spectrogramChunks.push(croppedSpectrogram);
        job.statusMessage = `Visualized chunk ${chunkLabel}.`;
        updateOfflineAnalysisProgressUi(job);
      }
    }
    if (result.visualError?.message) {
      visualError = result.visualError;
    }
    scheduleOfflineBatchListRender();
    await nextAnimationFrame();
  }

  if (jobConfig.generateVisuals && (waveformChunks.length || spectrogramChunks.length)) {
    job.statusMessage = `Stitching visuals from ${visualChunkCount}/${chunks.length} chunk(s)...`;
    updateOfflineAnalysisProgressUi(job, { force: true });
    await nextAnimationFrame();
    job.waveform = stitchWaveformVisuals(waveformChunks);
    job.spectrogram = stitchSpectrogramVisuals(spectrogramChunks);
    if (job.id === selectedOfflineJobId) renderOfflineWaveform(job);
  }

  const analyses = mergeAnalysisFrames(allAnalyses);
  job.statusMessage = `Smoothing ${analyses.length} analysis windows...`;
  updateOfflineAnalysisProgressUi(job, { force: true });
  await nextAnimationFrame();

  const smoothing = smoothFireRedAnalyses(analyses, endSec, {
    startSec,
    minSegmentDurationSec: jobConfig.minSegmentDurationSec,
  });
  const baseSegments = Array.isArray(smoothing?.segments) ? smoothing.segments : [];
  let boundarySplit = null;

  job.baseSegments = baseSegments;
  job.analyses = analyses;
  job.excludedMusicOnlySpans = Array.isArray(smoothing?.excludedMusicOnlySpans) ? smoothing.excludedMusicOnlySpans : [];
  job.droppedMusicOnlySegments = Array.isArray(smoothing?.droppedMusicOnlySegments) ? smoothing.droppedMusicOnlySegments : [];
  job.boundarySelection = {};
  if (jobConfig.splitMedley) {
    boundarySplit = splitSongSegmentsByBoundaries(baseSegments, analyses);
    job.boundarySplit = boundarySplit;
    if (boundarySplit?.boundaries?.length) {
      for (const boundary of boundarySplit.boundaries) {
        job.boundarySelection[boundaryId(boundary)] = true;
      }
    }
    job.segments = boundarySplit ? buildSegmentsFromSelectedBoundaries(job) : baseSegments.slice();
  } else {
    job.boundarySplit = null;
    job.segments = baseSegments.slice();
  }

  ensureOfflineSegmentIds(job);
  job.selectedSegmentId = job.segments[0]?.id || null;
  job.runtimeInfo = runtimeInfo;
  job.highResolutionVisuals = Boolean(jobConfig.highResolutionVisuals);
  if (jobConfig.generateVisuals) {
    job.visualsStatus = job.waveform || job.spectrogram ? 'done' : 'error';
    job.visualsError = visualError?.message || (job.visualsStatus === 'error' ? 'Long audio visual rendering failed.' : null);
  } else {
    job.visualsStatus = 'skipped';
    job.visualsError = null;
  }
  job.result = {
    analysesLength: analyses.length,
    detectorVersion,
    runtimeInfo,
    highResolutionVisuals: Boolean(jobConfig.highResolutionVisuals),
    generateVisuals: Boolean(jobConfig.generateVisuals),
    visualError: job.visualsError ? { message: job.visualsError } : null,
    minSegmentDurationSec: jobConfig.minSegmentDurationSec,
    chunkedAnalysis: true,
    chunkedAnalysisChunks: chunks.length,
    smoothingMethod: smoothing?.method || null,
    smoothingVersion: smoothing?.smoothingVersion || null,
    excludedMusicOnlySpans: job.excludedMusicOnlySpans,
    droppedMusicOnlySegments: job.droppedMusicOnlySegments,
  };
  job.progress = 1;
  job.status = 'done';
  job.startSec = startSec;
  job.endSec = endSec;
  if (!Number.isFinite(Number(job.playbackCurrentSec)) || job.playbackCurrentSec < startSec || job.playbackCurrentSec > endSec) {
    job.playbackCurrentSec = startSec;
  }
  if (!Number.isFinite(Number(job.waveformViewCenterSec))) {
    job.waveformViewCenterSec = job.playbackCurrentSec;
  }
  job.minSegmentDurationSec = jobConfig.minSegmentDurationSec;
  const boundaryCount = job.boundarySplit?.boundaries?.length || 0;
  const runtimeLabel = formatOfflineRuntimeInfo(job.runtimeInfo);
  job.statusMessage = `Done. Detected ${job.segments.length} segment(s).`;
  job.summary = [
    `duration ${formatSeconds(endSec - startSec)}`,
    `sample rate ${Math.round(source.sampleRate)} Hz`,
    `decoder ${source.decoderName}`,
    `chunked ${chunks.length} chunk(s)`,
    `overlap ${Math.round(OFFLINE_LONG_AUDIO_OVERLAP_SEC)}s`,
    runtimeLabel ? `runtime ${runtimeLabel}` : null,
    `${job.segments.length} segment(s)`,
    job.droppedMusicOnlySegments.length ? `dropped long music-only ${job.droppedMusicOnlySegments.length} segment(s)` : null,
    `min segment ${job.minSegmentDurationSec}s`,
    `hop ${HOP_SEC}s`,
    !jobConfig.generateVisuals
      ? 'visual editor disabled'
      : job.visualsStatus === 'done'
      ? `visual stitched ${visualChunkCount}/${chunks.length} chunk(s)`
      : `visual unavailable: ${job.visualsError}`,
    jobConfig.generateVisuals ? (job.highResolutionVisuals ? 'visual high resolution' : 'visual standard resolution') : null,
    jobConfig.splitMedley ? `medley boundaries ${boundaryCount}` : null,
  ].filter(Boolean);
  updateOfflineAnalysisProgressUi(job, { force: true });
}

async function analyzeOfflineJob(job, config) {
  let audioContext = null;
  const requestedEndRaw = Object.prototype.hasOwnProperty.call(job, 'requestedEndSec')
    ? job.requestedEndSec
    : config.requestedEndSec;
  const jobConfig = {
    requestedStartSec: Math.max(0, Number(job.requestedStartSec ?? config.requestedStartSec) || 0),
    requestedEndSec: normalizeOptionalSeconds(requestedEndRaw),
    minSegmentDurationSec: normalizeMinSegmentDurationSec(job.minSegmentDurationSec ?? config.minSegmentDurationSec),
    splitMedley: Boolean(job.splitMedley ?? config.splitMedley),
    generateVisuals: (job.generateVisuals ?? config.generateVisuals) !== false,
    highResolutionVisuals: Boolean((job.generateVisuals ?? config.generateVisuals) !== false && (job.highResolutionVisuals ?? config.highResolutionVisuals)),
    signal: config.signal || null,
  };
  job.status = 'running';
  job.progress = 0;
  job.error = null;
  job.segments = [];
  job.baseSegments = [];
  job.analyses = [];
  job.waveform = null;
  job.spectrogram = null;
  job.generateVisuals = jobConfig.generateVisuals;
  job.visualsStatus = 'idle';
  job.visualsError = null;
  job.visualsRequested = false;
  job.chunkedAnalysis = false;
  job.chunkedAnalysisChunks = 0;
  job.boundarySplit = null;
  job.boundarySelection = {};
  job.excludedMusicOnlySpans = [];
  job.droppedMusicOnlySegments = [];
  job.selectedSegmentId = null;
  job.manualEdits = false;
  job.summary = [];
  job.lastUiProgressAt = 0;
  job.statusMessage = `Decoding ${job.fileName}...`;
  renderOfflineBatchList();
  if (job.id === selectedOfflineJobId) renderSelectedOfflineJob();
  await nextAnimationFrame();

  try {
    throwIfOfflineSignalAborted(jobConfig.signal);
    if (!isSupportedOfflineAudioFile(job.file)) {
      throw new Error(tr('unsupported_offline_audio_file', [job.fileName || 'unknown']));
    }
    audioContext = new AudioContext();
    if (isMp4AacLikeFile(job.file)) {
      let longAudioSource = null;
      try {
        job.statusMessage = `Reading audio metadata for ${job.fileName}...`;
        updateOfflineAnalysisProgressUi(job, { force: true });
        scheduleOfflineBatchListRender();
        const audioSource = await loadM4aAudioSourceFromFile(job.file);
        const durationSec = Math.max(0, Number(audioSource.durationSec) || 0);
        const startSec = Math.min(durationSec, jobConfig.requestedStartSec);
        const endSec = Math.max(startSec, Math.min(durationSec, jobConfig.requestedEndSec || durationSec));
        if (endSec - startSec >= OFFLINE_LONG_AUDIO_THRESHOLD_SEC) {
          longAudioSource = {
            file: job.file,
            audioSource,
            durationSec,
            sampleRate: Number(audioSource.sampleRate) || OFFLINE_WORKER_SAMPLE_RATE,
            decoderName: `WebCodecs ${audioSource.codec} chunked file-range`,
          };
        }
      } catch (metadataError) {
        console.warn('[YTJ] MP4/AAC metadata read failed; falling back to normal decode.', metadataError);
      }
      if (longAudioSource) {
        await analyzeOfflineJobInChunks(job, jobConfig, longAudioSource, audioContext);
        return;
      }
    }
    let decodedAudio = await decodeAudioFile(audioContext, job.file, {
      startSec: jobConfig.requestedStartSec,
      endSec: jobConfig.requestedEndSec,
    });
    throwIfOfflineSignalAborted(jobConfig.signal);
    let audioBuffer = decodedAudio.audioBuffer;
    const decoderName = decodedAudio.decoderName;
    const durationSec = decodedAudio.sourceDurationSec ?? audioBuffer.duration;
    const decodedStartSec = decodedAudio.decodedStartSec ?? 0;
    const startSec = Math.min(durationSec, jobConfig.requestedStartSec);
    const endSec = Math.max(startSec, Math.min(durationSec, jobConfig.requestedEndSec || durationSec));
    const sampleRate = audioBuffer.sampleRate;
    const startFrame = Math.max(0, Math.floor((startSec - decodedStartSec) * sampleRate));
    const endFrame = Math.min(audioBuffer.length, Math.ceil((endSec - decodedStartSec) * sampleRate));
    if (endFrame <= startFrame) {
      throw new Error(`Selected range has no decodable audio samples. File duration is ${formatSeconds(durationSec)}.`);
    }
    const rangeLabel = `${formatSeconds(startSec)} - ${formatSeconds(endSec)}`;
    job.statusMessage = `Preparing worker buffer for ${job.fileName} (${rangeLabel})...`;
    renderOfflineBatchList();
    if (job.id === selectedOfflineJobId) renderSelectedOfflineJob();
    await nextAnimationFrame();

    const { audio, transfer } = await sliceAudioBufferForWorker(audioBuffer, startFrame, endFrame, {
      signal: jobConfig.signal,
      onProgress({ ratio }) {
        job.progress = Math.min(0.08, (Number(ratio) || 0) * 0.08);
        job.statusMessage = `Preparing worker buffer... ${Math.round((Number(ratio) || 0) * 100)}%`;
        updateOfflineAnalysisProgressUi(job);
        scheduleOfflineBatchListRender();
      },
    });
    decodedAudio.audioBuffer = null;
    decodedAudio = null;
    audioBuffer = null;
    await audioContext.close().catch(() => {});
    audioContext = null;

    const result = await runOfflineAnalysisWorker({
      audio,
      startSec,
      endSec,
      splitMedley: jobConfig.splitMedley,
      highResolutionVisuals: jobConfig.highResolutionVisuals,
      generateVisuals: false,
      minSegmentDurationSec: jobConfig.minSegmentDurationSec,
      chunkSec: OFFLINE_ANALYSIS_CHUNK_SEC,
      rangeLabel,
    }, transfer, {
      signal: jobConfig.signal,
      onProgress(message) {
        job.progress = Number(message.ratio) || 0;
        if (message.message) job.statusMessage = message.message;
        updateOfflineAnalysisProgressUi(job);
        scheduleOfflineBatchListRender();
      },
      onStatus(message) {
        job.statusMessage = message.message || '';
        if (job.id === selectedOfflineJobId) setStatus(offlineStatus, job.statusMessage);
        scheduleOfflineBatchListRender({ force: true });
      },
      onModelStatus(message) {
        job.modelStatus = message.message || '';
        if (job.id === selectedOfflineJobId) setStatus(modelStatus, job.modelStatus);
      },
      onWaveform(message) {
        job.waveform = message.waveform || null;
        job.spectrogram = message.spectrogram || null;
        if (job.id === selectedOfflineJobId) renderOfflineWaveform(job);
      },
    });

    job.baseSegments = Array.isArray(result.baseSegments) ? result.baseSegments : (Array.isArray(result.segments) ? result.segments : []);
    job.analyses = Array.isArray(result.analyses) ? result.analyses : [];
    job.waveform = result.waveform || job.waveform || null;
    job.spectrogram = result.spectrogram || job.spectrogram || null;
    job.boundarySplit = result.boundarySplit || null;
    job.excludedMusicOnlySpans = Array.isArray(result.excludedMusicOnlySpans) ? result.excludedMusicOnlySpans : [];
    job.droppedMusicOnlySegments = Array.isArray(result.droppedMusicOnlySegments) ? result.droppedMusicOnlySegments : [];
    job.boundarySelection = {};
    if (job.boundarySplit?.boundaries?.length) {
      for (const boundary of job.boundarySplit.boundaries) {
        job.boundarySelection[boundaryId(boundary)] = true;
      }
    }
    job.segments = job.boundarySplit ? buildSegmentsFromSelectedBoundaries(job) : job.baseSegments.slice();
    ensureOfflineSegmentIds(job);
    job.selectedSegmentId = job.segments[0]?.id || null;
    job.runtimeInfo = result.runtimeInfo || null;
    job.highResolutionVisuals = Boolean(result.highResolutionVisuals || jobConfig.highResolutionVisuals);
    job.result = {
      analysesLength: result.analysesLength || job.analyses.length,
      detectorVersion: result.detectorVersion || null,
      runtimeInfo: result.runtimeInfo || null,
      highResolutionVisuals: Boolean(result.highResolutionVisuals),
      generateVisuals: Boolean(jobConfig.generateVisuals),
      visualError: result.visualError || null,
      minSegmentDurationSec: result.minSegmentDurationSec || jobConfig.minSegmentDurationSec,
      smoothingMethod: result.smoothingMethod || null,
      smoothingVersion: result.smoothingVersion || null,
      excludedMusicOnlySpans: job.excludedMusicOnlySpans,
      droppedMusicOnlySegments: job.droppedMusicOnlySegments,
    };
    job.progress = 1;
    job.status = 'done';
    job.startSec = startSec;
    job.endSec = endSec;
    if (!Number.isFinite(Number(job.playbackCurrentSec)) || job.playbackCurrentSec < startSec || job.playbackCurrentSec > endSec) {
      job.playbackCurrentSec = startSec;
    }
    if (!Number.isFinite(Number(job.waveformViewCenterSec))) {
      job.waveformViewCenterSec = job.playbackCurrentSec;
    }
    job.sampleRate = sampleRate;
    job.decoderName = decoderName;
    job.minSegmentDurationSec = result.minSegmentDurationSec || jobConfig.minSegmentDurationSec;
    if (!jobConfig.generateVisuals) {
      job.visualsStatus = 'skipped';
      job.visualsError = null;
    }
    const boundaryCount = job.boundarySplit?.boundaries?.length || 0;
    const runtimeLabel = formatOfflineRuntimeInfo(job.runtimeInfo);
    const visualWarning = result.visualError?.message
      ? `visual unavailable: ${result.visualError.message}`
      : null;
    job.statusMessage = visualWarning
      ? `Done. Detected ${job.segments.length} segment(s). ${visualWarning}`
      : `Done. Detected ${job.segments.length} segment(s).`;
    job.summary = [
      `duration ${formatSeconds(endSec - startSec)}`,
      `sample rate ${Math.round(sampleRate)} Hz`,
      `decoder ${decoderName}`,
      runtimeLabel ? `runtime ${runtimeLabel}` : null,
      `${job.segments.length} segment(s)`,
      job.droppedMusicOnlySegments.length ? `dropped long music-only ${job.droppedMusicOnlySegments.length} segment(s)` : null,
      `min segment ${job.minSegmentDurationSec}s`,
      `hop ${HOP_SEC}s`,
      jobConfig.generateVisuals
        ? (job.highResolutionVisuals ? 'visual high resolution' : 'visual standard resolution')
        : 'visual editor disabled',
      visualWarning,
      jobConfig.splitMedley ? `medley boundaries ${boundaryCount}` : null,
    ].filter(Boolean);
    updateOfflineAnalysisProgressUi(job, { force: true });
  } catch (error) {
    if (isOfflineAbortError(error)) {
      job.status = 'stopped';
      job.error = null;
      job.statusMessage = tr('offline_analysis_stopped');
    } else {
      job.status = 'error';
      job.error = error?.message || String(error);
      job.statusMessage = `Error: ${job.error}`;
      job.progress = 0;
    }
    updateOfflineAnalysisProgressUi(job, { force: true });
    throw error;
  } finally {
    if (audioContext) await audioContext.close().catch(() => {});
    scheduleOfflineBatchListRender({ force: true });
    if (job.id === selectedOfflineJobId) renderSelectedOfflineJob();
  }
}

async function analyzeOfflineAudio(options = {}) {
  let startedQueue = false;
  try {
    const skipMultiSetup = Boolean(options.skipMultiSetup);
    const config = {
      requestedStartSec: Math.max(0, readNumberInput(offlineStartSec, 0)),
      requestedEndSec: readNumberInput(offlineEndSec, null),
      minSegmentDurationSec: normalizeMinSegmentDurationSec(readNumberInput(offlineMinSegmentSec, DEFAULT_MIN_SEGMENT_DURATION_SEC)),
      splitMedley: Boolean(offlineSplitMedleyToggle?.checked),
      generateVisuals: offlineVisualEditorToggle?.checked !== false,
      highResolutionVisuals: Boolean(offlineVisualEditorToggle?.checked !== false && offlineHighResolutionToggle?.checked),
    };
    offlineMinSegmentSec.value = String(config.minSegmentDurationSec);
    await saveSongDetectionConfig({ minSegmentDurationSec: config.minSegmentDurationSec });

    const selectedFiles = Array.from(offlineAudioInput.files || []);
    if (offlineFormMode === 'multi-staging' && offlineStagedFiles.length > 1) {
      syncSelectedOfflineStagedFileFromForm({ render: false });
      if (!skipMultiSetup) {
        const missingIndex = offlineStagedFiles.findIndex((item) => !String(item.videoId || '').trim());
        if (missingIndex >= 0) {
          selectOfflineStagedFile(missingIndex);
          renderOfflineMultiFileStaging();
          setStatus(offlineStatus, tr('offline_multi_file_requires_setup'));
          return;
        }
      }
      createOfflineBatchJobsFromStagedFiles(offlineStagedFiles, {
        ...config,
        fullFileRange: skipMultiSetup,
      });
      if (skipMultiSetup) {
        setStatus(offlineStatus, tr('offline_multi_file_notice'));
      }
      clearOfflineStagingForm();
      clearOfflineMultiFileStaging();
      syncSelectedOfflineJobToForm({ mode: 'selected' });
      renderOfflineBatchList();
      renderSelectedOfflineJob();
    } else if (selectedFiles.length) {
      createOfflineBatchJobsFromFiles(selectedFiles, {
        ...config,
        videoId: offlineVideoId.value,
        title: offlineTitle.value,
        generateVisuals: config.generateVisuals,
        highResolutionVisuals: config.highResolutionVisuals,
        syncForm: false,
      });
      clearOfflineStagingForm();
      syncSelectedOfflineJobToForm({ mode: 'selected' });
      renderOfflineBatchList();
      renderSelectedOfflineJob();
    } else {
      syncOfflineFormDataFromInputs({ render: false });
    }

    if (!offlineBatchJobs.length) { setStatus(offlineStatus, tr('select_audio_file')); return; }
    if (offlineBatchRunning) {
      setStatus(offlineStatus, tr('offline_batch_queued'));
      return;
    }

    offlineBatchControl = {
      paused: false,
      stopped: false,
      currentAbortController: null,
      currentJobId: null,
    };
    offlineBatchRunning = true;
    startedQueue = true;
    setOfflineActionState();

    const jobsToAnalyze = offlineBatchJobs
      .filter((job) => job.status === 'queued' || job.status === 'error' || job.status === 'stopped')
      .slice();
    if (!jobsToAnalyze.length) {
      setStatus(offlineStatus, tr('offline_no_queued_jobs'));
      return;
    }

    let completed = 0;
    for (let index = 0; index < jobsToAnalyze.length; index += 1) {
      await waitWhileOfflineBatchPaused();
      if (offlineBatchControl.stopped) break;
      const job = jobsToAnalyze[index];
      if (!offlineBatchJobs.includes(job) || job.deleted) continue;
      const abortController = new AbortController();
      offlineBatchControl.currentAbortController = abortController;
      offlineBatchControl.currentJobId = job.id;
      renderOfflineBatchList();
      try {
        await analyzeOfflineJob(job, { ...config, signal: abortController.signal });
      } catch (error) {
        if (isOfflineAbortError(error)) {
          setStatus(offlineStatus, tr('offline_analysis_stopped'));
          setStatus(modelStatus, '');
          if (offlineBatchControl.stopped) break;
        } else {
          setStatus(offlineStatus, `Error: ${error?.message || String(error)}`);
          setStatus(modelStatus, 'Model: error');
        }
      } finally {
        if (offlineBatchControl.currentAbortController === abortController) {
          offlineBatchControl.currentAbortController = null;
          offlineBatchControl.currentJobId = null;
        }
      }
      completed += 1;
      setStatus(offlineStatus, `Batch ${completed}/${jobsToAnalyze.length}: ${job.statusMessage}`);
      const appendedJobs = offlineBatchJobs.filter((candidate) => (
        (candidate.status === 'queued' || candidate.status === 'error' || candidate.status === 'stopped')
        && !jobsToAnalyze.includes(candidate)
      ));
      jobsToAnalyze.push(...appendedJobs);
    }
  } catch (error) {
    setStatus(offlineStatus, `Error: ${error?.message || String(error)}`);
  } finally {
    if (startedQueue) offlineBatchRunning = false;
    offlineBatchControl = {
      paused: false,
      stopped: false,
      currentAbortController: null,
      currentJobId: null,
    };
    setOfflineActionState();
    renderOfflineBatchList();
    renderSelectedOfflineJob();
  }
}

function toggleOfflineBatchPause() {
  if (!offlineBatchRunning) return;
  offlineBatchControl.paused = !offlineBatchControl.paused;
  setStatus(offlineStatus, tr(offlineBatchControl.paused ? 'offline_analysis_paused' : 'offline_analysis_resumed'));
  setOfflineActionState();
}

function stopOfflineBatchAnalysis() {
  if (!offlineBatchRunning) return;
  offlineBatchControl.stopped = true;
  offlineBatchControl.paused = false;
  offlineBatchControl.currentAbortController?.abort();
  setStatus(offlineStatus, tr('offline_analysis_stopped'));
  setOfflineActionState();
}

async function runMedleySplitForSelectedJob() {
  syncOfflineFormDataFromInputs();
  const job = getSelectedOfflineJob();
  if (!job || !Array.isArray(job.analyses) || !job.analyses.length || !job.baseSegments.length) {
    setStatus(offlineStatus, tr('boundary_split_requires_done'));
    return;
  }
  if (job.manualEdits && !window.confirm(tr('offline_manual_edits_confirm'))) return;

  const splitResult = splitSongSegmentsByBoundaries(job.baseSegments, job.analyses);
  job.boundarySplit = splitResult;
  job.boundarySelection = {};
  for (const boundary of splitResult.boundaries || []) {
    job.boundarySelection[boundaryId(boundary)] = true;
  }
  job.segments = splitResult.boundaries?.length ? buildSegmentsFromSelectedBoundaries(job) : job.baseSegments.slice();
  job.manualEdits = false;
  ensureOfflineSegmentIds(job);
  job.selectedSegmentId = job.segments[0]?.id || null;
  const message = splitResult.boundaries?.length
    ? tr('boundary_split_applied', [splitResult.boundaries.length])
    : tr('boundary_split_no_candidates');
  job.statusMessage = message;
  setStatus(offlineStatus, message);
  renderOfflineBatchList();
  renderSelectedOfflineJob();
}

function sortPlaylistItems(a, b) { if (a.startSec !== b.startSec) return a.startSec - b.startSec; if (a.endSec !== b.endSec) return a.endSec - b.endSec; return String(a.title || '').localeCompare(String(b.title || '')); }
async function saveOfflineJob(job, { switchToGlobal = false } = {}) {
  if (!job) { setStatus(offlineStatus, tr('no_segments_to_save')); return 0; }
  ensureOfflineSegmentIds(job);
  sortOfflineSegments(job);
  const videoId = String(job.videoId || '').trim();
  if (!videoId) { setStatus(offlineStatus, tr('enter_video_id')); return 0; }
  if (!job.segments.length) { setStatus(offlineStatus, tr('no_segments_to_save')); return 0; }
  const itemsKey = `playlist_${videoId}`;
  const metaKey = `playlist_meta_${videoId}`;
  const store = await chrome.storage.local.get([itemsKey, metaKey]);
  const existingMeta = store[metaKey] || {};
  const existing = normalizePlaylist(store[itemsKey] || [], existingMeta).items;
  const kept = existing.filter((item) => !(item.type === AUTO_SONG_TYPE && item.source === OFFLINE_SOURCE));
  const now = new Date().toISOString();
  const autoItems = job.segments.map((segment, index) => normalizePlaylistItem({
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
    title: String(job.title || '').trim() || existingMeta.title || null,
    lastModified: now,
    lastAnalyzedAt: now,
    detectorVersion: OFFLINE_DETECTOR_VERSION,
    source: 'offlineAudio',
    finalSegments: job.segments,
    provisionalSegments: [],
    boundaryDetectorVersion: job.boundarySplit?.detectorVersion || null,
    boundarySegments: job.boundarySplit?.boundaries || [],
  });
  await writePlaylistStorage(() => chrome.storage.local.set({ [itemsKey]: serializePlaylist(nextItems), [metaKey]: nextMeta }));
  job.status = 'saved';
  job.statusMessage = tr('saved_segments_to', [autoItems.length, videoId]);
  renderOfflineBatchList();
  setStatus(storageStatus, `Storage: saved ${videoId}`);
  setStatus(offlineStatus, tr('saved_segments_to', [autoItems.length, videoId]));
  if (switchToGlobal) setActiveView('global');
  return autoItems.length;
}

async function saveOfflineSegments() {
  syncOfflineFormDataFromInputs();
  const job = getSelectedOfflineJob();
  const savedCount = await saveOfflineJob(job, { switchToGlobal: true });
  if (!savedCount) return;
  await refreshGlobalPlaylist();
  await refreshDatabaseEditor();
}

async function saveAllOfflineSegments() {
  syncOfflineFormDataFromInputs();
  let savedJobs = 0;
  for (const job of offlineBatchJobs) {
    if (!job.segments.length) continue;
    if (!String(job.videoId || '').trim()) {
      selectOfflineJob(job.id);
      setStatus(offlineStatus, tr('batch_job_needs_video_id', [job.title || job.fileName]));
      return;
    }
    const savedCount = await saveOfflineJob(job, { switchToGlobal: false });
    if (savedCount) savedJobs += 1;
  }
  setStatus(offlineStatus, tr('saved_all_segments', [savedJobs]));
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
    row.innerHTML = `<button class="database-drag-handle" type="button" aria-label="${escapeHtml(tr('drag_reorder_segment'))}" title="${escapeHtml(tr('drag_reorder_segment'))}"><span class="queue-grip" aria-hidden="true">⋮⋮</span></button><div class="database-track-fields"><input class="database-track-title" data-db-field="title" data-item-id="${escapeHtml(item.id)}" type="text" value="${escapeHtml(item.title || '')}" placeholder="${escapeHtml(tr('song_title_placeholder'))}"><div class="database-time-fields"><label>Start <input data-db-field="startSec" data-item-id="${escapeHtml(item.id)}" type="text" value="${formatSecondsFixedMillis(item.startSec)}"></label><label>End <input data-db-field="endSec" data-item-id="${escapeHtml(item.id)}" type="text" value="${formatSecondsFixedMillis(item.endSec)}"></label><span class="song-type ${item.type === AUTO_SONG_TYPE ? 'auto-song' : ''}">#${index + 1} ${typeLabel}</span></div></div><button class="database-delete-btn" type="button" data-delete-db-item-id="${escapeHtml(item.id)}">${escapeHtml(tr('delete'))}</button>`;
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
  return `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}&t=${formatUrlSeconds(item.startSec)}s&autoplay=1`;
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
  installOfflineAudioDebugInterface();
  sidebarToggle.addEventListener('click', () => {
    const collapsed = appShell.classList.toggle('sidebar-collapsed');
    sidebarToggle.setAttribute('aria-label', collapsed ? tr('sidebar_expand') : tr('sidebar_collapse'));
    sidebarToggle.title = collapsed ? tr('sidebar_expand') : tr('sidebar_collapse');
  });
  for (const item of navItems) item.addEventListener('click', () => setActiveView(item.dataset.view));
  offlineAudioInput.addEventListener('change', () => {
    syncOfflineFormDataFromInputs({ render: false });
    offlineFormMode = 'staging';
    const selectedFiles = Array.from(offlineAudioInput.files || []);
    if (!selectedFiles.length) {
      clearOfflineMultiFileStaging();
      setOfflineActionState();
      return;
    }
    const unsupported = showUnsupportedOfflineAudioFiles(selectedFiles);
    if (unsupported.length === selectedFiles.length) {
      offlineAudioInput.value = '';
      clearOfflineMultiFileStaging();
      setOfflineActionState();
      return;
    }
    const supportedCount = selectedFiles.filter(isSupportedOfflineAudioFile).length;
    if (supportedCount > 1) {
      startOfflineMultiFileStaging(selectedFiles);
    } else {
      clearOfflineMultiFileStaging();
      autofillOfflineTitleFromSelectedFile();
    }
    setOfflineActionState();
  });
  offlineVideoId.addEventListener('input', syncOfflineFormDataFromInputs);
  offlineTitle.addEventListener('input', () => {
    offlineTitle.dataset.autoFilled = 'false';
    syncOfflineFormDataFromInputs();
  });
  offlineStartSec?.addEventListener('change', syncOfflineFormDataFromInputs);
  offlineEndSec?.addEventListener('change', syncOfflineFormDataFromInputs);
  offlineAnalyzeBtn.addEventListener('click', analyzeOfflineAudio);
  offlineSkipMultiSetupBtn?.addEventListener('click', () => analyzeOfflineAudio({ skipMultiSetup: true }));
  offlineMultiFileTabs?.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-offline-staged-index]');
    if (!tab) return;
    selectOfflineStagedFile(tab.dataset.offlineStagedIndex);
  });
  offlinePauseBtn?.addEventListener('click', toggleOfflineBatchPause);
  offlineStopBtn?.addEventListener('click', stopOfflineBatchAnalysis);
  offlineBatchList?.addEventListener('click', handleOfflineBatchListClick);
  offlineSplitBtn?.addEventListener('click', runMedleySplitForSelectedJob);
  offlineSaveBtn.addEventListener('click', saveOfflineSegments);
  offlineSaveAllBtn?.addEventListener('click', saveAllOfflineSegments);
  offlinePlayPauseBtn?.addEventListener('click', () => {
    toggleOfflineAudioPlayback().catch((error) => setStatus(offlineStatus, error?.message || String(error)));
  });
  offlineAudioPlayer?.addEventListener('loadedmetadata', handleOfflineAudioReady);
  offlineAudioPlayer?.addEventListener('canplay', handleOfflineAudioReady);
  offlineAudioPlayer?.addEventListener('error', handleOfflineAudioError);
  offlineAudioPlayer?.addEventListener('timeupdate', handleOfflineAudioTimeUpdate);
  offlineAudioPlayer?.addEventListener('play', handleOfflineAudioPlay);
  offlineAudioPlayer?.addEventListener('pause', handleOfflineAudioPause);
  offlineAudioPlayer?.addEventListener('ended', handleOfflineAudioPause);
  offlineWaveformShell?.addEventListener('pointerdown', startOfflineWaveformPointer);
  offlineWaveformShell?.addEventListener('dblclick', handleOfflineWaveformDoubleClick);
  offlineWaveformShell?.addEventListener('wheel', handleOfflineWaveformWheel, { passive: false });
  offlineZoomInBtn?.addEventListener('click', () => zoomOfflineWaveform(1));
  offlineZoomOutBtn?.addEventListener('click', () => zoomOfflineWaveform(-1));
  offlineSpectrogramModeBtn?.addEventListener('click', () => setOfflineVisualMode('spectrogram'));
  offlineWaveformModeBtn?.addEventListener('click', () => setOfflineVisualMode('waveform'));
  offlineFollowPlayheadToggle?.addEventListener('change', () => {
    setOfflineWaveformFollowPlayhead(Boolean(offlineFollowPlayheadToggle.checked));
  });
  offlineVolumeSlider?.addEventListener('input', syncOfflineAudioVolume);
  offlineVisualGainSlider?.addEventListener('input', () => {
    setOfflineVisualGain(offlineVisualGainSlider.value);
  });
  offlineViewScrollBar?.addEventListener('input', () => {
    setOfflineWaveformViewFromScroll(offlineViewScrollBar.value);
  });
  offlineResults?.addEventListener('click', handleOfflineResultsClick);
  offlineSegmentTitleInput?.addEventListener('change', () => updateSelectedOfflineSegmentField('title', offlineSegmentTitleInput.value));
  offlineSegmentStartInput?.addEventListener('change', () => updateSelectedOfflineSegmentField('startSec', offlineSegmentStartInput.value));
  offlineSegmentEndInput?.addEventListener('change', () => updateSelectedOfflineSegmentField('endSec', offlineSegmentEndInput.value));
  offlineDeleteSegmentBtn?.addEventListener('click', deleteSelectedOfflineSegment);
  offlineMinSegmentSec.addEventListener('change', () => {
    const value = normalizeMinSegmentDurationSec(readNumberInput(offlineMinSegmentSec, DEFAULT_MIN_SEGMENT_DURATION_SEC));
    offlineMinSegmentSec.value = String(value);
    syncOfflineFormDataFromInputs();
    if (settingsMinSegmentSec) settingsMinSegmentSec.value = String(value);
    saveSongDetectionConfig({ minSegmentDurationSec: value })
      .catch((error) => showToast(tr('settings_save_failed', [error?.message || String(error)]), { warning: true }));
  });
  offlineSplitMedleyToggle.addEventListener('change', () => {
    syncOfflineFormDataFromInputs();
    saveUserPreferences({ offlineSplitMedleyDefault: Boolean(offlineSplitMedleyToggle.checked) })
      .then(() => renderSettingsForm({ minSegmentDurationSec: offlineMinSegmentSec.value }))
      .catch((error) => showToast(tr('settings_save_failed', [error?.message || String(error)]), { warning: true }));
  });
  offlineVisualEditorToggle?.addEventListener('change', () => {
    syncOfflineVisualOptionState();
    syncOfflineFormDataFromInputs();
    saveUserPreferences({
      offlineVisualEditorDefault: offlineVisualEditorToggle.checked,
      offlineHighResolutionDefault: Boolean(offlineVisualEditorToggle.checked && offlineHighResolutionToggle?.checked),
    })
      .then(() => renderSettingsForm({ minSegmentDurationSec: offlineMinSegmentSec.value }))
      .catch((error) => showToast(tr('settings_save_failed', [error?.message || String(error)]), { warning: true }));
  });
  offlineHighResolutionToggle?.addEventListener('change', () => {
    syncOfflineFormDataFromInputs();
    saveUserPreferences({ offlineHighResolutionDefault: Boolean(offlineVisualEditorToggle?.checked !== false && offlineHighResolutionToggle.checked) })
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
  settingsVisualEditorDefault?.addEventListener('change', syncOfflineVisualOptionState);
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
  if (offlineWaveformShell && 'ResizeObserver' in window) {
    offlineWaveformResizeObserver = new ResizeObserver(() => renderOfflineWaveform(getSelectedOfflineJob()));
    offlineWaveformResizeObserver.observe(offlineWaveformShell);
  }
  window.addEventListener('beforeunload', () => {
    revokeOfflineJobUrls(offlineBatchJobs);
    offlineWaveformResizeObserver?.disconnect();
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
  offlineVisualEditorToggle.checked = userPreferences.offlineVisualEditorDefault !== false;
  offlineHighResolutionToggle.checked = Boolean(userPreferences.offlineHighResolutionDefault);
  syncOfflineVisualOptionState();
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
