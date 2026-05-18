document.addEventListener('DOMContentLoaded', async () => {
    const DETECTION_CONFIG_KEY = 'songDetectionConfig';
    const APP_PREFERENCES_KEY = 'ytjUserPreferences';
    const DEFAULT_MIN_SEGMENT_DURATION_SEC = 90;
    const FEATURE_NOTICE_ID = 'release-3.0.0-major-features';
    const FEATURE_NOTICE_STORAGE_KEY = 'popupFeatureNoticeState';
    const FEATURE_NOTICE_FROM_VERSION = '2.0';
    const FEATURE_NOTICE_TO_VERSION = chrome.runtime?.getManifest?.().version || '3.0.0';
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
            playlist_studio: 'Playlist Studio',
            feature_notice_title: `What's new in ${FEATURE_NOTICE_TO_VERSION}`,
            feature_notice_intro: `Compared with the previous ${FEATURE_NOTICE_FROM_VERSION} release, this version adds:`,
            feature_notice_items: [
                'Local song segment detection for YouTube videos and live streams.',
                'Offline detection tools for downloaded audio, with results saved back into the timeline database.',
                'Playlist Studio for cross-video playlists, playback queues, and database editing.',
            ],
            feature_notice_dismiss: 'Got it',
            status_label: 'Status',
            status_idle: 'Idle',
            status_listening: 'Listening',
            status_detecting: 'Detecting',
            status_stopped: 'Stopped',
            status_error: 'Error',
            no_active_youtube_tab: 'No active YouTube tab.',
            no_active_youtube_tab_in_window: 'No active YouTube tab in this window.',
            permission_required: 'Permission required. Click "Start Detect" to grant tabCapture.',
            waiting_authorization: 'Still waiting for tabCapture authorization. Keep the popup open and retry.',
            start_detection_failed: 'Start detection failed.',
            stop_detection_failed: 'Stop detection failed.',
            set_min_failed: 'Failed to update minimum segment duration.',
            set_min_failed_with_error: 'Set minimum duration failed: $1',
            notice_update_failed: 'Notice update failed: $1',
            song_detection_started: 'Song detection started.',
            song_detection_stopped: 'Song detection stopped.',
            runtime_threads: 'WASM threads: $1',
            warning_prefix: 'Warning: $1',
            error_prefix: 'Error: $1',
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
            playlist_studio: '播放清單工作台',
            feature_notice_title: `${FEATURE_NOTICE_TO_VERSION} 主要更新`,
            feature_notice_intro: `相較於上一個 ${FEATURE_NOTICE_FROM_VERSION} 發行版，這次新增：`,
            feature_notice_items: [
                'YouTube 影片與直播的本機歌曲片段偵測。',
                '離線音訊偵測工具，可將已下載音訊的結果寫回時間軸資料庫。',
                '播放清單工作台，支援跨影片播放清單、播放佇列與資料庫編輯。',
            ],
            feature_notice_dismiss: '知道了',
            status_label: '狀態',
            status_idle: '閒置',
            status_listening: '監聽中',
            status_detecting: '偵測中',
            status_stopped: '已停止',
            status_error: '錯誤',
            no_active_youtube_tab: '沒有可用的 YouTube 分頁。',
            no_active_youtube_tab_in_window: '目前視窗沒有可用的 YouTube 分頁。',
            permission_required: '需要授權。請點擊「開始偵測」授權分頁音訊擷取。',
            waiting_authorization: '仍在等待分頁音訊擷取授權。請保持 popup 開啟後重試。',
            start_detection_failed: '開始偵測失敗。',
            stop_detection_failed: '停止偵測失敗。',
            set_min_failed: '更新最短片段秒數失敗。',
            set_min_failed_with_error: '設定最短片段秒數失敗：$1',
            notice_update_failed: '更新通知狀態失敗：$1',
            song_detection_started: '歌曲偵測已開始。',
            song_detection_stopped: '歌曲偵測已停止。',
            runtime_threads: 'WASM 執行緒：$1',
            warning_prefix: '警告：$1',
            error_prefix: '錯誤：$1',
        },
    };
    let localePreviewOverride = 'auto';
    let userPreferences = { language: 'auto' };

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

    function renderFeatureNoticeContent() {
        const title = document.getElementById('featureNoticeTitle');
        const intro = document.getElementById('featureNoticeIntro');
        const list = document.getElementById('featureNoticeList');
        if (title) title.textContent = t('feature_notice_title');
        if (intro) intro.textContent = t('feature_notice_intro');
        if (list) {
            list.innerHTML = '';
            for (const item of t('feature_notice_items')) {
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
        if (!runtimeInfo || !Number.isFinite(Number(runtimeInfo.numThreads))) return '';
        const count = Math.max(1, Math.floor(Number(runtimeInfo.numThreads)));
        return t('runtime_threads', [count]);
    }

    function setDetectionStatus(status, options = {}) {
        lastDetectionStatus = status;
        lastDetectionOptions = options;
        const normalized = String(status || 'Idle');
        const warning = options.warning || '';
        const error = options.error || '';
        const runtimeHint = formatRuntimeHint(options.runtimeInfo);

        detectStatusText.textContent = `${t('status_label')}: ${statusLabel(normalized)} (FireRed AED)`;
        const isRunning = normalized === 'Listening' || normalized === 'Detecting';
        authorizeStartBtn.disabled = isRunning;
        stopDetectBtn.disabled = !isRunning;

        const hints = [];
        if (runtimeHint) hints.push(runtimeHint);
        if (warning) hints.push(t('warning_prefix', [warning]));
        if (error) hints.push(t('error_prefix', [error]));
        detectHint.textContent = hints.join(' ');
    }

    function isYouTubeUrl(url) {
        return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url || '');
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

    async function refreshDetectionPanel() {
        try {
            const [configResult, pendingResult] = await Promise.all([
                chrome.runtime.sendMessage({ action: 'getSongDetectionConfig' }),
                chrome.runtime.sendMessage({ action: 'getSongDetectionAuthorizationContext' }),
            ]);

            if (configResult && configResult.success) {
                const minSegment = normalizeMinSegmentDurationSec(configResult.minSegmentDurationSec);
                if (minSegmentSecInput.value !== String(minSegment)) {
                    minSegmentSecInput.value = String(minSegment);
                }
            }

            const preferredTabId = pendingResult?.success && pendingResult.pending ? pendingResult.pending.tabId : null;
            const targetTab = await getActiveYouTubeTab(preferredTabId);
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

            if (statusResult && statusResult.success) {
                setDetectionStatus(statusResult.status, {
                    warning: statusResult.warning || '',
                    error: statusResult.error || '',
                    runtimeInfo: statusResult.runtimeInfo || null
                });
            }

            const pending = pendingResult && pendingResult.success ? pendingResult.pending : null;
            if (pending && pending.tabId === targetTab.id) {
                detectHint.textContent = t('permission_required');
            } else if (!detectHint.textContent) {
                detectHint.textContent = '';
            }
        } catch (error) {
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

    authorizeStartBtn.addEventListener('click', async () => {
        try {
            const context = await chrome.runtime.sendMessage({ action: 'getSongDetectionAuthorizationContext' });
            const preferredTabId = context?.success && context.pending ? context.pending.tabId : null;
            const targetTab = await getActiveYouTubeTab(preferredTabId);
            if (!targetTab) {
                showToast(t('no_active_youtube_tab'));
                return;
            }

            const minSegmentDurationSec = normalizeMinSegmentDurationSec(minSegmentSecInput.value);
            minSegmentSecInput.value = String(minSegmentDurationSec);
            await saveSongDetectionConfig({ minSegmentDurationSec });

            setDetectionStatus('Listening');

            const result = await chrome.runtime.sendMessage({
                action: 'startSongDetectionForActiveTab',
                tabId: targetTab.id,
                detectorMode: 'firered-aed'
            });

            if (!result || !result.success) {
                if (result && result.requiresPopupAuthorization) {
                    detectHint.textContent = t('waiting_authorization');
                }
                setDetectionStatus('Error', {
                    error: (result && result.message) ? result.message : t('start_detection_failed')
                });
                showToast((result && result.message) ? result.message : t('start_detection_failed'));
                return;
            }

            setDetectionStatus(result.status || 'Listening', {
                warning: result.warning || '',
                runtimeInfo: result.runtimeInfo || null
            });
            if (result.warning) {
                showToast(result.warning, 4500);
            } else {
                showToast(t('song_detection_started'));
            }
        } catch (error) {
            setDetectionStatus('Error', {
                error: error?.message || String(error)
            });
            showToast(t('error_prefix', [error?.message || String(error)]));
        }
    });

    stopDetectBtn.addEventListener('click', async () => {
        try {
            const context = await chrome.runtime.sendMessage({ action: 'getSongDetectionAuthorizationContext' });
            const preferredTabId = context?.success && context.pending ? context.pending.tabId : null;
            const targetTab = await getActiveYouTubeTab(preferredTabId);
            if (!targetTab) {
                showToast(t('no_active_youtube_tab'));
                return;
            }
            const result = await chrome.runtime.sendMessage({
                action: 'stopSongDetectionForActiveTab',
                tabId: targetTab.id
            });
            if (!result || !result.success) {
                showToast((result && result.message) ? result.message : t('stop_detection_failed'));
                return;
            }
            setDetectionStatus('Stopped');
            showToast(t('song_detection_stopped'));
        } catch (error) {
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

    async function markFeatureNoticeSeen() {
        await chrome.storage.local.set({
            [FEATURE_NOTICE_STORAGE_KEY]: {
                lastSeenId: FEATURE_NOTICE_ID,
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
        resetFeatureNotice: async () => {
            await chrome.storage.local.remove(FEATURE_NOTICE_STORAGE_KEY);
            return maybeShowFeatureNotice({ force: true });
        },
        getFeatureNoticeState,
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
                    const parts = [];
                    if (h) parts.push(String(h));
                    parts.push(String(m).padStart(2, '0'));
                    parts.push(String(s).padStart(2, '0'));
                    return parts.join(':');
                }
                return String(tok);
            }
            // number of seconds
            if (typeof tok === 'number') {
                const s = Math.floor(tok);
                const h = Math.floor(s / 3600);
                const m = Math.floor((s % 3600) / 60);
                const sec = s % 60;
                return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
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
        const total = Math.max(0, Math.floor(seconds));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
        } catch (error) {
            minSegmentSecInput.value = String(DEFAULT_MIN_SEGMENT_DURATION_SEC);
        }
        await maybeShowFeatureNotice();
        refreshView();
        refreshDetectionPanel();
        setInterval(() => {
            refreshDetectionPanel();
        }, 2000);
    })();
});
