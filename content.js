'use strict';
console.log('yt-paj content.js injected');

(async () => {
    // 模組變數
    let dataClassModule;
    let playlistToolModule;
    let mouseEventHandlerModule;
    let uiModule;
    let themeModule;
    let runtimeHandlerModule;

    try {
        dataClassModule = await import('./lib/dataclass.js');
        playlistToolModule = await import('./lib/playlistTool.js');
        mouseEventHandlerModule = await import('./lib/mouseEventHandler.js');
        uiModule = await import('./lib/ui.js');
        themeModule = await import('./lib/theme.js'); // 動態導入 theme 模組
        runtimeHandlerModule = await import('./lib/runtimeHandler.js'); // 動態導入 runtimeHandler 模組
    } catch (error) {
        console.log('Module loading failed:', error);
    }

    const { TimeSlot, PlaylistItem, PlaylistState } = dataClassModule;
    const { getandUpdatePlaylistState, PlaylistTimeManager } = playlistToolModule;
    const { MouseEventHandler } = mouseEventHandlerModule;
    const { createPlaylistContainer, createButtonContainer, createImportExportContainer, createAddToPlaylistButton, createImportPlaylistButton, createExportPlaylistButton, createPlayButton, createPlaylistItemsContainer, createPopupTextBox } = uiModule;
    const { isYouTubeDarkTheme, applyTheme } = themeModule; // 解構導入的函數
    const { handleRuntimeMessage } = runtimeHandlerModule;

    // 共用變數
    let playlistContainer;
    let buttonContainer;
    let importexportContainer;
    let addToPlaylistButton;
    let importPlaylistButton;
    let exportPlaylistButton;
    let playButton;
    let ul;

    // 狀態變數
    const playlistState = new PlaylistState();
    const styleModificationPromises = [];
    let mouseEventHandler;
    let playlistTimeManager;

    // 常量
    const sidebarQuery = '#related.style-scope.ytd-watch-flexy';
    const appPlayListContainerQuery = '#ytj-playlist-container';

    playlistContainer = createPlaylistContainer(getCurrentVideoId());
    buttonContainer = createButtonContainer();
    importexportContainer = createImportExportContainer();
    addToPlaylistButton = createAddToPlaylistButton();
    importPlaylistButton = createImportPlaylistButton(importPlaylistFromText);
    exportPlaylistButton = createExportPlaylistButton(exportPlaylist);
    playButton = createPlayButton();
    ul = createPlaylistItemsContainer();

    mouseEventHandler = new MouseEventHandler(ul, playlistContainer, playlistState);
    playlistTimeManager = new PlaylistTimeManager(playlistContainer, playlistState);

    async function appstart() {
        let sidebarElm = document.querySelector(sidebarQuery);
        if (sidebarElm) {
            main(sidebarElm);
        } else {
            // loop for wait sidebarElm
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

    // 讀取本地存儲中的狀態並決定是否啟動應用
    chrome.runtime.sendMessage({ action: 'getExtensionWorkOrNot' }, (response) => {
        let extensionWorkOrNot = response.state || false;
        if (extensionWorkOrNot) {
            appstart();
        }
    });

    
    // 初始化並與 background.js 綁定
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
        return true; // 返回 true 以保持 sendResponse 的持續狀態
    });
    

    // 監聽主題變更
    const observer = new MutationObserver(() => {
        applyTheme();
    });
    const ytdApp = document.querySelector('ytd-app');
    if (ytdApp) {
        observer.observe(ytdApp, { attributes: true, attributeFilter: ['style'] });
    }

    // 初始化時應用主題
    applyTheme();

    /**
     * 創建 "從這裡開始播放" 按鈕的函數
     * @param {HTMLElement} listItem - 播放列表項目元素
     * @returns {HTMLElement} 按鈕元素
     */
    async function createStartFromHereButton(listItem) {
        const button = document.createElement('button');
        button.classList.add('ytj-start-from-here');
        button.addEventListener('click', async () => {
            const video = document.querySelector('video');
            if (!video) return;
            const index = Array.from(playlistState.playlistItems).indexOf(listItem);

            if (playButton.classList.contains('playing')) {
                // 如果 playButton 是 playing 狀態，則恢復按鈕樣式再播放
                const styleModificationPromise = new Promise(resolve => {
                    document.querySelectorAll('.ytj-playing-item').forEach(item => item.classList.remove('ytj-playing-item'));
                    document.querySelectorAll('.ytj-drag-handle.playing').forEach(handle => handle.classList.remove('playing'));
                    resolve();
                });
                styleModificationPromises.push(styleModificationPromise);
                await styleModificationPromise;
            }

            // 確保所有樣式修改操作都完成後再繼續
            await Promise.all(styleModificationPromises);
            styleModificationPromises.length = 0; // 清空已完成的 promise 列表

            await playPlaylist(index);
        });
        return button;
    }

    /**
     * 獲取當前視頻播放時間，並轉換為小時、分鐘和秒。
     * @returns {?TimeSlot} 包含時間信息的物件，或者如果沒有視頻元素則返回 null。
     */
    function getCurrentVideoTime() {
        const video = document.querySelector('video');
        if (!video) return null;
        return TimeSlot.fromTotalseconds(Math.floor(video.currentTime));
    }

    /**
     * 創建一個時間文本元素，用於播放列表中顯示和編輯時間。
     * @param {string} startOrEnd - 指示是創建開始時間還是結束時間的元素允許值 'start', 'end'。
     * @returns {HTMLElement|null} 返回一個時間文本的 DOM 元素，如果沒有視頻元素則返回 null。
     */
    function createTimeTextElement(startOrEnd) {
        const timeObj = getCurrentVideoTime();
        if (!timeObj) {
            console.log('No video element found.');
            return null;
        }

        const itemText = document.createElement('div');
        itemText.classList.add(`ytj-playlist-item-text-${startOrEnd}`);
        itemText.innerText = timeObj.toformatString();
        itemText.setAttribute('timeat', timeObj.getTotalseconds().toString());
        itemText.contentEditable = false;
        return itemText;
    }

    /**
    * 獲取當前 YouTube 影片 ID。
    * @returns {string|null} 影片 ID 或 null。
    */
    function getCurrentVideoId() {
        const videoUrl = window.location.href;
        const urlParams = new URLSearchParams((new URL(videoUrl)).search);
        return urlParams.get('v');
    }

    async function deleteAppElement() {
        playlistState.clearAll();

        const oldPlaylistContainer = document.querySelector(appPlayListContainerQuery);
        const oldbuttonContainer = document.querySelector('#ytj-button-container');
        const oldimportexportContainer = document.querySelector('#ytj-importexport-container');
        const oldAddToPlaylistButton = document.querySelector('.ytj-add-to-playlist');
        const oldPlayButton = document.querySelector('.ytj-play-playlist');
        const oldImportPlaylistButton = document.querySelector('.ytj-import-playlist-text');
        const oldExportPlaylistButton = document.querySelector('.ytj-export-playlist');
        const oldUl = document.querySelector('.ytj-playlist-items');

        if (oldPlaylistContainer) oldPlaylistContainer.remove();
        if (oldbuttonContainer) oldbuttonContainer.remove();
        if (oldimportexportContainer) oldimportexportContainer.remove();
        if (oldAddToPlaylistButton) oldAddToPlaylistButton.remove();
        if (oldPlayButton) oldPlayButton.remove();
        if (oldImportPlaylistButton) oldImportPlaylistButton.remove();
        if (oldExportPlaylistButton) oldExportPlaylistButton.remove();
        if (oldUl) oldUl.remove();

        // 清空容器內容
        playlistContainer.innerHTML = '';
        ul.innerHTML = '';

        // 重新創建容器和按鈕
        playlistContainer = createPlaylistContainer(getCurrentVideoId());
        buttonContainer = createButtonContainer();
        importexportContainer = createImportExportContainer();
        addToPlaylistButton = createAddToPlaylistButton();
        playButton = createPlayButton();
        importPlaylistButton = createImportPlaylistButton(importPlaylistFromText);
        exportPlaylistButton = createExportPlaylistButton(exportPlaylist);
        ul = createPlaylistItemsContainer();

        // 重新創建事件處理程序
        mouseEventHandler = new MouseEventHandler(ul, playlistContainer, playlistState);
        playlistTimeManager = new PlaylistTimeManager(playlistContainer, playlistState);
    }


    /**
     * 主程式入口
     * @param {HTMLElement} sidebarElm - 側邊欄元素
     */
    async function main(sidebarElm) {
        const appPlayListContainer = document.querySelector(appPlayListContainerQuery);
        if (appPlayListContainer) {
            if (appPlayListContainer.getAttribute('youtubeID') !== getCurrentVideoId()) {
                await deleteAppElement();
            }
        }

        initializePlaylist(sidebarElm);
    }


    /**
     * 初始化播放列表
     * @param {HTMLElement} sidebarElm - 側邊欄元素
     */
    async function initializePlaylist(sidebarElm) {
        // 將播放列表容器和按鈕插入側邊欄
        const videoId = getCurrentVideoId();
        if (!videoId) {
            console.log('No video ID found for initialization.');
            return;
        }

        chrome.storage.sync.get([videoId], async (result) => {
            const savedState = result[videoId];
            if (savedState && Array.isArray(savedState)) {
                savedState.forEach(async itemData => {
                    const startTime = TimeSlot.fromObject(itemData.start);
                    const endTime = TimeSlot.fromObject(itemData.end);
                    const newItem = await createPlaylistItemFromData(startTime, endTime, itemData.title);
                    playlistState.playlistItems.push(newItem);
                    ul.appendChild(newItem);
                });
                playlistContainer.appendChild(ul);
            }
        });

        importexportContainer.appendChild(importPlaylistButton);
        importexportContainer.appendChild(exportPlaylistButton);
        sidebarElm.insertBefore(importexportContainer, sidebarElm.firstChild);

        sidebarElm.insertBefore(playlistContainer, sidebarElm.firstChild);

        buttonContainer.appendChild(addToPlaylistButton);
        buttonContainer.appendChild(playButton);
        sidebarElm.insertBefore(buttonContainer, sidebarElm.firstChild); // 插入按鈕容器

        // 使用事件委派來處理所有子項目的 mousedown 事件
        ul.addEventListener('mousedown', handleMouseDown);

        // 使用事件委派來處理所有子項目的點擊、編輯和保存邏輯
        playlistContainer.addEventListener('click', handleClick);

        // 監聽添加到播放列表按鈕的點擊事件
        addToPlaylistButton.addEventListener('click', await addToPlaylist);

        // 在播放按鈕的點擊事件中調用 clearPlayingStyles
        // 播放按鈕點擊事件
        playButton.addEventListener('click', async () => {
            if (!playButton.classList.contains('playing')) {
                await Promise.all(styleModificationPromises);
                styleModificationPromises.length = 0; // 清空已完成的 promise 列表
                await playPlaylist();
            } else {
                const video = document.querySelector('video');
                if (video) {

                    if (playButton.classList.contains('playing')) {
                        // 如果 playButton 是 playing 狀態，則恢復按鈕樣式
                        const styleModificationPromise = new Promise(resolve => {
                            document.querySelectorAll('.ytj-playing-item').forEach(item => item.classList.remove('ytj-playing-item'));
                            document.querySelectorAll('.ytj-drag-handle.playing').forEach(handle => handle.classList.remove('playing'));
                            resolve();
                        });
                        styleModificationPromises.push(styleModificationPromise);
                        await styleModificationPromise;
                    }

                    // 確保所有樣式修改操作都完成後再繼續
                    await Promise.all(styleModificationPromises);
                    styleModificationPromises.length = 0; // 清空已完成的 promise 列表
                    playButton.classList.remove('playing');
                    video.pause();
                    await chrome.storage.local.set({ currentPlayId: 0 });
                }
            }
        });

        // 監聽文本區域按鈕的點擊事件
        const importButton = document.querySelector('#ytj-import-playlist-text');
        const exportButton = document.querySelector('#ytj-export-playlist');
        if (importButton) importButton.addEventListener('click', importPlaylistFromText);
        if (exportButton) exportButton.addEventListener('click', exportPlaylist);
    }

    /**
     * 處理 mousedown 事件
     * @param {Event} event - 事件物件
     */
    function handleMouseDown(event) {
        const dragHandle = event.target.closest('.ytj-drag-handle');
        if (dragHandle) {
            mouseEventHandler.handleDragStart(event);
        }
    }

    /**
     * 處理點擊事件
     * @param {Event} event - 事件物件
     */
    function handleClick(event) {
        const timeTextElement = event.target.closest('.ytj-playlist-item-text-start, .ytj-playlist-item-text-end');
        if (!timeTextElement) return;
        if (timeTextElement.contentEditable === 'true') return; // 如果已經是編輯模式，則不進行操作

        // 啟用編輯模式
        enableEditMode(timeTextElement);
    }

    /**
     * 啟用編輯模式
     * @param {HTMLElement} timeTextElement - 時間文本元素
     */
    function enableEditMode(timeTextElement) {
        const originalText = timeTextElement.innerText;
        const originalTime = Number(timeTextElement.getAttribute('timeat'));
        timeTextElement.contentEditable = 'true';
        timeTextElement.focus();

        // 設置失去焦點事件處理
        timeTextElement.addEventListener('blur', () => handleBlur(timeTextElement, originalTime), { once: true });

        // 設置鍵盤事件，以支持保存和取消
        timeTextElement.addEventListener('keydown', (event) => handleKeydown(event, timeTextElement, originalText));
    }
    /**
     * 處理失去焦點事件
     * @param {HTMLElement} timeTextElement - 時間文本元素
     * @param {number} originalTime - 原始時間
     */
    function handleBlur(timeTextElement, originalTime) {
        timeTextElement.contentEditable = 'false';
        playlistTimeManager.updateTimeText(timeTextElement, originalTime);
        playlistState.state = getandUpdatePlaylistState(playlistState);
    }

    /**
     * 處理鍵盤事件
     * @param {Event} event - 事件物件
     * @param {HTMLElement} timeTextElement - 時間文本元素
     * @param {string} originalText - 原始文本
     */
    function handleKeydown(event, timeTextElement, originalText) {
        event.stopPropagation(); // 防止事件冒泡
        if (event.key === 'Enter') {
            event.preventDefault(); // 防止 Enter 鍵的默認行為
            timeTextElement.blur(); // 觸發失去焦點事件來保存
        } else if (event.key === 'Escape') {
            timeTextElement.innerText = originalText; // 恢復原始文本
            timeTextElement.blur(); // 取消編輯
        }
    }

    /**
     * 添加一個新的項目到播放列表並更新顯示
     */
    async function addToPlaylist() {
        const newItem = await createPlaylistItem();
        playlistState.playlistItems.push(newItem);
        ul.appendChild(newItem);
        playlistContainer.appendChild(ul);
        playlistState.state = getandUpdatePlaylistState(playlistState);
    }

    /**
     * 創建一個新的播放列表項目元素，包含拖拽處理和時間顯示
     * @returns {HTMLElement} 一個代表播放列表項目的新元素
     */
    async function createPlaylistItem() {
        const newItem = document.createElement('li');
        newItem.classList.add('ytj-playlist-item');

        const dragHandle = document.createElement('div');
        dragHandle.classList.add('ytj-drag-handle');
        dragHandle.draggable = true;
        dragHandle.addEventListener('dragstart', mouseEventHandler.handleDragStart);

        const startTimeText = createTimeTextElement('start');
        const endTimeText = createTimeTextElement('end');
        const setStartTimeButton = createSetStartTimeButton();
        const setEndTimeButton = createSetEndTimeButton();
        const deleteButton = createDeleteButton(newItem);
        const titleInput = createTitleInput();
        const startFromHereButton = await createStartFromHereButton(newItem); // 新增的按鈕

        newItem.appendChild(dragHandle);
        newItem.appendChild(startFromHereButton);
        newItem.appendChild(startTimeText);
        newItem.appendChild(endTimeText);
        newItem.appendChild(titleInput);
        newItem.appendChild(setStartTimeButton);
        newItem.appendChild(setEndTimeButton);
        newItem.appendChild(deleteButton);

        return newItem;
    }

    async function createPlaylistItemFromData(startTime, endTime, title) {
        const timeObj = playlistTimeManager.checkStartAndEnd(startTime, endTime);
        startTime = timeObj.start;
        endTime = timeObj.end;

        const newItem = document.createElement('li');
        newItem.classList.add('ytj-playlist-item');

        const dragHandle = document.createElement('div');
        dragHandle.classList.add('ytj-drag-handle');
        dragHandle.draggable = true;
        dragHandle.addEventListener('dragstart', mouseEventHandler.handleDragStart);

        const startTimeText = document.createElement('div');
        startTimeText.classList.add('ytj-playlist-item-text-start');
        startTimeText.innerText = startTime.toformatString();
        startTimeText.setAttribute('timeat', startTime.getTotalseconds());
        startTimeText.contentEditable = false;

        const endTimeText = document.createElement('div');
        endTimeText.classList.add('ytj-playlist-item-text-end');
        endTimeText.innerText = endTime.toformatString();
        endTimeText.setAttribute('timeat', endTime.getTotalseconds());
        endTimeText.contentEditable = false;

        const setStartTimeButton = createSetStartTimeButton();
        const setEndTimeButton = createSetEndTimeButton();
        const deleteButton = createDeleteButton(newItem);
        const titleInput = createTitleInput();
        titleInput.value = title || '';
        const startFromHereButton = await createStartFromHereButton(newItem);

        newItem.appendChild(dragHandle);
        newItem.appendChild(startFromHereButton);
        newItem.appendChild(startTimeText);
        newItem.appendChild(endTimeText);
        newItem.appendChild(titleInput);
        newItem.appendChild(setStartTimeButton);
        newItem.appendChild(setEndTimeButton);
        newItem.appendChild(deleteButton);

        return newItem;
    }

    function createSetStartTimeButton() {
        const button = document.createElement('button');
        button.classList.add('ytj-set-start-time');
        button.addEventListener('click', (event) => {
            const listItem = event.target.closest('.ytj-playlist-item');
            const startTimeText = listItem.querySelector('.ytj-playlist-item-text-start');
            const originalTime = Number(startTimeText.getAttribute('timeat'));
            const timeObj = getCurrentVideoTime();
            if (timeObj) {
                startTimeText.innerText = timeObj.toformatString();
                startTimeText.setAttribute('timeat', timeObj.getTotalseconds().toString());
                playlistTimeManager.updateTimeText(startTimeText, originalTime);
                playlistState.state = getandUpdatePlaylistState(playlistState);
            }
        });
        return button;
    }

    function createSetEndTimeButton() {
        const button = document.createElement('button');
        button.classList.add('ytj-set-end-time');
        button.addEventListener('click', (event) => {
            const listItem = event.target.closest('.ytj-playlist-item');
            const endTimeText = listItem.querySelector('.ytj-playlist-item-text-end');
            const originalTime = Number(endTimeText.getAttribute('timeat'));
            const timeObj = getCurrentVideoTime();
            if (timeObj) {
                endTimeText.innerText = timeObj.toformatString();
                endTimeText.setAttribute('timeat', timeObj.getTotalseconds().toString());
                playlistTimeManager.updateTimeText(endTimeText, originalTime);
                playlistState.state = getandUpdatePlaylistState(playlistState);
            }
        });
        return button;
    }

    function createDeleteButton(listItem) {
        const button = document.createElement('button');
        button.classList.add('ytj-delete-item');
        button.addEventListener('click', () => {
            playlistTimeManager.deletePlaylistItem(listItem)
            playlistState.state = getandUpdatePlaylistState(playlistState);
        });
        return button;
    }

    function createTitleInput() {
        const input = document.createElement('input');
        input.type = 'text';
        input.classList.add('ytj-playlist-item-title');
        input.placeholder = '';
        input.addEventListener('blur', () => {
            playlistState.state = getandUpdatePlaylistState(playlistState);
        });
        return input;
    }

    async function playPlaylist(startIndex = 0) {
        await chrome.runtime.sendMessage({ action: 'playPlaylist', startIndex: startIndex, videoId: getCurrentVideoId() });
    }


    /**
    * 將文本解析並添加到播放列表的函數
    */
    async function importPlaylistFromText() {
        createPopupTextBox('Import Playlist', async (text) => {
            if (!text) return;

            const lines = text.split('\n');
            const regex = /(\d{1,2}:\d{2}(?::\d{2})?)\s*(\d{1,2}:\d{2}(?::\d{2})?)?\s*(.*)/;

            for (const line of lines) {
                const match = line.match(regex);
                if (match) {
                    const [, startTime, endTime, title] = match;
                    const start = TimeSlot.fromString(startTime);
                    const end = endTime ? TimeSlot.fromString(endTime) : start;
                    const newItem = await createPlaylistItemFromData(start, end, title);
                    playlistState.playlistItems.push(newItem);
                    ul.appendChild(newItem);
                }
            }
            playlistContainer.appendChild(ul);
            playlistState.state = getandUpdatePlaylistState(playlistState);
        });
    }

    /**
     * 將播放列表匯出為文本的函數
     */
    function exportPlaylist() {
        const items = playlistState.playlistItems.map(item => {
            const start = item.querySelector('.ytj-playlist-item-text-start').innerText;
            const end = item.querySelector('.ytj-playlist-item-text-end').innerText;
            const title = item.querySelector('.ytj-playlist-item-title').value;
            return `${start} ${end !== start ? end : ''} ${title}`.trim();
        });
        const text = items.join('\n');
        createPopupTextBox('Export Playlist', () => { }).querySelector('textarea').value = text;
    }
})();
