document.addEventListener('DOMContentLoaded', async () => {
    const DETECTION_CONFIG_KEY = 'songDetectionConfig';
    const APP_PREFERENCES_KEY = 'ytjUserPreferences';
    const DEFAULT_MIN_SEGMENT_DURATION_SEC = 90;
    const LIVE_ANALYSIS_METHODS = {
        AED_CACHE_60S: 'aed-cache-60s',
        PCM_ROLLOVER_30MIN: 'pcm-rollover-30min',
    };
    const DEFAULT_LIVE_ANALYSIS_METHOD = LIVE_ANALYSIS_METHODS.AED_CACHE_60S;
    const FEATURE_NOTICE_ID = 'release-3.0.2-update-and-onboarding';
    const FEATURE_NOTICE_STORAGE_KEY = 'popupFeatureNoticeState';
    const FEATURE_NOTICE_CONTEXT_KEY = 'popupFeatureNoticeContext';
    const FEATURE_NOTICE_FROM_VERSION = '2.0';
    const FEATURE_NOTICE_TO_VERSION = chrome.runtime.getManifest?.().version || '3.0.2';
    const UI_TEXT = {
        en: {
            extensionName: 'YouTube Auto Jump',
            toggle_on: 'Enabled',
            toggle_off: 'Disabled',
            export_all: 'Export playlists',
            import_playlists: 'Import playlists',
            video_id_prefix: 'Video ID:',
            timepoints_suffix: 'timepoints',
            search_placeholder: 'Search...',
            sort_lastModified_desc: 'Last modified ↓',
            sort_lastModified_asc: 'Last modified ↑',
            sort_uploadTime_desc: 'Upload time ↓',
            sort_uploadTime_asc: 'Upload time ↑',
            sort_playlists_label: 'Sort playlists',
            search_scope_label: 'Search scope',
            search_scope_all: 'All',
            search_scope_title: 'Title',
            expand_playlist: 'Show items',
            collapse_playlist: 'Hide items',
            deleted_empty_playlists: 'Deleted $1 empty playlists.',
            import_success: 'Playlists imported successfully.',
            import_failed: 'Import failed. Please check the file format.',
            detect_eyebrow: 'Auto Detection',
            detect_title: 'Song Segment Detection',
            start_detect: 'Start Detect',
            stop_detect: 'Stop Detect',
            min_segment_seconds: 'Min segment seconds',
            live_method_label: 'Live method',
            live_method_aed_cache_60s: '60s AED cache',
            live_method_pcm_rollover: '30min PCM cache',
            playlist_studio: 'Playlist Studio',
            feature_update_title: `What's new in ${FEATURE_NOTICE_TO_VERSION}`,
            feature_update_intro: `Compared with the previous $1 release, this version adds:`,
            feature_update_items: [
                'Local song segment detection for YouTube videos and live streams.',
                'Playlist Studio with cross-video playback queues, database editing, and settings.',
                'Offline audio analysis with waveform/spectrogram editing, batch jobs, and automatic videoId parsing from filenames.',
                'Better post-processing for medleys, long BGM/music-only false positives, and configurable minimum segment duration.',
            ],
            feature_install_title: 'Welcome to YouTube Timeline Jumper',
            feature_install_intro: 'This extension helps you save, edit, detect, and replay YouTube timeline segments locally.',
            feature_install_items: [
                'Turn the extension on from this popup, then open a YouTube video to edit timestamps on the page.',
                'Use Playlist Studio for global playlists, cross-video queues, database editing, and offline analysis.',
                'Start Detect requires opening this popup from the target YouTube tab so Chrome can grant tab audio capture.',
            ],
            feature_notice_dismiss: 'Got it',
            status_label: 'Status',
            status_idle: 'Idle',
            status_listening: 'Listening',
            status_detecting: 'Detecting',
            status_postprocessing: 'Post-processing',
            status_stopped: 'Stopped',
            status_error: 'Error',
            no_active_youtube_tab: 'No active YouTube tab.',
            no_active_youtube_tab_in_window: 'No active YouTube tab in this window.',
            permission_required: 'Permission required. Click "Start Detect" to grant tabCapture.',
            waiting_authorization: 'Still waiting for tabCapture authorization. Keep the popup open and retry.',
            switch_to_youtube_tab_for_capture: 'Switch to the YouTube tab you want to detect, click the extension icon there, then press "Start Detect".',
            start_detection_failed: 'Start detection failed.',
            stop_detection_failed: 'Stop detection failed.',
            set_min_failed: 'Failed to update minimum segment duration.',
            set_min_failed_with_error: 'Set minimum duration failed: $1',
            notice_update_failed: 'Notice update failed: $1',
            song_detection_started: 'Song detection started.',
            song_detection_stopped: 'Song detection stopped.',
            runtime_threads: 'WASM threads: $1',
            runtime_threads_with_reason: 'WASM threads: $1 ($2)',
            runtime_webgpu: 'Runtime: WebGPU',
            runtime_webgpu_with_head: 'Runtime: WebGPU (head: $1)',
            runtime_wasm_fallback: 'Runtime: WASM fallback',
            runtime_finalizer_loaded: 'Finalizer: ONNX loaded',
            runtime_finalizer_fallback: 'Finalizer: fallback',
            runtime_live_method: 'Live method: $1',
            runtime_pcm_buffer: 'PCM chunk: $1 / $2 sec, analyzed $3 sec',
            runtime_capture_suspended: 'Capture paused: $1',
            runtime_capture_skipped: 'Skipped capture: $1 sec',
            runtime_snapshot_failures: 'Snapshot failures: $1',
            runtime_frame_distribution: 'AED 10m: model $1%, vocal $2%, music-only $3%',
            runtime_thread_reason_forced_single: 'single-thread mode',
            runtime_thread_reason_no_isolation: 'cross-origin isolation disabled for tabCapture compatibility',
            runtime_thread_reason_no_sab: 'SharedArrayBuffer unavailable',
            runtime_thread_reason_low_cores: 'single CPU core reported',
            warning_prefix: 'Warning: $1',
            error_prefix: 'Error: $1',
            debug_prefix: 'Debug: $1',
        },
        zh: {
            extensionName: 'YouTube 自動跳轉',
            toggle_on: '已啟用',
            toggle_off: '已停用',
            export_all: '匯出播放清單',
            import_playlists: '匯入播放清單',
            video_id_prefix: '影片 ID:',
            timepoints_suffix: '個時間點',
            search_placeholder: '搜尋...',
            sort_lastModified_desc: '最後修改時間 ↓',
            sort_lastModified_asc: '最後修改時間 ↑',
            sort_uploadTime_desc: '上傳時間 ↓',
            sort_uploadTime_asc: '上傳時間 ↑',
            sort_playlists_label: '排序播放清單',
            search_scope_label: '搜尋範圍',
            search_scope_all: '全部',
            search_scope_title: '標題',
            expand_playlist: '展開段落',
            collapse_playlist: '收合段落',
            deleted_empty_playlists: '已刪除 $1 個空播放清單。',
            import_success: '播放清單已成功匯入。',
            import_failed: '匯入失敗，請確認檔案格式正確。',
            detect_eyebrow: '自動偵測',
            detect_title: '歌曲片段偵測',
            start_detect: '開始偵測',
            stop_detect: '停止偵測',
            min_segment_seconds: '最短片段秒數',
            live_method_label: 'Live 方法',
            live_method_aed_cache_60s: '60 秒 AED cache',
            live_method_pcm_rollover: '30 分鐘 PCM cache',
            playlist_studio: '播放清單工作台',
            feature_update_title: `${FEATURE_NOTICE_TO_VERSION} 主要更新`,
            feature_update_intro: `相較於上一個 $1 發行版，這次新增：`,
            feature_update_items: [
                'YouTube 影片與直播的本機歌曲片段偵測。',
                '播放清單工作台，支援跨影片播放佇列、資料庫編輯與設定頁。',
                '離線音訊分析，包含波型 / 頻譜編輯、批次工作與從檔名自動解析 videoId。',
                '改善串燒切分、長時間 BGM / 純音樂誤判排除，以及可調整最短片段秒數。',
            ],
            feature_install_title: '歡迎使用 YouTube Timeline Jumper',
            feature_install_intro: '此擴充功能可在本機儲存、編輯、偵測與播放 YouTube 時間軸片段。',
            feature_install_items: [
                '先在 popup 啟用擴充功能，再開啟 YouTube 影片即可在頁面中編輯時間軸。',
                '使用播放清單工作台管理總播放清單、跨影片播放佇列、資料庫與離線分析。',
                '開始偵測需從目標 YouTube 分頁點開此 popup，讓 Chrome 授權分頁音訊擷取。',
            ],
            feature_notice_dismiss: '知道了',
            status_label: '狀態',
            status_idle: '閒置',
            status_listening: '監聽中',
            status_detecting: '偵測中',
            status_postprocessing: '後處理中',
            status_stopped: '已停止',
            status_error: '錯誤',
            no_active_youtube_tab: '沒有可用的 YouTube 分頁。',
            no_active_youtube_tab_in_window: '目前視窗沒有可用的 YouTube 分頁。',
            permission_required: '需要授權。請點擊「開始偵測」授權分頁音訊擷取。',
            waiting_authorization: '仍在等待分頁音訊擷取授權。請保持 popup 開啟後重試。',
            switch_to_youtube_tab_for_capture: '請切換到要偵測的 YouTube 分頁，從該分頁點擊擴充功能圖示後再按「開始偵測」。',
            start_detection_failed: '開始偵測失敗。',
            stop_detection_failed: '停止偵測失敗。',
            set_min_failed: '更新最短片段秒數失敗。',
            set_min_failed_with_error: '設定最短片段秒數失敗：$1',
            notice_update_failed: '更新通知狀態失敗：$1',
            song_detection_started: '歌曲偵測已開始。',
            song_detection_stopped: '歌曲偵測已停止。',
            runtime_threads: 'WASM 執行緒：$1',
            runtime_threads_with_reason: 'WASM 執行緒：$1（$2）',
            runtime_webgpu: '執行後端：WebGPU',
            runtime_webgpu_with_head: '執行後端：WebGPU（head：$1）',
            runtime_wasm_fallback: '執行後端：WASM fallback',
            runtime_finalizer_loaded: '後處理模型：ONNX 已載入',
            runtime_finalizer_fallback: '後處理模型：fallback',
            runtime_live_method: 'Live 方法：$1',
            runtime_pcm_buffer: 'PCM 區塊：$1 / $2 秒，已分析 $3 秒',
            runtime_capture_suspended: '擷取暫停：$1',
            runtime_capture_skipped: '已略過擷取：$1 秒',
            runtime_snapshot_failures: 'snapshot 失敗：$1 次',
            runtime_frame_distribution: 'AED 10 分鐘：模型 $1%，人聲 $2%，純音樂 $3%',
            runtime_thread_reason_forced_single: '固定單執行緒模式',
            runtime_thread_reason_no_isolation: '為了相容 tabCapture 已停用 cross-origin isolation',
            runtime_thread_reason_no_sab: 'SharedArrayBuffer 不可用',
            runtime_thread_reason_low_cores: '瀏覽器回報只有單核心',
            warning_prefix: '警告：$1',
            error_prefix: '錯誤：$1',
            debug_prefix: '除錯：$1',
        },
    };
    let localePreviewOverride = 'auto';
    let userPreferences = { language: 'auto' };
    let featureNoticeContext = {
        reason: 'update',
        previousVersion: FEATURE_NOTICE_FROM_VERSION,
        currentVersion: FEATURE_NOTICE_TO_VERSION,
    };

    function normalizeLanguagePreference(value) {
        const key = String(value || 'auto').trim().toLowerCase();
        return key === 'zh' || key === 'en' ? key : 'auto';
    }

    function resolvePopupLanguage() {
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

    function t(key, substitutions = []) {
        const lang = resolvePopupLanguage();
        const value = UI_TEXT[lang][key] ?? UI_TEXT.en[key] ?? key;
        if (Array.isArray(value)) return value;
        const args = Array.isArray(substitutions) ? substitutions : [substitutions];
        return String(value).replace(/\$(\d+)/g, (_, index) => {
            const valueIndex = Number(index) - 1;
            return args[valueIndex] === undefined ? '' : String(args[valueIndex]);
        });
    }

    function statusLabel(status) {
        const normalized = String(status || 'Idle').toLowerCase();
        return t(`status_${normalized}`) || String(status || 'Idle');
    }

    function normalizeFeatureNoticeContext(raw = {}) {
        const reason = String(raw.reason || '').toLowerCase() === 'install' ? 'install' : 'update';
        return {
            reason,
            previousVersion: raw.previousVersion || FEATURE_NOTICE_FROM_VERSION,
            currentVersion: raw.currentVersion || FEATURE_NOTICE_TO_VERSION,
            updatedAt: raw.updatedAt || null,
        };
    }

    function getFeatureNoticeMode() {
        return featureNoticeContext.reason === 'install' ? 'install' : 'update';
    }

    function renderFeatureNoticeContent() {
        const title = document.getElementById('featureNoticeTitle');
        const intro = document.getElementById('featureNoticeIntro');
        const list = document.getElementById('featureNoticeList');
        const mode = getFeatureNoticeMode();
        const previousVersion = featureNoticeContext.previousVersion || FEATURE_NOTICE_FROM_VERSION;
        if (title) title.textContent = t(`feature_${mode}_title`);
        if (intro) {
            intro.textContent = mode === 'update'
                ? t('feature_update_intro', [previousVersion])
                : t('feature_install_intro');
        }
        if (list) {
            list.innerHTML = '';
            for (const item of t(`feature_${mode}_items`)) {
                const li = document.createElement('li');
                li.textContent = item;
                list.appendChild(li);
            }
        }
    }

    function applyPopupLanguage() {
        document.documentElement.lang = resolvePopupLanguage() === 'zh' ? 'zh-TW' : 'en';
        document.querySelectorAll('[data-i18n], [data-ui-key]').forEach(el => {
            const key = el.getAttribute('data-ui-key') || el.getAttribute('data-i18n');
            el.textContent = t(key);
        });

        document.querySelectorAll('[data-i18n-placeholder], [data-ui-placeholder]').forEach(el => {
            const key = el.getAttribute('data-ui-placeholder') || el.getAttribute('data-i18n-placeholder');
            el.placeholder = t(key);
        });

        renderFeatureNoticeContent();
        updateSortDropdownLabel();
        updateSearchScopeDropdownLabel();
        updatePlaylistExpandLabels();
        updateToggleStatus(extensionToggle?.checked);
        setDetectionStatus(lastDetectionStatus, lastDetectionOptions);
    }

    async function loadUserPreferences() {
        const stored = await chrome.storage.local.get(APP_PREFERENCES_KEY);
        const raw = stored[APP_PREFERENCES_KEY] || {};
        userPreferences = {
            ...raw,
            language: normalizeLanguagePreference(raw.language),
        };
        return userPreferences;
    }

    async function saveUserPreferences(patch = {}) {
        const next = {
            ...userPreferences,
            ...patch,
            language: normalizeLanguagePreference(patch.language ?? userPreferences.language),
            updatedAt: new Date().toISOString(),
        };
        await chrome.storage.local.set({ [APP_PREFERENCES_KEY]: next });
        userPreferences = next;
        applyPopupLanguage();
        return next;
    }

    const playlistContainer = document.getElementById('playlistContainer');
    const importBtn = document.getElementById('importBtn');
    const exportBtn = document.getElementById('exportBtn');
    const openWorkbenchBtn = document.getElementById('openWorkbenchBtn');
    const importInput = document.getElementById('importInput');
    // clearEmptyBtn removed: automatic cleanup on load
    const extensionToggle = document.getElementById('extensionToggle');
    const toggleStatus = document.getElementById('toggleStatus');
    const authorizeStartBtn = document.getElementById('authorizeStartBtn');
    const stopDetectBtn = document.getElementById('stopDetectBtn');
    const minSegmentSecInput = document.getElementById('minSegmentSecInput');
    const liveMethodButtons = Array.from(document.querySelectorAll('[data-live-method]'));
    const detectStatusText = document.getElementById('detectStatusText');
    const detectHint = document.getElementById('detectHint');
    const featureNotice = document.getElementById('featureNotice');
    const dismissFeatureNoticeBtn = document.getElementById('dismissFeatureNoticeBtn');
    const searchInput = document.getElementById('searchInput');
    const searchScopeSelect = document.getElementById('searchScopeSelect');
    const searchScopeDropdown = document.getElementById('searchScopeDropdown');
    const searchScopeButton = document.getElementById('searchScopeButton');
    const searchScopeLabel = document.getElementById('searchScopeLabel');
    const searchScopeMenu = document.getElementById('searchScopeMenu');
    const searchScopeOptions = Array.from(document.querySelectorAll('#searchScopeMenu .custom-select-option[data-value]'));
    const sortSelect = document.getElementById('sortSelect');
    const sortDropdown = document.getElementById('sortDropdown');
    const sortSelectButton = document.getElementById('sortSelectButton');
    const sortSelectLabel = document.getElementById('sortSelectLabel');
    const sortSelectMenu = document.getElementById('sortSelectMenu');
    const sortOptions = Array.from(document.querySelectorAll('#sortSelectMenu .custom-select-option[data-value]'));
    let lastDetectionStatus = 'Idle';
    let lastDetectionOptions = {};
    let detectionPanelRefreshSeq = 0;

    function invalidateDetectionPanelRefresh() {
        detectionPanelRefreshSeq += 1;
    }

    await loadUserPreferences();
    applyPopupLanguage();

    // 初始化開關狀態
    const { extensionWorkOrNot } = await chrome.storage.local.get('extensionWorkOrNot');
    extensionToggle.checked = extensionWorkOrNot;
    updateToggleStatus(extensionWorkOrNot);

    // 監聽開關變更
    extensionToggle.addEventListener('change', async () => {
        const newState = extensionToggle.checked;
        updateToggleStatus(newState);
        // 將狀態儲存到 storage，確保在沒有 YouTube 分頁時也能生效
        await chrome.storage.local.set({ extensionWorkOrNot: newState });

        // 取得目前的 YouTube 分頁
        const tabs = await chrome.tabs.query({
            url: ['*://*.youtube.com/*', '*://youtube.com/*', '*://youtu.be/*']
        });
        for (const tab of tabs) {
            // 向每個 YouTube 分頁發送更新狀態的消息
            try {
                await chrome.tabs.sendMessage(tab.id, {
                    action: newState ? 'initializePlaylist' : 'removePlaylist'
                });
            } catch (error) {
                console.debug(`Tab ${tab.id} not ready or not a video page`);
            }
        }
    });

    function updateToggleStatus(state) {
        const isOn = Boolean(state);
        const msg = state ? t('toggle_on') : t('toggle_off');
        toggleStatus.textContent = msg;
        toggleStatus.classList.toggle('is-on', isOn);
        toggleStatus.classList.toggle('is-off', !isOn);
    }

    function normalizeMinSegmentDurationSec(value, fallback = DEFAULT_MIN_SEGMENT_DURATION_SEC) {
        if (value === null || value === undefined || value === '') return fallback;
        const num = Number(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.max(15, Math.min(600, Math.round(num)));
    }

    function normalizeLiveAnalysisMethod(value, fallback = DEFAULT_LIVE_ANALYSIS_METHOD) {
        const key = String(value || '').trim().toLowerCase();
        if (key === LIVE_ANALYSIS_METHODS.AED_CACHE_60S) return LIVE_ANALYSIS_METHODS.AED_CACHE_60S;
        if (key === LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN) return LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN;
        return fallback;
    }

    function liveAnalysisMethodLabel(value) {
        const method = normalizeLiveAnalysisMethod(value);
        return method === LIVE_ANALYSIS_METHODS.PCM_ROLLOVER_30MIN
            ? t('live_method_pcm_rollover')
            : t('live_method_aed_cache_60s');
    }

    function getSelectedLiveAnalysisMethod() {
        const selected = liveMethodButtons.find((button) => button.classList.contains('active'));
        return normalizeLiveAnalysisMethod(selected?.dataset.liveMethod);
    }

    function setSelectedLiveAnalysisMethod(value) {
        const method = normalizeLiveAnalysisMethod(value);
        liveMethodButtons.forEach((button) => {
            const active = normalizeLiveAnalysisMethod(button.dataset.liveMethod) === method;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        return method;
    }

    async function loadSongDetectionConfig() {
        try {
            const result = await chrome.runtime.sendMessage({ action: 'getSongDetectionConfig' });
            if (result && result.success) return result;
        } catch (error) {
            // Service worker may be restarting; direct storage is enough for UI defaults.
        }
        const stored = await chrome.storage.local.get(DETECTION_CONFIG_KEY);
        return stored[DETECTION_CONFIG_KEY] || {};
    }

    async function saveSongDetectionConfig(patch = {}) {
        try {
            const result = await chrome.runtime.sendMessage({ action: 'setSongDetectionConfig', ...patch });
            if (result && result.success) return result;
        } catch (error) {
            // Fall back to direct storage when background is not ready.
        }
        const current = await loadSongDetectionConfig();
        const next = {
            ...current,
            mode: 'firered-aed',
            liveAnalysisMethod: normalizeLiveAnalysisMethod(
                patch.liveAnalysisMethod,
                current.liveAnalysisMethod || DEFAULT_LIVE_ANALYSIS_METHOD
            ),
            minSegmentDurationSec: normalizeMinSegmentDurationSec(
                patch.minSegmentDurationSec,
                current.minSegmentDurationSec
            ),
            updatedAt: new Date().toISOString(),
        };
        await chrome.storage.local.set({ [DETECTION_CONFIG_KEY]: next });
        return { success: true, ...next };
    }

    function formatRuntimeHint(runtimeInfo) {
        if (!runtimeInfo) return '';
        const hints = [];
        if (runtimeInfo.liveFrameBuilder?.mode) {
            hints.push(t('runtime_live_method', [liveAnalysisMethodLabel(runtimeInfo.liveFrameBuilder.mode)]));
        }
        if (runtimeInfo.liveFrameBuilder?.captureSuspended) {
            hints.push(t('runtime_capture_suspended', [runtimeInfo.liveFrameBuilder.captureSuspendedReason || 'playback']));
        }
        const captureStats = runtimeInfo.liveFrameBuilder?.captureSuspensionStats || null;
        if (captureStats && Number(captureStats.skippedAudioSec) > 0) {
            hints.push(t('runtime_capture_skipped', [Math.floor(Number(captureStats.skippedAudioSec))]));
        }
        if (captureStats && Number(captureStats.snapshotFailureCount) > 0) {
            hints.push(t('runtime_snapshot_failures', [Math.floor(Number(captureStats.snapshotFailureCount))]));
        }
        const bufferedPcm = runtimeInfo.liveFrameBuilder?.bufferedPcm || null;
        if (bufferedPcm && Number.isFinite(Number(bufferedPcm.bufferedSec))) {
            const bufferedSec = Math.max(0, Math.floor(Number(
                bufferedPcm.chunkProgressSec
                ?? bufferedPcm.bufferedSec
            )));
            const chunkSec = Math.max(1, Math.floor(Number(bufferedPcm.chunkSec || runtimeInfo.liveFrameBuilder?.chunkSec) || 1));
            const analyzedSec = Math.max(0, Math.floor(Number(
                bufferedPcm.totalAnalyzedSec
                ?? 0
            )));
            hints.push(t('runtime_pcm_buffer', [bufferedSec, chunkSec, analyzedSec]));
        }
        const frameDistribution = runtimeInfo.liveFrameBuilder?.frameDistribution || null;
        if (frameDistribution && Number(frameDistribution.frameCount) > 0) {
            const percent = (value) => Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
            hints.push(t('runtime_frame_distribution', [
                percent(frameDistribution.modelHighRatio),
                percent(frameDistribution.singingHighRatio),
                percent(frameDistribution.musicOnlyLowVocalRatio)
            ]));
        }
        const finalizerInfo = runtimeInfo.segmentFilterRuntimeInfo || null;
        if (finalizerInfo) {
            hints.push(finalizerInfo.segmentFilterLoaded
                ? t('runtime_finalizer_loaded')
                : t('runtime_finalizer_fallback'));
        }
        if (!Number.isFinite(Number(runtimeInfo.numThreads))) {
            return hints.join(' ');
        }
        const provider = String(runtimeInfo.executionProvider || 'wasm').toLowerCase();
        if (provider === 'webgpu') {
            const headProvider = runtimeInfo.temporalHeadExecutionProvider
                ? String(runtimeInfo.temporalHeadExecutionProvider).toUpperCase()
                : '';
            hints.unshift(headProvider && headProvider !== 'WEBGPU'
                ? t('runtime_webgpu_with_head', [headProvider])
                : t('runtime_webgpu'));
            return hints.join(' ');
        }
        const count = Math.max(1, Math.floor(Number(runtimeInfo.numThreads)));
        const reasons = [];
        if (runtimeInfo.webGpuRunFallbackError || runtimeInfo.providerAttempts?.length) {
            reasons.push(t('runtime_wasm_fallback'));
        }
        if (runtimeInfo.forcedSingleThread === true) {
            reasons.push(t('runtime_thread_reason_forced_single'));
        } else if (runtimeInfo.crossOriginIsolated === false) {
            reasons.push(t('runtime_thread_reason_no_isolation'));
        }
        if (runtimeInfo.sharedArrayBufferAvailable === false) {
            reasons.push(t('runtime_thread_reason_no_sab'));
        }
        if (Number(runtimeInfo.hardwareConcurrency) < 2) {
            reasons.push(t('runtime_thread_reason_low_cores'));
        }
        if (count === 1 && reasons.length) {
            hints.unshift(t('runtime_threads_with_reason', [count, reasons.join(', ')]));
            return hints.join(' ');
        }
        hints.unshift(t('runtime_threads', [count]));
        return hints.join(' ');
    }

    function formatDetectionDebugTrace(debugTrace) {
        const trace = Array.isArray(debugTrace) ? debugTrace.filter(Boolean) : [];
        if (!trace.length) return '';
        const last = trace[trace.length - 1];
        const target = last.targetTab || null;
        const activeLastFocused = Array.isArray(last.activeLastFocusedWindowTabs)
            ? last.activeLastFocusedWindowTabs[0]
            : null;
        const capturedCount = Array.isArray(last.capturedTabs) ? last.capturedTabs.length : 'n/a';
        const responseMessage = last.extra?.response?.message || '';
        const errorMessage = last.extra?.error?.message || responseMessage || '';
        const parts = [
            `phase=${last.phase || 'unknown'}`,
            `source=${last.source || 'background'}`,
        ];
        if (target) {
            parts.push(`targetTab=${target.id} active=${target.active} status=${target.status || 'n/a'}`);
        }
        if (activeLastFocused) {
            parts.push(`activeLastFocused=${activeLastFocused.id}`);
        }
        parts.push(`capturedTabs=${capturedCount}`);
        if (last.hasOffscreenDocument !== undefined) {
            parts.push(`offscreen=${last.hasOffscreenDocument}`);
        }
        if (errorMessage) {
            parts.push(`error=${errorMessage}`);
        }
        return parts.join(' | ');
    }

    function setDetectionStatus(status, options = {}) {
        lastDetectionStatus = status;
        lastDetectionOptions = options;
        const normalized = String(status || 'Idle');
        const warning = options.warning || '';
        const error = options.error || '';
        const liveAnalysisMethod = normalizeLiveAnalysisMethod(
            options.liveAnalysisMethod || options.runtimeInfo?.liveFrameBuilder?.mode || getSelectedLiveAnalysisMethod()
        );
        const runtimeHint = formatRuntimeHint(options.runtimeInfo);
        const debugHint = formatDetectionDebugTrace(options.debugTrace);

        detectStatusText.textContent = `${t('status_label')}: ${statusLabel(normalized)} (FireRed AED / ${liveAnalysisMethodLabel(liveAnalysisMethod)})`;
        const isRunning = normalized === 'Listening' || normalized === 'Detecting';
        const isPostProcessing = normalized === 'PostProcessing';
        authorizeStartBtn.disabled = isRunning || isPostProcessing;
        stopDetectBtn.disabled = !isRunning;
        liveMethodButtons.forEach((button) => {
            button.disabled = isRunning || isPostProcessing;
        });

        const hints = [];
        if (runtimeHint) hints.push(runtimeHint);
        if (warning) hints.push(t('warning_prefix', [warning]));
        if (error) hints.push(t('error_prefix', [error]));
        if (debugHint) hints.push(t('debug_prefix', [debugHint]));
        detectHint.textContent = hints.join(' ');
    }

    function isYouTubeUrl(url) {
        return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url || '');
    }

    function getVideoIdFromUrl(url) {
        try {
            const parsed = new URL(url || '');
            const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
            if (host === 'youtu.be') {
                return parsed.pathname.split('/').filter(Boolean)[0] || null;
            }
            if (host.endsWith('youtube.com')) {
                return parsed.searchParams.get('v')
                    || (parsed.pathname.startsWith('/shorts/') ? parsed.pathname.split('/').filter(Boolean)[1] : null)
                    || (parsed.pathname.startsWith('/live/') ? parsed.pathname.split('/').filter(Boolean)[1] : null);
            }
        } catch (error) {
            // Invalid URL; ignore.
        }
        return null;
    }

    async function getActiveYouTubeTab(preferredTabId = null) {
        if (Number.isFinite(preferredTabId)) {
            try {
                const preferredTab = await chrome.tabs.get(preferredTabId);
                if (preferredTab && isYouTubeUrl(preferredTab.url)) return preferredTab;
            } catch (error) {
                // preferred tab may be closed; ignore.
            }
        }

        const activeLastFocusedWindowTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const activeLastFocused = activeLastFocusedWindowTabs && activeLastFocusedWindowTabs[0];
        if (activeLastFocused && isYouTubeUrl(activeLastFocused.url)) {
            return activeLastFocused;
        }

        const allActiveTabs = await chrome.tabs.query({ active: true });
        const youtubeActive = allActiveTabs.find((tab) => isYouTubeUrl(tab.url));
        if (youtubeActive) return youtubeActive;

        const youtubeTabs = await chrome.tabs.query({
            url: ['*://*.youtube.com/*', '*://youtube.com/*', '*://youtu.be/*']
        });
        return youtubeTabs[0] || null;
    }

    async function getInvokedYouTubeTab() {
        const activeLastFocusedWindowTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const activeLastFocused = activeLastFocusedWindowTabs && activeLastFocusedWindowTabs[0];
        if (activeLastFocused && isYouTubeUrl(activeLastFocused.url)) {
            return activeLastFocused;
        }
        return null;
    }

    async function refreshDetectionPanel() {
        const refreshSeq = ++detectionPanelRefreshSeq;
        const isStale = () => refreshSeq !== detectionPanelRefreshSeq;
        try {
            const [configResult, pendingResult] = await Promise.all([
                chrome.runtime.sendMessage({ action: 'getSongDetectionConfig' }),
                chrome.runtime.sendMessage({ action: 'getSongDetectionAuthorizationContext' }),
            ]);
            if (isStale()) return;

            if (configResult && configResult.success) {
                const minSegment = normalizeMinSegmentDurationSec(configResult.minSegmentDurationSec);
                if (minSegmentSecInput.value !== String(minSegment)) {
                    minSegmentSecInput.value = String(minSegment);
                }
                setSelectedLiveAnalysisMethod(configResult.liveAnalysisMethod);
            }

            const invokedTab = await getInvokedYouTubeTab();
            const preferredTabId = invokedTab?.id
                ?? (pendingResult?.success && pendingResult.pending ? pendingResult.pending.tabId : null);
            const targetTab = invokedTab || await getActiveYouTubeTab(preferredTabId);
            if (isStale()) return;
            if (!targetTab) {
                setDetectionStatus('Idle', {
                    warning: '',
                    error: ''
                });
                detectHint.textContent = t('no_active_youtube_tab_in_window');
                return;
            }

            const statusResult = await chrome.runtime.sendMessage({
                action: 'getSongDetectionStatus',
                tabId: targetTab.id
            });
            if (isStale()) return;

            if (statusResult && statusResult.success) {
                setDetectionStatus(statusResult.status, {
                    warning: statusResult.warning || '',
                    error: statusResult.error || '',
                    liveAnalysisMethod: statusResult.liveAnalysisMethod || configResult?.liveAnalysisMethod,
                    runtimeInfo: statusResult.runtimeInfo || null,
                    debugTrace: statusResult.debugTrace || null
                });
            }

            const pending = pendingResult && pendingResult.success ? pendingResult.pending : null;
            if (pending && pending.tabId === targetTab.id) {
                detectHint.textContent = t('permission_required');
            } else if (!detectHint.textContent) {
                detectHint.textContent = '';
            }
        } catch (error) {
            if (isStale()) return;
            setDetectionStatus('Error', {
                error: error?.message || String(error)
            });
        }
    }

    minSegmentSecInput.addEventListener('change', async () => {
        const value = normalizeMinSegmentDurationSec(minSegmentSecInput.value);
        minSegmentSecInput.value = String(value);
        try {
            const result = await saveSongDetectionConfig({ minSegmentDurationSec: value });
            if (!result || !result.success) {
                showToast(t('set_min_failed'));
                return;
            }
            await refreshDetectionPanel();
        } catch (error) {
            showToast(t('set_min_failed_with_error', [error?.message || String(error)]));
        }
    });

    liveMethodButtons.forEach((button) => {
        button.addEventListener('click', async () => {
            const method = setSelectedLiveAnalysisMethod(button.dataset.liveMethod);
            try {
                const result = await saveSongDetectionConfig({ liveAnalysisMethod: method });
                if (!result || !result.success) {
                    showToast(t('set_min_failed'));
                    return;
                }
                await refreshDetectionPanel();
            } catch (error) {
                showToast(t('error_prefix', [error?.message || String(error)]));
            }
        });
    });

    authorizeStartBtn.addEventListener('click', async () => {
        try {
            const targetTab = await getInvokedYouTubeTab();
            if (!targetTab) {
                detectHint.textContent = t('switch_to_youtube_tab_for_capture');
                showToast(t('switch_to_youtube_tab_for_capture'), 5200);
                return;
            }

            const minSegmentDurationSec = normalizeMinSegmentDurationSec(minSegmentSecInput.value);
            const liveAnalysisMethod = getSelectedLiveAnalysisMethod();
            minSegmentSecInput.value = String(minSegmentDurationSec);
            await saveSongDetectionConfig({ minSegmentDurationSec, liveAnalysisMethod });

            invalidateDetectionPanelRefresh();
            setDetectionStatus('Listening', { liveAnalysisMethod });

            const result = await chrome.runtime.sendMessage({
                action: 'startSongDetectionForActiveTab',
                tabId: targetTab.id,
                videoId: getVideoIdFromUrl(targetTab.url),
                detectorMode: 'firered-aed',
                liveAnalysisMethod
            });

            if (!result || !result.success) {
                if (result && result.requiresPopupAuthorization) {
                    detectHint.textContent = t('switch_to_youtube_tab_for_capture');
                }
                invalidateDetectionPanelRefresh();
                setDetectionStatus('Error', {
                    error: (result && result.message) ? result.message : t('start_detection_failed'),
                    debugTrace: result && result.debugTrace ? result.debugTrace : null
                });
                if (result && result.debugTrace) {
                    console.warn('[song-detection] start debug trace', result.debugTrace);
                }
                showToast((result && result.message) ? result.message : t('start_detection_failed'));
                return;
            }

            invalidateDetectionPanelRefresh();
            setDetectionStatus(result.status || 'Listening', {
                liveAnalysisMethod: result.liveAnalysisMethod || liveAnalysisMethod,
                warning: result.warning || '',
                runtimeInfo: result.runtimeInfo || null
            });
            if (result.warning) {
                showToast(result.warning, 4500);
            } else {
                showToast(t('song_detection_started'));
            }
        } catch (error) {
            invalidateDetectionPanelRefresh();
            setDetectionStatus('Error', {
                error: error?.message || String(error),
                debugTrace: error?.debugTrace || null
            });
            showToast(t('error_prefix', [error?.message || String(error)]));
        }
    });

    stopDetectBtn.addEventListener('click', async () => {
        try {
            const context = await chrome.runtime.sendMessage({ action: 'getSongDetectionAuthorizationContext' });
            const preferredTabId = context?.success && context.pending ? context.pending.tabId : null;
            const targetTab = await getInvokedYouTubeTab() || await getActiveYouTubeTab(preferredTabId);
            if (!targetTab) {
                showToast(t('no_active_youtube_tab'));
                return;
            }
            invalidateDetectionPanelRefresh();
            setDetectionStatus('PostProcessing');

            const result = await chrome.runtime.sendMessage({
                action: 'stopSongDetectionForActiveTab',
                tabId: targetTab.id
            });
            if (!result || !result.success) {
                invalidateDetectionPanelRefresh();
                setDetectionStatus('Error', {
                    error: (result && result.message) ? result.message : t('stop_detection_failed')
                });
                showToast((result && result.message) ? result.message : t('stop_detection_failed'));
                return;
            }
            invalidateDetectionPanelRefresh();
            setDetectionStatus('Stopped');
            showToast(t('song_detection_stopped'));
        } catch (error) {
            invalidateDetectionPanelRefresh();
            setDetectionStatus('Error', {
                error: error?.message || String(error)
            });
            showToast(t('error_prefix', [error?.message || String(error)]));
        }
    });

    // Toast 顯示函式
    const toastContainer = document.getElementById('toastContainer');
    function showToast(message, timeout = 3000) {
        if (!toastContainer) return;
        const el = document.createElement('div');
        el.className = 'toast';
        el.textContent = message;
        toastContainer.appendChild(el);
        // force reflow
        void el.offsetWidth;
        el.classList.add('show');
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 200);
        }, timeout);
    }

    async function getFeatureNoticeState() {
        const stored = await chrome.storage.local.get(FEATURE_NOTICE_STORAGE_KEY);
        return stored[FEATURE_NOTICE_STORAGE_KEY] || {};
    }

    async function getFeatureNoticeContext() {
        const stored = await chrome.storage.local.get(FEATURE_NOTICE_CONTEXT_KEY);
        return normalizeFeatureNoticeContext(stored[FEATURE_NOTICE_CONTEXT_KEY] || {});
    }

    async function setFeatureNoticeContext(patch = {}) {
        featureNoticeContext = normalizeFeatureNoticeContext({
            ...featureNoticeContext,
            ...patch,
            updatedAt: new Date().toISOString(),
        });
        await chrome.storage.local.set({ [FEATURE_NOTICE_CONTEXT_KEY]: featureNoticeContext });
        renderFeatureNoticeContent();
        return featureNoticeContext;
    }

    async function markFeatureNoticeSeen() {
        await chrome.storage.local.set({
            [FEATURE_NOTICE_STORAGE_KEY]: {
                lastSeenId: FEATURE_NOTICE_ID,
                lastSeenReason: getFeatureNoticeMode(),
                lastSeenVersion: FEATURE_NOTICE_TO_VERSION,
                lastSeenAt: new Date().toISOString(),
            },
        });
    }

    function showFeatureNotice() {
        featureNotice?.classList.add('visible');
    }

    async function dismissFeatureNotice() {
        featureNotice?.classList.remove('visible');
        await markFeatureNoticeSeen();
    }

    async function maybeShowFeatureNotice({ force = false } = {}) {
        if (!featureNotice) return false;
        featureNoticeContext = await getFeatureNoticeContext();
        renderFeatureNoticeContent();
        if (force) {
            showFeatureNotice();
            return true;
        }
        const state = await getFeatureNoticeState();
        if (state.lastSeenId !== FEATURE_NOTICE_ID) {
            showFeatureNotice();
            return true;
        }
        featureNotice.classList.remove('visible');
        return false;
    }

    if (dismissFeatureNoticeBtn) {
        dismissFeatureNoticeBtn.addEventListener('click', () => {
            dismissFeatureNotice().catch((error) => showToast(t('notice_update_failed', [error?.message || String(error)])));
        });
    }

    window.YTJDev = {
        featureNoticeId: FEATURE_NOTICE_ID,
        showFeatureNotice: () => maybeShowFeatureNotice({ force: true }),
        showInstallNotice: async () => {
            await setFeatureNoticeContext({ reason: 'install', previousVersion: null, currentVersion: FEATURE_NOTICE_TO_VERSION });
            return maybeShowFeatureNotice({ force: true });
        },
        showUpdateNotice: async (previousVersion = FEATURE_NOTICE_FROM_VERSION) => {
            await setFeatureNoticeContext({ reason: 'update', previousVersion, currentVersion: FEATURE_NOTICE_TO_VERSION });
            return maybeShowFeatureNotice({ force: true });
        },
        resetFeatureNotice: async () => {
            await chrome.storage.local.remove(FEATURE_NOTICE_STORAGE_KEY);
            return maybeShowFeatureNotice({ force: true });
        },
        getFeatureNoticeState,
        getFeatureNoticeContext,
        setFeatureNoticeContext,
        checkFeatureNotice: () => maybeShowFeatureNotice(),
        getLanguageState: () => ({
            activeLanguage: resolvePopupLanguage(),
            userLanguage: normalizeLanguagePreference(userPreferences.language),
            previewOverride: localePreviewOverride,
        }),
        setLanguagePreview: (language) => {
            localePreviewOverride = normalizeLanguagePreference(language);
            applyPopupLanguage();
            return window.YTJDev.getLanguageState();
        },
        clearLanguagePreview: () => {
            localePreviewOverride = 'auto';
            applyPopupLanguage();
            return window.YTJDev.getLanguageState();
        },
        setLanguage: async (language) => {
            localePreviewOverride = 'auto';
            await saveUserPreferences({ language });
            return window.YTJDev.getLanguageState();
        },
        translate: (key, substitutions) => t(key, substitutions),
    };

    chrome.runtime.onMessage.addListener((request) => {
        if (!request) return false;
        if (request.action !== 'songDetectionStatusChanged') return false;
        refreshDetectionPanel();
        return false;
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes[APP_PREFERENCES_KEY]) return;
        userPreferences = {
            ...(changes[APP_PREFERENCES_KEY].newValue || {}),
            language: normalizeLanguagePreference(changes[APP_PREFERENCES_KEY].newValue?.language),
        };
        applyPopupLanguage();
    });

    function getSortOptionLabel(value) {
        const option = sortOptions.find((item) => item.dataset.value === value);
        const key = option?.getAttribute('data-ui-key') || option?.getAttribute('data-i18n');
        return key ? t(key) : (option?.textContent || '');
    }

    function updateSortDropdownLabel() {
        if (!sortSelect || !sortSelectLabel) return;
        const value = sortSelect.value || 'lastModified_desc';
        sortSelectLabel.textContent = getSortOptionLabel(value);
        if (sortSelectMenu) sortSelectMenu.setAttribute('aria-label', t('sort_playlists_label'));
        sortOptions.forEach((option) => {
            const selected = option.dataset.value === value;
            option.setAttribute('aria-selected', String(selected));
        });
    }

    function setSortDropdownOpen(open) {
        if (!sortDropdown || !sortSelectButton) return;
        sortDropdown.classList.toggle('open', Boolean(open));
        sortSelectButton.setAttribute('aria-expanded', String(Boolean(open)));
    }

    function setSortValue(value, { notify = true } = {}) {
        if (!sortSelect || !value || sortSelect.value === value) {
            updateSortDropdownLabel();
            return;
        }
        sortSelect.value = value;
        updateSortDropdownLabel();
        if (notify) {
            sortSelect.dispatchEvent(new Event('change'));
        }
    }

    sortSelectButton?.addEventListener('click', (event) => {
        event.stopPropagation();
        setSearchScopeDropdownOpen(false);
        setSortDropdownOpen(!sortDropdown.classList.contains('open'));
    });

    sortOptions.forEach((option) => {
        option.addEventListener('click', (event) => {
            event.stopPropagation();
            setSortValue(option.dataset.value);
            setSortDropdownOpen(false);
        });
    });

    document.addEventListener('click', (event) => {
        if (!sortDropdown || sortDropdown.contains(event.target)) return;
        setSortDropdownOpen(false);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setSortDropdownOpen(false);
    });

    function getSearchScopeLabel(value) {
        const option = searchScopeOptions.find((item) => item.dataset.value === value);
        const key = option?.getAttribute('data-ui-key') || option?.getAttribute('data-i18n');
        return key ? t(key) : (option?.textContent || '');
    }

    function updateSearchScopeDropdownLabel() {
        if (!searchScopeSelect || !searchScopeLabel) return;
        const value = searchScopeSelect.value || 'all';
        searchScopeLabel.textContent = getSearchScopeLabel(value);
        if (searchScopeMenu) searchScopeMenu.setAttribute('aria-label', t('search_scope_label'));
        searchScopeOptions.forEach((option) => {
            const selected = option.dataset.value === value;
            option.setAttribute('aria-selected', String(selected));
        });
    }

    function setSearchScopeDropdownOpen(open) {
        if (!searchScopeDropdown || !searchScopeButton) return;
        searchScopeDropdown.classList.toggle('open', Boolean(open));
        searchScopeButton.setAttribute('aria-expanded', String(Boolean(open)));
    }

    function setSearchScopeValue(value, { notify = true } = {}) {
        if (!searchScopeSelect || !value || searchScopeSelect.value === value) {
            updateSearchScopeDropdownLabel();
            return;
        }
        searchScopeSelect.value = value;
        updateSearchScopeDropdownLabel();
        if (notify) {
            searchScopeSelect.dispatchEvent(new Event('change'));
        }
    }

    searchScopeButton?.addEventListener('click', (event) => {
        event.stopPropagation();
        setSortDropdownOpen(false);
        setSearchScopeDropdownOpen(!searchScopeDropdown.classList.contains('open'));
    });

    searchScopeOptions.forEach((option) => {
        option.addEventListener('click', (event) => {
            event.stopPropagation();
            setSearchScopeValue(option.dataset.value);
            setSearchScopeDropdownOpen(false);
        });
    });

    document.addEventListener('click', (event) => {
        if (!searchScopeDropdown || searchScopeDropdown.contains(event.target)) return;
        setSearchScopeDropdownOpen(false);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setSearchScopeDropdownOpen(false);
    });

    function updatePlaylistExpandLabels() {
        document.querySelectorAll('.playlist-expand').forEach((button) => {
            const text = button.querySelector('.playlist-expand-text');
            if (!text) return;
            const expanded = button.getAttribute('aria-expanded') === 'true';
            text.textContent = expanded ? t('collapse_playlist') : t('expand_playlist');
        });
    }

    function displayPlaylists(list) {
    playlistContainer.innerHTML = '';
    // helper to format a time token (TimeSlot object, number seconds, or string)
    function formatSecondsWithFraction(seconds) {
        const total = Math.max(0, Number(seconds) || 0);
        const rounded = Math.round(total * 1000) / 1000;
        const h = Math.floor(rounded / 3600);
        const m = Math.floor((rounded - (h * 3600)) / 60);
        const sec = rounded - (h * 3600) - (m * 60);
        const wholeSec = Math.floor(sec);
        const fraction = sec - wholeSec;
        const secondText = fraction > 1e-6
            ? `${String(wholeSec).padStart(2, '0')}${fraction.toFixed(3).slice(1).replace(/0+$/, '')}`
            : String(wholeSec).padStart(2, '0');
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${secondText}`;
    }

    function formatTimeToken(tok) {
        try {
            if (!tok && tok !== 0) return '';
            // If it's an object with toformatString (our TimeSlot), use it
            if (typeof tok === 'object') {
                if (typeof tok.toformatString === 'function') return tok.toformatString();
                // if it's a plain object with hours/minutes/seconds
                if ('hours' in tok || 'minutes' in tok || 'seconds' in tok) {
                    const h = Number(tok.hours) || 0;
                    const m = Number(tok.minutes) || 0;
                    const s = Number(tok.seconds) || 0;
                    return formatSecondsWithFraction((h * 3600) + (m * 60) + s);
                }
                return String(tok);
            }
            // number of seconds
            if (typeof tok === 'number') {
                return formatSecondsWithFraction(tok);
            }
            // string: maybe it's already formatted
            return String(tok);
        } catch (err) {
            return String(tok);
        }
    }

    function timeTokenToSeconds(tok) {
        if (tok === null || tok === undefined || tok === '') return null;
        if (typeof tok === 'number') return Number.isFinite(tok) ? tok : null;
        if (typeof tok === 'object') {
            if ('hours' in tok || 'minutes' in tok || 'seconds' in tok) {
                const h = Number(tok.hours) || 0;
                const m = Number(tok.minutes) || 0;
                const s = Number(tok.seconds) || 0;
                return h * 3600 + m * 60 + s;
            }
            if (typeof tok.toformatString === 'function') return timeTokenToSeconds(tok.toformatString());
            return null;
        }

        const raw = String(tok).trim();
        if (!raw) return null;
        if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);

        const parts = raw.split(':').map((part) => Number(part));
        if (parts.some((part) => !Number.isFinite(part))) return null;
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return null;
    }

    function formatAlignedTimeToken(tok) {
        const seconds = timeTokenToSeconds(tok);
        if (seconds === null) return formatTimeToken(tok) || '00:00:00';
        return formatSecondsWithFraction(seconds);
    }

    list.forEach(({ videoId, playlist, title }) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'playlist-item';
        itemDiv.setAttribute('data-vid', videoId);
        // store raw playlist for later use
        itemDiv._playlist = playlist || [];

        // top area: title + meta (open)
        const top = document.createElement('div');
        top.className = 'playlist-top';

        const left = document.createElement('div');
        left.className = 'playlist-main';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'playlist-title';
        titleDiv.textContent = title || `${t('video_id_prefix')} ${videoId}`;
        // allow clicking title to open video like YouTube page
        titleDiv.style.cursor = 'pointer';
        titleDiv.addEventListener('click', (e) => {
            e.stopPropagation();
            chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}` });
        });

        const infoDiv = document.createElement('div');
        infoDiv.className = 'playlist-info';
        infoDiv.textContent = `${Array.isArray(playlist) ? playlist.length : 0} ${t('timepoints_suffix')}`;

        left.appendChild(titleDiv);
        left.appendChild(infoDiv);

        top.appendChild(left);
        itemDiv.appendChild(top);

        // expandable area placed under the title (full width)
        const details = document.createElement('div');
        details.className = 'playlist-details';
        details.style.display = 'none';

        const ul = document.createElement('ul');
        ul.style.listStyle = 'none';
        ul.style.padding = '0';
        (playlist || []).forEach((pt) => {
            const li = document.createElement('li');
            li.className = 'timeline-entry';

            const startText = formatAlignedTimeToken(pt.start);
            const endText = formatAlignedTimeToken(pt.end ?? pt.start);
            const timeSpan = document.createElement('span');
            timeSpan.className = 'timeline-time-range';
            timeSpan.textContent = `${startText} ~ ${endText}`;

            const titleSpan = document.createElement('span');
            titleSpan.className = 'timeline-title';
            titleSpan.textContent = pt.title || '';

            li.appendChild(timeSpan);
            li.appendChild(titleSpan);
            ul.appendChild(li);
        });
        details.appendChild(ul);

        // create a small bar to toggle expand/collapse
        const expandBar = document.createElement('button');
        expandBar.className = 'playlist-expand';
        expandBar.type = 'button';
        expandBar.setAttribute('aria-expanded', 'false');
        const expandText = document.createElement('span');
        expandText.className = 'playlist-expand-text';
        expandText.textContent = t('expand_playlist');
        const expandIcon = document.createElement('span');
        expandIcon.className = 'playlist-expand-icon';
        expandIcon.setAttribute('aria-hidden', 'true');
        expandIcon.textContent = '▾';
        expandBar.appendChild(expandText);
        expandBar.appendChild(expandIcon);
        expandBar.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = details.style.display === 'none';
            details.style.display = open ? 'block' : 'none';
            expandBar.setAttribute('aria-expanded', String(open));
            expandText.textContent = open ? t('collapse_playlist') : t('expand_playlist');
        });

        itemDiv.appendChild(expandBar);
        itemDiv.appendChild(details);

        playlistContainer.appendChild(itemDiv);
    });
    }

    // Search & Sort handlers
    searchScopeSelect.value = 'all';
    sortSelect.value = 'lastModified_desc';
    updateSearchScopeDropdownLabel();
    updateSortDropdownLabel();

    async function refreshView() {
        const all = await chrome.storage.local.get(null);
        let playlists = Object.keys(all)
            .filter(k => k.startsWith('playlist_') && !k.startsWith('playlist_meta_'))
            .map(k => ({ videoId: k.replace('playlist_', ''), playlist: Array.isArray(all[k]) ? all[k] : [] }));

        // compute playlist-level metadata by reading separate meta store and preserve already-rendered titles
        const metaKeys = playlists.map(p => `playlist_meta_${p.videoId}`);
        const metaResults = await chrome.storage.local.get(metaKeys);
        playlists = playlists.map(p => {
            const existingTitleEl = document.querySelector(`[data-vid="${p.videoId}"] .playlist-title`);
            const existingTitle = existingTitleEl ? existingTitleEl.textContent : null;
            const meta = metaResults[`playlist_meta_${p.videoId}`] || {};
            const lastModified = meta.lastModified || '';
            const uploadTime = meta.uploadTime || '';
            return { ...p, title: existingTitle || null, lastModified, uploadTime };
        });

        const mode = sortSelect.value;

        // For any missing titles, fetch in parallel (non-blocking for each)
        await Promise.all(playlists.map(async (p) => {
            if (!p.title) {
                try {
                    const fetchedTitle = await getVideoTitle(p.videoId);
                    p.title = fetchedTitle || `${t('video_id_prefix')} ${p.videoId}`;
                } catch (e) {
                    p.title = `${t('video_id_prefix')} ${p.videoId}`;
                }
            }
        }));

        // apply search
        const q = (searchInput.value || '').trim().toLowerCase();
        const searchScope = searchScopeSelect.value || 'all';
        let filtered = playlists;
        if (q) {
            filtered = playlists.filter((p) => {
                const titleMatch = p.title && p.title.toLowerCase().includes(q);
                if (searchScope === 'title') return Boolean(titleMatch);
                const videoIdMatch = p.videoId && p.videoId.toLowerCase().includes(q);
                const songMatch = Array.isArray(p.playlist) && p.playlist.some((pt) => {
                    return String(pt?.title || '').toLowerCase().includes(q);
                });
                return Boolean(titleMatch || videoIdMatch || songMatch);
            });
        }

        // apply sort
        if (mode === 'lastModified_desc') filtered.sort((a,b) => (b.lastModified||'').localeCompare(a.lastModified||''));
        else if (mode === 'lastModified_asc') filtered.sort((a,b) => (a.lastModified||'').localeCompare(b.lastModified||''));
        else if (mode === 'uploadTime_desc') filtered.sort((a,b) => (b.uploadTime||'').localeCompare(a.uploadTime||''));
        else if (mode === 'uploadTime_asc') filtered.sort((a,b) => (a.uploadTime||'').localeCompare(b.uploadTime||''));

        displayPlaylists(filtered.map(p => ({ videoId: p.videoId, playlist: p.playlist, title: p.title })));
    }
    searchInput.addEventListener('input', () => refreshView());
    searchScopeSelect.addEventListener('change', () => refreshView());
    sortSelect.addEventListener('change', () => refreshView());


    // 從 YouTube API 獲取影片標題
    async function getVideoTitle(videoId) {
        try {
            const response = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
            const data = await response.json();
            return data.title;
        } catch (error) {
            console.error('Error fetching video title:', error);
            return null;
        }
    }

    // 匯出所有播放清單
    exportBtn.addEventListener('click', async () => {
        const result = await chrome.storage.local.get(null);
        const exportData = {};
        
        for (let key in result) {
            if (key.startsWith('playlist_') || key.startsWith('playlist_meta_')) {
                exportData[key] = result[key];
            }
        }
        
        const blob = new Blob([JSON.stringify(exportData, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'youtube-timeline-playlists.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });


    // 觸發檔案選擇
    importBtn.addEventListener('click', () => {
        importInput.click();
    });

    openWorkbenchBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') });
    });

    // 匯入播放清單
    importInput.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const importData = JSON.parse(e.target.result);

                // 先取得目前的資料以便合併
                const currentData = await chrome.storage.local.get(null);
                for (const key in importData) {
                    if (key.startsWith('playlist_') && !key.startsWith('playlist_meta_')) {
                        const existing = Array.isArray(currentData[key]) ? currentData[key] : [];
                        const incoming = Array.isArray(importData[key]) ? importData[key] : [];
                        importData[key] = existing.concat(incoming);
                    } else if (key.startsWith('playlist_meta_')) {
                        const existingMeta = currentData[key] || {};
                        const incomingMeta = importData[key] || {};
                        const lastModified = [existingMeta.lastModified, incomingMeta.lastModified]
                            .filter(Boolean)
                            .sort()
                            .slice(-1)[0] || incomingMeta.lastModified || existingMeta.lastModified;
                        const uploadTime = [existingMeta.uploadTime, incomingMeta.uploadTime]
                            .filter(Boolean)
                            .sort()[0] || incomingMeta.uploadTime || existingMeta.uploadTime;
                        importData[key] = { ...existingMeta, ...incomingMeta, lastModified, uploadTime };
                    }
                }

                await chrome.storage.local.set(importData);
                refreshView(); // 重新載入顯示
                showToast(t('import_success'));
            } catch (error) {
                console.error('Import error:', error);
                showToast(t('import_failed'));
            }
        };
        reader.readAsText(file);
    });

    // 初始載入所有播放清單
    // First, automatically remove empty playlist_* entries then load playlists
    (async () => {
        try {
            const all = await chrome.storage.local.get(null);
            const keysToRemove = [];
            for (const k of Object.keys(all)) {
                if (k.startsWith('playlist_') && !k.startsWith('playlist_meta_')) {
                    const v = all[k];
                    if (!Array.isArray(v) || v.length === 0) {
                        keysToRemove.push(k);
                        const vid = k.replace('playlist_', '');
                        const metaKey = `playlist_meta_${vid}`;
                        if (metaKey in all) keysToRemove.push(metaKey);
                    }
                }
            }
            if (keysToRemove.length) {
                await chrome.storage.local.remove(keysToRemove);
                showToast(t('deleted_empty_playlists', [String(keysToRemove.length)]));
            }
        } catch (err) {
            console.error('Auto-cleanup failed:', err);
        }
        try {
            const config = await loadSongDetectionConfig();
            minSegmentSecInput.value = String(normalizeMinSegmentDurationSec(config.minSegmentDurationSec));
            setSelectedLiveAnalysisMethod(config.liveAnalysisMethod);
        } catch (error) {
            minSegmentSecInput.value = String(DEFAULT_MIN_SEGMENT_DURATION_SEC);
            setSelectedLiveAnalysisMethod(DEFAULT_LIVE_ANALYSIS_METHOD);
        }
        await maybeShowFeatureNotice();
        refreshView();
        refreshDetectionPanel();
        setInterval(() => {
            refreshDetectionPanel();
        }, 2000);
    })();
});
