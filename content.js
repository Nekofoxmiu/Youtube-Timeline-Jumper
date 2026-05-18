'use strict';

//console.info('yt-paj content.js injected');

/**
 * 立即執行函式（IIFE，Immediately Invoked Function Expression）。
 * 整個 content script 的邏輯都寫在這個區塊裡。
 */
(async () => {
    // === [ 一、動態引入各種模組 ] =====================================================
    let dataClassModule;
    let playlistToolModule;
    let mouseEventHandlerModule;
    let uiModule;
    let themeModule;
    let runtimeHandlerModule;
    let getVideoInfoModule;
    let editModule;
    let stateManagerModule;
    let playlistControllerModule;

    try {
        dataClassModule            = await import('./lib/dataclass.js');
        playlistToolModule         = await import('./lib/playlistTool.js');
        mouseEventHandlerModule    = await import('./lib/mouseEventHandler.js');
        uiModule                   = await import('./lib/ui.js');
        themeModule                = await import('./lib/theme.js');
        runtimeHandlerModule       = await import('./lib/runtimeHandler.js');
        editModule                 = await import('./lib/editModule.js');
        getVideoInfoModule         = await import('./lib/getVideoInfo.js');
        stateManagerModule         = await import('./lib/stateManager.js');
        playlistControllerModule   = await import('./lib/playlistController.js');
    } catch (error) {
        console.error('Module loading failed:', error);
    }

    // === [ 二、從模組中解構所需的 Class 與函式 ] =====================================
    const { TimeSlot, PlaylistState }                       = dataClassModule;
    const { getandUpdatePlaylistState, PlaylistTimeManager }= playlistToolModule;
    const { MouseEventHandler }                             = mouseEventHandlerModule;
    const {
        createPlaylistContainer,
        createButtonContainer,
        createImportExportContainer,
        createAddToPlaylistButton,
        createImportPlaylistButton,
        createEditPlaylistButton,
        createExportPlaylistButton,
        createPlayButton,
        createPlaylistItemsContainer,
        createPopupTextBox,
        createImportPopupTextBox,
        createTimeTextElements,
        createToggleSwitch
    } = uiModule;
    const { applyTheme }                                    = themeModule;
    const { handleRuntimeMessage }                          = runtimeHandlerModule;
    const { getCurrentVideoId, getCurrentVideoTime }        = getVideoInfoModule;
    const { fetchVideoUploadTime }                          = getVideoInfoModule;
    const { enableEditMode }                                = editModule;
    const { PlaylistStateManager }                          = stateManagerModule;
    const { PlaylistController }                             = playlistControllerModule;

    // === [ 三、全域變數與常數 ] ======================================================
    // 共用 DOM 元素或容器
    let playlistContainer;
    let buttonContainer;
    let importexportContainer;
    let addToPlaylistButton;
    let importPlaylistButton;
    let editPlaylistButton;
    let exportPlaylistButton;
    let playButton;
    let toggleSwitch;
    let ul;

    // 共用物件與狀態
    const playlistState             = new PlaylistState();
    const styleModificationPromises = [];
    let mouseEventHandler;
    let playlistTimeManager;
    let stateManager;
    let playlistController;

    // 常數（選擇器等）
    const sidebarQuery              = '#related.style-scope.ytd-watch-flexy';
    const appPlayListContainerQuery = '#ytj-playlist-container';
    const AUTO_SONG_TYPE            = 'auto-song';

    // === [ 四、Chrome 訊息監聽與狀態控制 ] ============================================
    function roundNumber(value, digits = 3) {
        const num = Number(value);
        if (!Number.isFinite(num)) return 0;
        const factor = 10 ** digits;
        return Math.round(num * factor) / factor;
    }

    // 監聽來自 background.js 的訊息
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!request) return false;

        // quick sync handlers
        if (request.action === 'getCurrentVideoId') {
            sendResponse({ videoId: getCurrentVideoId() || null });
            return false;
        }

        if (request.action === 'getCurrentVideoTime') {
            const video = document.querySelector('video');
            sendResponse({
                videoId: getCurrentVideoId() || null,
                currentTime: video ? Number(video.currentTime) : null,
                duration: video && Number.isFinite(Number(video.duration)) ? Number(video.duration) : null,
                paused: video ? Boolean(video.paused) : null,
                playbackRate: video ? Number(video.playbackRate) : null,
                muted: video ? Boolean(video.muted) : null
            });
            return false;
        }

        if (request.action === 'workbenchQueueControl') {
            try {
                const video = document.querySelector('video');
                if (!video) {
                    sendResponse({ success: false, message: 'No YouTube video element found.' });
                    return false;
                }

                const patch = request.patch || {};
                if (Number.isFinite(Number(patch.currentTime))) {
                    const duration = Number.isFinite(Number(video.duration)) ? Number(video.duration) : Infinity;
                    video.currentTime = Math.max(0, Math.min(duration, Number(patch.currentTime)));
                }
                if (Number.isFinite(Number(patch.playbackRate))) {
                    video.playbackRate = Math.max(0.25, Math.min(16, Number(patch.playbackRate)));
                }
                if (typeof patch.muted === 'boolean') {
                    video.muted = patch.muted;
                }
                if (patch.command === 'play') {
                    const playPromise = video.play();
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch((error) => console.debug('Workbench video.play failed:', error));
                    }
                } else if (patch.command === 'pause') {
                    video.pause();
                }

                sendResponse({
                    success: true,
                    videoId: getCurrentVideoId() || null,
                    currentTime: Number(video.currentTime),
                    duration: Number.isFinite(Number(video.duration)) ? Number(video.duration) : null,
                    paused: Boolean(video.paused),
                    ended: Boolean(video.ended),
                    playbackRate: Number(video.playbackRate),
                    muted: Boolean(video.muted)
                });
            } catch (error) {
                sendResponse({ success: false, message: error?.message || String(error) });
            }
            return false;
        }

        if (request.action === 'songDetectionStatusChanged') {
            sendResponse({ success: true });
            return false;
        }

        // async handlers
        if (request.action === 'songSegmentsUpdated') {
            sendResponse({ success: true, accepted: true });
            (async () => {
                try {
                    const currentVideoId = getCurrentVideoId();
                    if (request.videoId && currentVideoId && request.videoId !== currentVideoId) {
                        return;
                    }
                    await refreshPlaylistFromStorage();
                } catch (error) {
                    console.debug('songSegmentsUpdated refresh failed:', error);
                }
            })();
            return false;
        }

        if (request.action === 'getUploadTime') {
            (async () => {
                try {
                    const vid = getCurrentVideoId();
                    // if videoId supplied in request, trust it; else use current
                    const targetVid = request.videoId || vid;
                    const t = await fetchVideoUploadTime(targetVid);
                    sendResponse({ uploadTime: t || null });
                } catch (e) {
                    sendResponse({ uploadTime: null });
                }
            })();
            return true;
        }

        if (request.action === 'playPlaylist') {
            (async () => {
                try {
                    if (!playlistController) {
                        sendResponse({ success: false, message: 'Playlist controller is not ready.' });
                        return;
                    }
                    await playlistController.playRange(request.startIndex, request.endIndex);
                    sendResponse({ success: true });
                } catch (error) {
                    sendResponse({ success: false, message: error?.message || String(error) });
                }
            })();
            return true;
        }

        if (!['removePlaylist', 'initializePlaylist'].includes(request.action)) {
            return false;
        }

        sendResponse({ success: true, accepted: true });
        (async () => {
            await handleRuntimeMessage(request, sender, () => {}, {
                deleteAppElement,
                main,
                sidebarQuery,
                appPlayListContainerQuery,
                document
            });
        })().catch((error) => {
            console.debug('Runtime message handling failed after acknowledgement:', error);
        });
        return false;
    });

    // 從 local storage 取得「插件是否啟動」的狀態並決定是否載入
    const response = await chrome.runtime.sendMessage({ action: 'getExtensionWorkOrNot' });
    //console.info('getExtensionWorkOrNot:', response);
    const extensionWorkOrNot = response.state || false;
    if (extensionWorkOrNot) {
        appstart();
    }

    // === [ 五、主題偵測與應用 ] =====================================================
    // 監聽 YouTube 主體（ytd-app）的樣式變更，以動態套用深/淺色主題
    const observer = new MutationObserver(() => {
        applyTheme();
    });
    const ytdApp = document.querySelector('ytd-app');
    if (ytdApp) {
        observer.observe(ytdApp, { attributes: true, attributeFilter: ['style'] });
    }
    // 初始化時先套用主題
    applyTheme();

    // === [ 六、主執行流程：appstart / main / initializePlaylist ] ===================
    /**
     * 如果 YouTube 的側邊欄已加載，插入本插件 UI；用 MutationObserver偵測。
     */
    async function appstart() {
        // 先嘗試立即取得側邊欄
        const sidebarElm = document.querySelector(sidebarQuery);
        if (sidebarElm) {
            main(sidebarElm);
            return;
        }
        // 如果還沒載入，就觀察 body 底下所有子孫節點 (subtree)
        const observer = new MutationObserver((mutations, obs) => {
            const elm = document.querySelector(sidebarQuery);
            if (elm) {
                // 偵測到側邊欄後，停止觀察並呼叫 main
                obs.disconnect();
                main(elm);
            }
        });
        observer.observe(document.body, {
            childList: true,    // 監聽新增／移除子節點
            subtree: true       // 包含所有子孫節點
        });
    }


    /**
     * 主程式入口：檢查是否已經有此容器，若沒有就進行初始化。
     * @param {HTMLElement} sidebarElm - 側邊欄元素
     */
    async function main(sidebarElm) {
        const appPlayListContainer = document.querySelector(appPlayListContainerQuery);

        // 如果已經有容器，但 videoId 不同，則刪除後重建
        if (appPlayListContainer) {
            if (appPlayListContainer.getAttribute('youtubeID') !== getCurrentVideoId()) {
                await deleteAppElement();
            } else {
                return;
            }
        }

        // 初始化播放列表
        await initializePlaylist(sidebarElm);
    }

    /**
     * 初始化播放列表：將 DOM 元素組裝並加到 YouTube 的側邊欄中。
     * @param {HTMLElement} sidebarElm - 側邊欄元素
     */
    async function initializePlaylist(sidebarElm) {
        // 產生 playlistContainer、按钮等主要 UI
        playlistContainer     = createPlaylistContainer(getCurrentVideoId());
        buttonContainer       = createButtonContainer();
        importexportContainer = createImportExportContainer();
        addToPlaylistButton   = createAddToPlaylistButton();
        importPlaylistButton  = createImportPlaylistButton(importPlaylistFromText);
        editPlaylistButton    = createEditPlaylistButton(editPlaylistFromText);
        exportPlaylistButton  = createExportPlaylistButton(exportPlaylist);
        playButton            = createPlayButton();
        toggleSwitch          = createToggleSwitch();
        ul                    = createPlaylistItemsContainer();

        // 初始化狀態管理器
        stateManager = new PlaylistStateManager(getCurrentVideoId());

        // 從 local storage 讀取該影片所對應的播放列表資料
        const videoId = getCurrentVideoId();
        if (!videoId) {
            console.debug('No video ID found for initialization.');
            return;
        }

        playlistController = new PlaylistController({
            videoId,
            playlistContainer,
            listElement: ul,
            playButton,
            toggleSwitch,
            createPopupTextBox,
            createImportPopupTextBox,
            legacyState: playlistState,
            getCurrentTimeSeconds: () => {
                const timeObj = getCurrentVideoTime();
                return timeObj ? timeObj.getTotalseconds() : 0;
            }
        });
        playlistController.bind();
        await playlistController.loadFromStorage();

        // 將 import/export/編輯 按鈕加入到 importexportContainer
        importexportContainer.appendChild(importPlaylistButton);
        importexportContainer.appendChild(editPlaylistButton);
        importexportContainer.appendChild(exportPlaylistButton);
        sidebarElm.insertBefore(importexportContainer, sidebarElm.firstChild);

        // 加入播放列表容器到側邊欄
        sidebarElm.insertBefore(playlistContainer, sidebarElm.firstChild);

        // 加入功能按鈕容器（新增播放項目、播放、切換模式...）
        buttonContainer.appendChild(addToPlaylistButton);
        buttonContainer.appendChild(playButton);
        buttonContainer.appendChild(toggleSwitch.element);
        sidebarElm.insertBefore(buttonContainer, sidebarElm.firstChild);

        // === [ 事件監聽 ] ===
        addToPlaylistButton.addEventListener('click', addToPlaylist);
    }

    function extractPlaylistItemOptions(itemData) {
        const itemType = itemData && itemData.type === AUTO_SONG_TYPE ? AUTO_SONG_TYPE : 'manual';
        const confidence = Number(itemData && itemData.confidence);
        return {
            type: itemType,
            confidence: Number.isFinite(confidence) ? confidence : null,
            provisional: typeof itemData?.provisional === 'boolean' ? itemData.provisional : null,
            detectorVersion: itemData && itemData.detectorVersion ? itemData.detectorVersion : null
        };
    }

    function renderPlaylistItems(savedState, meta) {
        playlistState.clearAll();
        if (ul) ul.innerHTML = '';

        const now = new Date().toISOString();
        if (Array.isArray(savedState)) {
            savedState.forEach(itemData => {
                try {
                    if (!itemData || typeof itemData !== 'object' || !itemData.start || !itemData.end) return;
                    const startTime = TimeSlot.fromObject(itemData.start);
                    const endTime = TimeSlot.fromObject(itemData.end);
                    const itemLastModified = itemData.lastModified || (meta && meta.lastModified) || now;
                    const itemUploadTime = itemData.uploadTime || (meta && meta.uploadTime) || now;
                    const options = extractPlaylistItemOptions(itemData);
                    const newItem = createPlaylistItem(
                        startTime,
                        endTime,
                        itemData.title,
                        { lastModified: itemLastModified, uploadTime: itemUploadTime },
                        options
                    );
                    playlistState.playlistItems.push(newItem);
                    ul.appendChild(newItem);
                } catch (error) {
                    console.debug('Failed to render playlist item:', error);
                }
            });
        }

        if (playlistContainer && ul && ul.parentNode !== playlistContainer) {
            playlistContainer.appendChild(ul);
        }
        playlistState.state = Array.isArray(savedState) ? savedState : [];
    }

    async function refreshPlaylistFromStorage() {
        if (playlistController) {
            await playlistController.loadFromStorage();
        }
    }

    // === [ 七、主要事件或 DOM 操作函式 ] ============================================

    /**
     * 處理 mousedown 事件（主要用於拖曳播放列表項目）
     */
    function handleMouseDown(event) {
        const dragHandle = event.target.closest('.ytj-drag-handle');
        if (dragHandle) {
            mouseEventHandler.handleDragStart(event);
        }
    }

    /**
     * 處理點擊事件：若點擊到可編輯區（start/end/title），進行編輯模式。
     */
    function handleClick(event) {
        const editableElement = event.target.closest('.ytj-playlist-item-text-start, .ytj-playlist-item-text-end, .ytj-playlist-item-title');
        if (editableElement) {
            // 已在編輯狀態則不重複啟動
            if (editableElement.contentEditable === 'true' || editableElement.readOnly === false) {
                return;
            }
            enableEditMode(editableElement, playlistState, playlistTimeManager);
        }
    }

    /**
     * 刪除整個插件產生的 DOM（當切換影片或重新載入時可能需要用到）
     */
    async function deleteAppElement() {
        if (playlistController) {
            playlistController.destroy();
            playlistController = null;
        }

        // 清除資料
        playlistState.clearAll();

        // 找到舊元素並移除
        const oldPlaylistContainer     = document.querySelector(appPlayListContainerQuery);
        const oldbuttonContainer       = document.querySelector('#ytj-button-container');
        const oldimportexportContainer = document.querySelector('#ytj-importexport-container');
        const oldAddToPlaylistButton   = document.querySelector('.ytj-add-to-playlist');
        const oldPlayButton            = document.querySelector('.ytj-play-playlist');
        const oldImportPlaylistButton  = document.querySelector('.ytj-import-playlist-text');
        const oldEditPlaylistButton    = document.querySelector('.ytj-edit-playlist-text');
        const oldExportPlaylistButton  = document.querySelector('.ytj-export-playlist');
        const oldUl                    = document.querySelector('.ytj-playlist-items');

        if (oldPlaylistContainer)     oldPlaylistContainer.remove();
        if (oldbuttonContainer)       oldbuttonContainer.remove();
        if (oldimportexportContainer) oldimportexportContainer.remove();
        if (oldAddToPlaylistButton)   oldAddToPlaylistButton.remove();
        if (oldPlayButton)            oldPlayButton.remove();
        if (oldImportPlaylistButton)  oldImportPlaylistButton.remove();
        if (oldEditPlaylistButton)    oldEditPlaylistButton.remove();
        if (oldExportPlaylistButton)  oldExportPlaylistButton.remove();
        if (oldUl)                    oldUl.remove();

        // 清空容器內容
        if (playlistContainer) playlistContainer.innerHTML = '';
        if (ul) ul.innerHTML = '';

        // 重新創建容器和按鈕
        playlistContainer     = createPlaylistContainer(getCurrentVideoId());
        buttonContainer       = createButtonContainer();
        importexportContainer = createImportExportContainer();
        addToPlaylistButton   = createAddToPlaylistButton();
        playButton            = createPlayButton();
        toggleSwitch          = createToggleSwitch();
        importPlaylistButton  = createImportPlaylistButton(importPlaylistFromText);
        editPlaylistButton    = createEditPlaylistButton(editPlaylistFromText);
        exportPlaylistButton  = createExportPlaylistButton(exportPlaylist);
        ul                    = createPlaylistItemsContainer();

        // 重新初始化狀態管理器
        stateManager         = new PlaylistStateManager(getCurrentVideoId());

        mouseEventHandler    = null;
        playlistTimeManager  = null;
    }

    // === [ 八、播放列表的核心功能函式 ] ==============================================

    /**
     * 新增一個播放列表項目
     */
    function addToPlaylist() {
        if (playlistController) {
            playlistController.addAtCurrentTime();
            return;
        }
    const now = new Date().toISOString();
    const newItem = createPlaylistItem(null, null, '', { lastModified: now, uploadTime: now });
        playlistState.playlistItems.push(newItem);
        ul.appendChild(newItem);
        playlistContainer.appendChild(ul);
        playlistState.state = getandUpdatePlaylistState(playlistState);
        if (stateManager) {
            stateManager.setState(playlistState.state);
            stateManager.save();
            // ensure meta exists / update lastModified/uploadTime
            try {
                (async () => {
                    const existingMeta = await stateManager.loadMeta() || {};
                    const newMeta = { ...(existingMeta || {}), uploadTime: existingMeta.uploadTime || now, lastModified: now };
                    await stateManager.saveMeta(newMeta);
                })();
            } catch (e) {
                // ignore
            }
        }
    }

    /**
     * 創建一個播放列表項目（li）
    * @param {TimeSlot} [startTime] - 項目開始時間（可選）
    * @param {TimeSlot} [endTime] - 項目結束時間（可選）
    * @param {string} [title] - 項目標題（可選）
     * @returns {HTMLElement} 新建立的播放列表項目
     */
    function createPlaylistItem(startTime, endTime, title, meta, options = {}) {
        // 確認起訖時間是否合法，若不合法則自動修正
        if (startTime != null && endTime != null) {
            const timeObj  = PlaylistTimeManager.checkStartAndEnd(startTime, endTime);
            startTime = timeObj.start;
            endTime   = timeObj.end;
        }

        const itemType = options.type || 'manual';
        const isAutoSongItem = itemType === AUTO_SONG_TYPE;
        const isProvisional = isAutoSongItem && Boolean(options.provisional);

        const newItem = document.createElement('li');
        newItem.classList.add('ytj-playlist-item');
        if (isAutoSongItem) newItem.classList.add('ytj-auto-song-item');
        if (isProvisional) newItem.classList.add('ytj-auto-song-provisional');

        // 拖曳把手
        const dragHandle = document.createElement('div');
        dragHandle.classList.add('ytj-drag-handle');
        dragHandle.draggable = true;
        dragHandle.addEventListener('dragstart', mouseEventHandler.handleDragStart);

        // 時間文字（start / end）
        const TimeTextElements = createTimeTextElements(startTime, endTime);
        const startTimeText    = TimeTextElements.startElement;
        const endTimeText      = TimeTextElements.endElement;

        // UI 上的功能按鈕
        const setStartTimeButton = createSetStartTimeButton();
        const setEndTimeButton   = createSetEndTimeButton();
        const deleteButton       = createDeleteButton(newItem);
        const startFromHereBtn   = createStartFromHereButton(newItem);

        // 播放列表項目標題 input
        const titleInput         = createTitleInput();
        const fallbackTitle = isProvisional ? 'Auto Song (Provisional)' : (isAutoSongItem ? 'Auto Song' : '');
        titleInput.value         = title || fallbackTitle;

        // attach metadata to DOM dataset
        const now = new Date().toISOString();
        newItem.dataset.lastModified = (meta && meta.lastModified) ? meta.lastModified : now;
        newItem.dataset.uploadTime = (meta && meta.uploadTime) ? meta.uploadTime : now;
        newItem.dataset.itemType = itemType;
        if (options.detectorVersion) newItem.dataset.detectorVersion = options.detectorVersion;
        if (options.confidence !== null && options.confidence !== undefined && Number.isFinite(Number(options.confidence))) {
            newItem.dataset.confidence = String(roundNumber(options.confidence, 3));
        }
        if (typeof options.provisional === 'boolean') {
            newItem.dataset.provisional = String(options.provisional);
        }

        // 將上述元素組合到 newItem
        newItem.appendChild(dragHandle);
        newItem.appendChild(startFromHereBtn);
        newItem.appendChild(startTimeText);
        newItem.appendChild(endTimeText);
        newItem.appendChild(titleInput);
        newItem.appendChild(setStartTimeButton);
        newItem.appendChild(setEndTimeButton);
        newItem.appendChild(deleteButton);

        return newItem;
    }

    /**
     * 「開始播放」按鈕（從此處開始播放）
     */
    function createStartFromHereButton(listItem) {
        const button = document.createElement('button');
        button.classList.add('ytj-start-from-here');
        button.addEventListener('click', async (event) => {
            try {
                const video = document.querySelector('video');
                if (!video) return;

                const index = Array.from(playlistState.playlistItems).indexOf(listItem);

                // 如果已在播放狀態，先清除播放樣式
                if (playButton.classList.contains('playing')) {
                    const styleModificationPromise = new Promise(resolve => {
                        document.querySelectorAll('.ytj-playing-item')
                                .forEach(item => item.classList.remove('ytj-playing-item'));
                        document.querySelectorAll('.ytj-drag-handle.playing')
                                .forEach(handle => handle.classList.remove('playing'));
                        resolve();
                    });
                    styleModificationPromises.push(styleModificationPromise);
                    await styleModificationPromise;
                }

                // 確保所有樣式修改都完成後再進行播放
                await Promise.all(styleModificationPromises);
                styleModificationPromises.length = 0;

                // 如果使用者按下 Ctrl 或者切換開關為開啟狀態，只播放當前和下一個；否則從當前一路播到最後
                if (event.ctrlKey === true || toggleSwitch.getSwitchState() === true) {
                    await playPlaylist(index, index + 1);
                } else {
                    await playPlaylist(index, playlistState.getPlaylistStateLength());
                }

            } catch (error) {
                console.debug('Error occurred while trying to start from here:', error);
            }
        });
        return button;
    }

    /**
     * 建立「設定起始時間」按鈕
     */
    function createSetStartTimeButton() {
        const button = document.createElement('button');
        button.classList.add('ytj-set-start-time');
        button.addEventListener('click', (event) => {
            const listItem      = event.target.closest('.ytj-playlist-item');
            const startTimeText = listItem.querySelector('.ytj-playlist-item-text-start');
            const originalTime  = Number(startTimeText.getAttribute('timeat'));
            const timeObj       = getCurrentVideoTime();

            if (timeObj) {
                startTimeText.innerText = timeObj.toformatString();
                startTimeText.setAttribute('timeat', timeObj.getTotalseconds().toString());

                // 更新列表內記錄
                playlistTimeManager.updateTimeText(startTimeText, originalTime);
                playlistState.state = getandUpdatePlaylistState(playlistState);
                if (stateManager) {
                    stateManager.setState(playlistState.state);
                    stateManager.save();
                }
            }
        });
        return button;
    }

    /**
     * 建立「設定結束時間」按鈕
     */
    function createSetEndTimeButton() {
        const button = document.createElement('button');
        button.classList.add('ytj-set-end-time');
        button.addEventListener('click', (event) => {
            try {
                const listItem     = event.target.closest('.ytj-playlist-item');
                const endTimeText  = listItem.querySelector('.ytj-playlist-item-text-end');
                const originalTime = Number(endTimeText.getAttribute('timeat'));
                const timeObj      = getCurrentVideoTime();
                if (timeObj) {
                    endTimeText.innerText = timeObj.toformatString();
                    endTimeText.setAttribute('timeat', timeObj.getTotalseconds().toString());

                    playlistTimeManager.updateTimeText(endTimeText, originalTime);
                    playlistState.state = getandUpdatePlaylistState(playlistState);
                    if (stateManager) {
                        stateManager.setState(playlistState.state);
                        stateManager.save();
                    }
                }
            } catch (error) {
                console.debug('Error occurred while setting end time:', error);
            }
        });
        return button;
    }

    /**
     * 建立「刪除項目」按鈕
     */
    function createDeleteButton(listItem) {
        const button = document.createElement('button');
        button.classList.add('ytj-delete-item');
    button.addEventListener('click', async () => {
            try {
                playlistTimeManager.deletePlaylistItem(listItem);
                playlistState.state = getandUpdatePlaylistState(playlistState);
                if (stateManager) {
                    stateManager.setState(playlistState.state);
                    stateManager.save();
                    // If this playlist became empty, remove storage key entirely
                    if (!playlistState.playlistItems || playlistState.playlistItems.length === 0) {
                        try {
                            const vid = getCurrentVideoId();
                            if (vid) {
                await chrome.storage.local.remove([`playlist_${vid}`, `playlist_meta_${vid}`]);
                            }
                        } catch (removeErr) {
                            console.debug('Failed to remove empty playlist storage key:', removeErr);
                        }
                    }
                }
            } catch (error) {
                console.debug('Error occurred while trying to delete playlist item:', error);
            }
        });
        return button;
    }

    /**
     * 建立標題 input（初始為 readonly）
     */
    function createTitleInput() {
        const input = document.createElement('input');
        input.type  = 'text';
        input.classList.add('ytj-playlist-item-title', 'editable');
        input.placeholder = 'Title';
        input.readOnly    = true; // 初始只讀
        return input;
    }

    /**
     * 播放 playlist（呼叫 background.js 處理實際進度控管）
     */
    async function playPlaylist(startIndex = 0, endIndex = 0) {
        if (playlistController) {
            await playlistController.playRange(startIndex, endIndex);
            return;
        }
        await chrome.runtime.sendMessage({
            action: 'playPlaylist',
            startIndex: startIndex,
            endIndex: endIndex,
            videoId: getCurrentVideoId()
        });
    }

    // === [ 九、匯入 / 匯出 / 編輯功能 ] ===============================================

    /**
     * 從使用者貼上的文字匯入播放列表
     */
    async function importPlaylistFromText() {
        if (playlistController) {
            playlistController.openImportDialog();
            return;
        }
        createImportPopupTextBox('Import Playlist', async (text, additionalSeconds) => {
            if (!text) return;

            // 檢查 additionalSeconds
            if (isNaN(additionalSeconds) || additionalSeconds <= 0) {
                additionalSeconds = 0;
            }

            const lines = text.split('\n');

            // === 小工具函式 ===
            const isTimeToken = tok => {
                // 允許 1:23 或 1:23:45；全部都是數字與冒號
                const parts = tok.split(':');
                if (parts.length < 2 || parts.length > 3) return false;
                return parts.every(p => /^\d+$/.test(p));
            };

            const timeTokenToSeconds = tok => {
                const nums = tok.split(':').map(Number); // [m,s] 或 [h,m,s]
                if (nums.length === 2) {               // mm:ss  or m:ss
                    return nums[0] * 60 + nums[1];
                } else {                               // h:mm:ss
                    return nums[0] * 3600 + nums[1] * 60 + nums[2];
                }
            };
            // === 迴圈解析 ===
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) continue;

                // 以空白分割並去掉連續空白
                const tokens = line.split(/\s+/);
                if (tokens.length === 0) continue;

                // 解析起始時間
                const first = tokens[0];
                if (!isTimeToken(first)) continue;             // 無合法時間碼 → 跳過

                const startSec = timeTokenToSeconds(first);
                let endSec   = null;
                let titleIdx = 1;

                // 檢查第二個 token 是否也是時間碼
                if (tokens.length > 1 && isTimeToken(tokens[1])) {
                    endSec   = timeTokenToSeconds(tokens[1]);
                    titleIdx = 2;
                } else {
                    endSec = startSec + additionalSeconds;
                }

                const title = tokens.slice(titleIdx).join(' ').trim();

                // 建立 TimeSlot 與 playlist item
                const start = TimeSlot.fromTotalseconds(startSec);
                const end   = TimeSlot.fromTotalseconds(endSec);
                const now = new Date().toISOString();
                const newItem = createPlaylistItem(start, end, title, { lastModified: now, uploadTime: now });

                playlistState.playlistItems.push(newItem);
                ul.appendChild(newItem);
            }

            playlistContainer.appendChild(ul);
            playlistState.state = getandUpdatePlaylistState(playlistState);
            if (stateManager) {
                stateManager.setState(playlistState.state);
                stateManager.save();
                // persist playlist-level meta
                (async () => {
                    try {
                        if (typeof stateManager.saveMeta === 'function') {
                            const metaCandidates = playlistState.playlistItems.map(it => ({
                                lastModified: it.dataset?.lastModified || null,
                                uploadTime: it.dataset?.uploadTime || null
                            }));
                            const lmList = metaCandidates.map(m => m.lastModified).filter(Boolean).sort();
                            const utList = metaCandidates.map(m => m.uploadTime).filter(Boolean).sort();
                            const lastModified = lmList.length ? lmList.slice(-1)[0] : new Date().toISOString();
                            const uploadTime = utList.length ? utList[0] : new Date().toISOString();
                            await stateManager.saveMeta({ lastModified, uploadTime });
                        }
                    } catch (e) {
                        // ignore
                    }
                })();
            }
        });
    }


    /**
     * 使用者可直接編輯整段播放列表文本，再一次性套用
     */
    async function editPlaylistFromText() {
        if (playlistController) {
            playlistController.openBulkEditDialog();
            return;
        }
        // 把目前列表的內容先變成文字
        const items = playlistState.playlistItems.map(item => {
            const start = item.querySelector('.ytj-playlist-item-text-start').innerText;
            const end   = item.querySelector('.ytj-playlist-item-text-end').innerText;
            const title = item.querySelector('.ytj-playlist-item-title').value;
            return `${start} ${end !== start ? end : ''} ${title}`.trim();
        });
        const originText = items.join('\n');

        // 建立彈窗，顯示舊文字供使用者修改
        createPopupTextBox('Edit Playlist', async (text) => {
            // 先刪除所有項目再重新匯入
            playlistTimeManager.deleteAllPlaylistItems();
            playlistState.state = getandUpdatePlaylistState(playlistState);
            if (stateManager) {
                stateManager.setState(playlistState.state);
                stateManager.save();
            }

            if (!text) return;

            const lines = text.split('\n');
            const regex = /(\d{1,3}:\d{2}(?::\d{2})?)\s*(?:\D*\s*(\d{1,3}:\d{2}(?::\d{2})?))?\s*(.*)/;

            for (const line of lines) {
                const match = line.match(regex);
                if (match) {
                    const [, startTime, endTime, title] = match;
                    const start = TimeSlot.fromString(startTime);
                    const end   = endTime ? TimeSlot.fromString(endTime) : start;
                    const now = new Date().toISOString();
                    const newItem = createPlaylistItem(start, end, title, { lastModified: now, uploadTime: now });
                    playlistState.playlistItems.push(newItem);
                    ul.appendChild(newItem);
                }
            }
            playlistContainer.appendChild(ul);
            playlistState.state = getandUpdatePlaylistState(playlistState);
            if (stateManager) {
                stateManager.setState(playlistState.state);
                stateManager.save();
                // persist playlist-level meta
                (async () => {
                    try {
                        if (typeof stateManager.saveMeta === 'function') {
                            const metaCandidates = playlistState.playlistItems.map(it => ({
                                lastModified: it.dataset?.lastModified || null,
                                uploadTime: it.dataset?.uploadTime || null
                            }));
                            const lmList = metaCandidates.map(m => m.lastModified).filter(Boolean).sort();
                            const utList = metaCandidates.map(m => m.uploadTime).filter(Boolean).sort();
                            const lastModified = lmList.length ? lmList.slice(-1)[0] : new Date().toISOString();
                            const uploadTime = utList.length ? utList[0] : new Date().toISOString();
                            await stateManager.saveMeta({ lastModified, uploadTime });
                        }
                    } catch (e) {
                        // ignore
                    }
                })();
            }
        }).querySelector('textarea').value = originText;
    }

    /**
     * 將播放列表匯出成文字，使用者可自行複製
     */
    function exportPlaylist() {
        if (playlistController) {
            playlistController.openExportDialog();
            return;
        }
        const items = playlistState.playlistItems.map(item => {
            const start = item.querySelector('.ytj-playlist-item-text-start').innerText;
            const end   = item.querySelector('.ytj-playlist-item-text-end').innerText;
            const title = item.querySelector('.ytj-playlist-item-title').value;
            return `${start} ${end !== start ? end : ''} ${title}`.trim();
        });
        const text = items.join('\n');
        createPopupTextBox('Export Playlist', () => { })
            .querySelector('textarea').value = text;
    }

})(); // IIFE 結束
