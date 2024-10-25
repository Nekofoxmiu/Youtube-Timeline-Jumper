'use strict';
console.info('yt-paj content.js injected');

(async () => {
    // 模組變數
    let dataClassModule;
    let playlistToolModule;
    let mouseEventHandlerModule;
    let uiModule;
    let themeModule;
    let runtimeHandlerModule;
    let getVideoInfoModule;
    let editModule;

    try {
        dataClassModule = await import('./lib/dataclass.js');
        playlistToolModule = await import('./lib/playlistTool.js');
        mouseEventHandlerModule = await import('./lib/mouseEventHandler.js');
        uiModule = await import('./lib/ui.js');
        themeModule = await import('./lib/theme.js'); // 動態導入 theme 模組
        runtimeHandlerModule = await import('./lib/runtimeHandler.js'); // 動態導入 runtimeHandler 模組
        editModule = await import('./lib/editModule.js'); // 動態導入 editModule 模組
        getVideoInfoModule = await import('./lib/getVideoInfo.js');
    } catch (error) {
        console.error('Module loading failed:', error);
    }

    const { TimeSlot, PlaylistState } = dataClassModule;
    const { getandUpdatePlaylistState, PlaylistTimeManager } = playlistToolModule;
    const { MouseEventHandler } = mouseEventHandlerModule;
    const { createPlaylistContainer, createButtonContainer, createImportExportContainer, createAddToPlaylistButton, createImportPlaylistButton, createEditPlaylistButton, createExportPlaylistButton, createPlayButton, createPlaylistItemsContainer, createPopupTextBox, createTimeTextElements, createToggleSwitch } = uiModule;
    const { applyTheme } = themeModule;
    const { handleRuntimeMessage } = runtimeHandlerModule;
    const { getCurrentVideoId, getCurrentVideoTime } = getVideoInfoModule;
    const { enableEditMode } = editModule;

    // 共用變數
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
    editPlaylistButton = createEditPlaylistButton(editPlaylistFromText);
    exportPlaylistButton = createExportPlaylistButton(exportPlaylist);
    playButton = createPlayButton();
    toggleSwitch = createToggleSwitch();
    ul = createPlaylistItemsContainer();

    mouseEventHandler = new MouseEventHandler(ul, playlistContainer, playlistState);
    playlistTimeManager = new PlaylistTimeManager(playlistContainer, playlistState);

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
    const response = await chrome.runtime.sendMessage({ action: 'getExtensionWorkOrNot' });
    console.info('getExtensionWorkOrNot:', response);
    let extensionWorkOrNot = response.state || false;
    if (extensionWorkOrNot) {
        appstart();
    }

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
    function createStartFromHereButton(listItem) {
        const button = document.createElement('button');
        button.classList.add('ytj-start-from-here');
        button.addEventListener('click', async (event) => {
            try {
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

    async function deleteAppElement() {
        playlistState.clearAll();

        const oldPlaylistContainer = document.querySelector(appPlayListContainerQuery);
        const oldbuttonContainer = document.querySelector('#ytj-button-container');
        const oldimportexportContainer = document.querySelector('#ytj-importexport-container');
        const oldAddToPlaylistButton = document.querySelector('.ytj-add-to-playlist');
        const oldPlayButton = document.querySelector('.ytj-play-playlist');
        const oldImportPlaylistButton = document.querySelector('.ytj-import-playlist-text');
        const oldEditPlaylistButton = document.querySelector('.ytj-edit-playlist-text');
        const oldExportPlaylistButton = document.querySelector('.ytj-export-playlist');
        const oldUl = document.querySelector('.ytj-playlist-items');

        if (oldPlaylistContainer) oldPlaylistContainer.remove();
        if (oldbuttonContainer) oldbuttonContainer.remove();
        if (oldimportexportContainer) oldimportexportContainer.remove();
        if (oldAddToPlaylistButton) oldAddToPlaylistButton.remove();
        if (oldPlayButton) oldPlayButton.remove();
        if (oldImportPlaylistButton) oldImportPlaylistButton.remove();
        if (oldEditPlaylistButton) oldEditPlaylistButton.remove();
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
        toggleSwitch = createToggleSwitch();
        importPlaylistButton = createImportPlaylistButton(importPlaylistFromText);
        editPlaylistButton = createEditPlaylistButton(editPlaylistFromText);
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
            else {
                return;
            }

        }

        await initializePlaylist(sidebarElm);
    }

    /**
     * 初始化播放列表
     * @param {HTMLElement} sidebarElm - 側邊欄元素
     */
    async function initializePlaylist(sidebarElm) {
        // 將播放列表容器和按鈕插入側邊欄
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
                    const endTime = TimeSlot.fromObject(itemData.end);
                    const newItem = createPlaylistItem(startTime, endTime, itemData.title);
                    playlistState.playlistItems.push(newItem);
                    ul.appendChild(newItem);
                });
                playlistContainer.appendChild(ul);
                playlistState.state = savedState;
            }
        });

        importexportContainer.appendChild(importPlaylistButton);
        importexportContainer.appendChild(editPlaylistButton);
        importexportContainer.appendChild(exportPlaylistButton);
        sidebarElm.insertBefore(importexportContainer, sidebarElm.firstChild);

        sidebarElm.insertBefore(playlistContainer, sidebarElm.firstChild);

        buttonContainer.appendChild(addToPlaylistButton);
        buttonContainer.appendChild(playButton);
        buttonContainer.appendChild(toggleSwitch.element);
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
                await playPlaylist(0, playlistState.getPlaylistStateLength());
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
        const editableElement = event.target.closest('.ytj-playlist-item-text-start, .ytj-playlist-item-text-end, .ytj-playlist-item-title');

        if (editableElement) {
            if (editableElement.contentEditable === 'true' || editableElement.readOnly === false) return; // 如果已經是編輯模式，則不進行操作

            // 啟用編輯模式
            enableEditMode(editableElement, playlistState, playlistTimeManager);
        }
    }


    /**
     * 添加一個新的項目到播放列表並更新顯示
     */
    async function addToPlaylist() {
        const newItem = createPlaylistItem();
        playlistState.playlistItems.push(newItem);
        ul.appendChild(newItem);
        playlistContainer.appendChild(ul);
        playlistState.state = getandUpdatePlaylistState(playlistState);
    }

    /**
    * 創建一個新的播放列表項目元素，包含拖拽處理和時間顯示
    * @param {TimeSlot} [startTime] - 項目開始時間（可選）
    * @param {TimeSlot} [endTime] - 項目結束時間（可選）
    * @param {string} [title] - 項目標題（可選）
    * @returns {HTMLElement} 一個代表播放列表項目的新元素
    */
    function createPlaylistItem(startTime, endTime, title) {
        if (startTime !== undefined && endTime !== undefined) {
            const timeObj = PlaylistTimeManager.checkStartAndEnd(startTime, endTime);
            startTime = timeObj.start;
            endTime = timeObj.end;
        }

        const newItem = document.createElement('li');
        newItem.classList.add('ytj-playlist-item');

        const dragHandle = document.createElement('div');
        dragHandle.classList.add('ytj-drag-handle');
        dragHandle.draggable = true;
        dragHandle.addEventListener('dragstart', mouseEventHandler.handleDragStart);

        const TimeTextElements = createTimeTextElements(startTime, endTime);
        const startTimeText = TimeTextElements.startElement;
        const endTimeText = TimeTextElements.endElement;

        const setStartTimeButton = createSetStartTimeButton();
        const setEndTimeButton = createSetEndTimeButton();
        const deleteButton = createDeleteButton(newItem);
        const titleInput = createTitleInput();
        titleInput.value = title || '';

        const startFromHereButton = createStartFromHereButton(newItem); // 新增的按鈕

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
            try {
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
            } catch (error) {

            }
        });
        return button;
    }

    function createDeleteButton(listItem) {
        const button = document.createElement('button');
        button.classList.add('ytj-delete-item');
        button.addEventListener('click', () => {
            try {
                playlistTimeManager.deletePlaylistItem(listItem)
                playlistState.state = getandUpdatePlaylistState(playlistState);
            } catch (error) {
                console.debug('Error occurred while trying to delete playlist item:', error);
            }
        });
        return button;
    }

    function createTitleInput() {
        const input = document.createElement('input');
        input.type = 'text';
        input.classList.add('ytj-playlist-item-title', 'editable');
        input.placeholder = 'Title';
        input.readOnly = true; // 初始設置為只讀
        return input;
    }


    async function playPlaylist(startIndex = 0, endIndex = 0) {
        await chrome.runtime.sendMessage({ action: 'playPlaylist', startIndex: startIndex, endIndex: endIndex, videoId: getCurrentVideoId() });
    }

    /**
    * 將文本解析並添加到播放列表的函數
    */
    async function importPlaylistFromText() {
        createPopupTextBox('Import Playlist', async (text) => {
            if (!text) return;

            const lines = text.split('\n');
            const regex = /(\d{1,3}:\d{2}(?::\d{2})?)\s*(?:\D*\s*(\d{1,3}:\d{2}(?::\d{2})?))?\s*(.*)/;

            for (const line of lines) {
                const match = line.match(regex);
                if (match) {
                    const [, startTime, endTime, title] = match;
                    const start = TimeSlot.fromString(startTime);
                    const end = endTime ? TimeSlot.fromString(endTime) : start;
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
    * 將文本解析並編輯到播放列表的函數
    */
    async function editPlaylistFromText() {
        const items = playlistState.playlistItems.map(item => {
            const start = item.querySelector('.ytj-playlist-item-text-start').innerText;
            const end = item.querySelector('.ytj-playlist-item-text-end').innerText;
            const title = item.querySelector('.ytj-playlist-item-title').value;
            return `${start} ${end !== start ? end : ''} ${title}`.trim();
        });
        const originText = items.join('\n');

        createPopupTextBox('Edit Playlist', async (text) => {
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
                    const end = endTime ? TimeSlot.fromString(endTime) : start;
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