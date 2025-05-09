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

    try {
        dataClassModule            = await import('./lib/dataclass.js');
        playlistToolModule         = await import('./lib/playlistTool.js');
        mouseEventHandlerModule    = await import('./lib/mouseEventHandler.js');
        uiModule                   = await import('./lib/ui.js');
        themeModule                = await import('./lib/theme.js');
        runtimeHandlerModule       = await import('./lib/runtimeHandler.js');
        editModule                 = await import('./lib/editModule.js');
        getVideoInfoModule         = await import('./lib/getVideoInfo.js');
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
    const { enableEditMode }                                = editModule;

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

    // 常數（選擇器等）
    const sidebarQuery              = '#related.style-scope.ytd-watch-flexy';
    const appPlayListContainerQuery = '#ytj-playlist-container';

    // === [ 四、Chrome 訊息監聽與狀態控制 ] ============================================
    // 監聽來自 background.js 的訊息
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        (async () => {
            await handleRuntimeMessage(request, sender, sendResponse, {
                deleteAppElement,
                main,
                sidebarQuery,
                appPlayListContainerQuery,
                document
            });
        })();
        // 需回傳 true 以保持 sendResponse 的持續狀態
        return true;
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
     * 如果 YouTube 的側邊欄已加載，插入本插件 UI；否則等待一段時間後再嘗試。
     */
    async function appstart() {
        let sidebarElm = document.querySelector(sidebarQuery);
        if (sidebarElm) {
            main(sidebarElm);
        } else {
            // 不斷檢查直到找到側邊欄或超過指定次數
            let loopCount = 0;
            const loop = setInterval(() => {
                loopCount++;
                sidebarElm = document.querySelector(sidebarQuery);
                if (sidebarElm) {
                    clearInterval(loop);
                    main(sidebarElm);
                } else if (loopCount > 100) {
                    clearInterval(loop);
                }
            }, 100);
        }
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

        // 產生事件處理器
        mouseEventHandler     = new MouseEventHandler(ul, playlistContainer, playlistState);
        playlistTimeManager   = new PlaylistTimeManager(playlistContainer, playlistState);

        // 從 local storage 讀取該影片所對應的播放列表資料
        const videoId = getCurrentVideoId();
        if (!videoId) {
            console.debug('No video ID found for initialization.');
            return;
        }

        await chrome.storage.local.get([videoId], async (result) => {
            const savedState = result[videoId];
            if (savedState && Array.isArray(savedState)) {
                savedState.forEach(async itemData => {
                    const startTime = TimeSlot.fromObject(itemData.start);
                    const endTime   = TimeSlot.fromObject(itemData.end);
                    const newItem   = createPlaylistItem(startTime, endTime, itemData.title);
                    playlistState.playlistItems.push(newItem);
                    ul.appendChild(newItem);
                });
                playlistContainer.appendChild(ul);
                playlistState.state = savedState;
            }
        });

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
        // 1) 拖曳事件（以事件委派方式監聽 ul 的 mousedown）
        ul.addEventListener('mousedown', handleMouseDown);

        // 2) 點擊事件：偵測是否點擊了播放列表項目的文字（進入編輯）
        playlistContainer.addEventListener('click', handleClick);

        // 3) 監聽「新增到播放列表」按鈕點擊
        addToPlaylistButton.addEventListener('click', await addToPlaylist);

        // 4) 播放按鈕點擊事件
        playButton.addEventListener('click', async () => {
            const tabId = await chrome.runtime.sendMessage({ action: 'getTabId' });
            if (!tabId) {
                console.error('Failed to retrieve tabId');
                return;
            }

            const video = document.querySelector('video');
            if (!video) return;
            
            if (!playButton.classList.contains('playing')) {
                // 尚未在播放，開始播放
                await Promise.all(styleModificationPromises);
                styleModificationPromises.length = 0;
                await playPlaylist(0, playlistState.getPlaylistStateLength());
            } else {
                // 已在播放中，點擊後停止
                if (playButton.classList.contains('playing')) {
                    // 恢復 UI 樣式
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
                await Promise.all(styleModificationPromises);
                styleModificationPromises.length = 0;

                playButton.classList.remove('playing');
                video.pause();
                //console.log(tabId)
                await chrome.storage.local.set({ [`currentPlayId_${tabId}`]: 0 });
                
            }
        });

        // 5) 匯入 / 匯出按鈕（其實在 createImportExportContainer 時已經綁定，也可保留此處做保險）
        const importButton = document.querySelector('#ytj-import-playlist-text');
        const exportButton = document.querySelector('#ytj-export-playlist');
        if (importButton) importButton.addEventListener('click', importPlaylistFromText);
        if (exportButton) exportButton.addEventListener('click', exportPlaylist);
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
        playlistContainer.innerHTML = '';
        ul.innerHTML               = '';

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

        // 重新創建事件處理程序
        mouseEventHandler    = new MouseEventHandler(ul, playlistContainer, playlistState);
        playlistTimeManager  = new PlaylistTimeManager(playlistContainer, playlistState);
    }

    // === [ 八、播放列表的核心功能函式 ] ==============================================

    /**
     * 新增一個播放列表項目
     */
    async function addToPlaylist() {
        const newItem = createPlaylistItem();
        playlistState.playlistItems.push(newItem);
        ul.appendChild(newItem);
        playlistContainer.appendChild(ul);
        playlistState.state = getandUpdatePlaylistState(playlistState);
    }

    /**
     * 創建一個播放列表項目（li）
    * @param {TimeSlot} [startTime] - 項目開始時間（可選）
    * @param {TimeSlot} [endTime] - 項目結束時間（可選）
    * @param {string} [title] - 項目標題（可選）
     * @returns {HTMLElement} 新建立的播放列表項目
     */
    function createPlaylistItem(startTime, endTime, title) {
        // 確認起訖時間是否合法，若不合法則自動修正
        if (startTime !== undefined && endTime !== undefined) {
            const timeObj  = PlaylistTimeManager.checkStartAndEnd(startTime, endTime);
            startTime = timeObj.start;
            endTime   = timeObj.end;
        }

        const newItem    = document.createElement('li');
        newItem.classList.add('ytj-playlist-item');

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
        titleInput.value         = title || '';

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
        button.addEventListener('click', () => {
            try {
                playlistTimeManager.deletePlaylistItem(listItem);
                playlistState.state = getandUpdatePlaylistState(playlistState);
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
        createImportPopupTextBox('Import Playlist', async (text, additionalSeconds) => {
            if (!text) return;

            if (isNaN(additionalSeconds) || additionalSeconds <= 0) {
                additionalSeconds = 0;
            }

            const lines = text.split('\n');
            // 格式範例： "1:00 2:00 Title"
            const regex = /(\d{1,3}:\d{2}(?::\d{2})?)\s*(?:\D*\s*(\d{1,3}:\d{2}(?::\d{2})?))?\s*(.*)/;

            for (const line of lines) {
                const match = line.match(regex);
                if (match) {
                    const [, startTime, endTime, title] = match;
                    const start = TimeSlot.fromString(startTime);
                    const end   = endTime ? TimeSlot.fromString(endTime) : TimeSlot.fromTotalseconds(start.getTotalseconds() + additionalSeconds);
                    const newItem = createPlaylistItem(start, end, title);
                    playlistState.playlistItems.push(newItem);
                    ul.appendChild(newItem);
                }
            }
            playlistContainer.appendChild(ul);
            playlistState.state = getandUpdatePlaylistState(playlistState);
        });
    }

    /**
     * 使用者可直接編輯整段播放列表文本，再一次性套用
     */
    async function editPlaylistFromText() {
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

            if (!text) return;

            const lines = text.split('\n');
            const regex = /(\d{1,3}:\d{2}(?::\d{2})?)\s*(?:\D*\s*(\d{1,3}:\d{2}(?::\d{2})?))?\s*(.*)/;

            for (const line of lines) {
                const match = line.match(regex);
                if (match) {
                    const [, startTime, endTime, title] = match;
                    const start = TimeSlot.fromString(startTime);
                    const end   = endTime ? TimeSlot.fromString(endTime) : start;
                    const newItem = createPlaylistItem(start, end, title);
                    playlistState.playlistItems.push(newItem);
                    ul.appendChild(newItem);
                }
            }
            playlistContainer.appendChild(ul);
            playlistState.state = getandUpdatePlaylistState(playlistState);
        }).querySelector('textarea').value = originText;
    }

    /**
     * 將播放列表匯出成文字，使用者可自行複製
     */
    function exportPlaylist() {
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
