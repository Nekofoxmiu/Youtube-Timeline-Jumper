'use strict';
console.info('yt-paj content.js injected');
(async () => {
    // 模組內容
    class TimeSlot {
        constructor(hours, minutes, seconds) {
            this.hours = hours;
            this.minutes = minutes;
            this.seconds = seconds;
        }
        gethours() {
            return this.hours;
        }
        getminutes() {
            return this.minutes;
        }
        getseconds() {
            return this.seconds;
        }
        getTotalseconds() {
            return this.hours * 3600 + this.minutes * 60 + this.seconds;
        }
        sethours(hours) {
            this.hours = hours;
        }
        setminutes(minutes) {
            this.minutes = minutes;
        }
        setseconds(seconds) {
            this.seconds = seconds;
        }
        setByTotalseconds(Totalseconds) {
            this.hours = Math.floor(Totalseconds / 3600);
            this.minutes = Math.floor((Totalseconds % 3600) / 60);
            this.seconds = Totalseconds % 60;
        }
        toformatString() {
            return `${this.hours.toString().padStart(2, '0')}:${this.minutes.toString().padStart(2, '0')}:${this.seconds.toString().padStart(2, '0')}`;
        }
        toformatObject() {
            return { hours: this.hours, minutes: this.minutes, seconds: this.seconds };
        }
        standardization(originalTimeObj) {
            if (!originalTimeObj) {
                originalTimeObj = { hours: 0, minutes: 0, seconds: 0 };
            }
            if (this.seconds >= 60) {
                this.minutes += Math.floor(this.seconds / 60);
                this.seconds %= 60;
            }
            if (this.minutes >= 60) {
                this.hours += Math.floor(this.minutes / 60);
                this.minutes %= 60;
            }
            const isValidTime = this.hours >= 0 && this.minutes >= 0 && this.seconds >= 0 && this.minutes < 60 && this.seconds < 60;
            if (!isValidTime) {
                this.hours = originalTimeObj.hours;
                this.minutes = originalTimeObj.minutes;
                this.seconds = originalTimeObj.seconds;
            }
            return this;
        }
        static fromObject(obj) {
            return new TimeSlot(obj.hours, obj.minutes, obj.seconds);
        }


        static fromString(timeString) {
            const parts = timeString.split(':').reverse();
            const seconds = parseInt(parts[0]) || 0;
            const minutes = parseInt(parts[1]) || 0;
            const hours = parseInt(parts[2]) || 0;
            return TimeSlot.fromTotalseconds(hours * 3600 + minutes * 60 + seconds);
        }
        static fromTotalseconds(Totalseconds) {
            return new TimeSlot(Math.floor(Totalseconds / 3600), Math.floor((Totalseconds % 3600) / 60), Totalseconds % 60);
        }
    }

    class PlaylistItem {
        constructor(start, end, title = '') {
            this.start = new TimeSlot(start.hours, start.minutes, start.seconds);
            this.end = new TimeSlot(end.hours, end.minutes, end.seconds);
            this.title = title;
        }
        getStartTimeObj() {
            return this.start;
        }
        getEndTimeObj() {
            return this.end;
        }
        setStartTimeObj(start) {
            this.start = start;
        }
        setEndTimeObj(end) {
            this.end = end;
        }
        getStartTimeString() {
            return this.start.toformatString();
        }
        getEndTimeString() {
            return this.end.toformatString();
        }
        setStartTimeByString(start) {
            this.start = TimeSlot.fromString(start);
        }
        setEndTimeByString(end) {
            this.end = TimeSlot.fromString(end);
        }
        getTitle() {
            return this.title;
        }
        setTitle(title) {
            this.title = title;
        }
        toString() {
            return `${this.getStartTimeString()} ~ ${this.getEndTimeString()} (Title: ${this.title})`;
        }
        toObject() {
            return { start: this.start, end: this.end, title: this.title };
        }
        static fromObject(obj) {
            return new PlaylistItem(obj.start, obj.end, obj.title);
        }
    }

    class PlaylistState {
        constructor() {
            this.playlistItems = [];
            this.state = [];
        }

        getPlaylistItems() {
            return this.playlistItems;
        }

        getState() {
            return this.state;
        }

        setPlaylistItems(items) {
            this.playlistItems = items;
        }

        setState(state) {
            this.state = state;
        }

        addPlaylistItem(item) {
            this.playlistItems.push(item);
        }

        removePlaylistItem(index) {
            this.playlistItems.splice(index, 1);
        }

        clearPlaylistItems() {
            this.playlistItems = [];
        }

        clearState() {
            this.state = [];
        }

        clearAll() {
            this.clearPlaylistItems();
            this.clearState();
        }

        getPlaylistItem(index) {
            return this.playlistItems[index];
        }

        updatePlaylistItem(index, item) {
            this.playlistItems[index] = item;
        }

        getPlaylistItemLength() {
            return this.playlistItems.length;
        }

        getPlaylistState() {
            return this.state;
        }

        setPlaylistState(state) {
            this.state = state;
        }

        addPlaylistState(item) {
            this.state.push(item);
        }

        removePlaylistState(index) {
            this.state.splice(index, 1);
        }

        clearPlaylistState() {
            this.state = [];
        }

        getPlaylistStateItem(index) {
            return this.state[index];
        }

        updatePlaylistStateItem(index, item) {
            this.state[index] = item;
        }

        getPlaylistStateLength() {
            return this.state.length;
        }

        toString() {
            return this.playlistItems.map((item, index) => {
                return `Item ${index + 1}: ${item.toString()}`;
            }).join('\n');
        }

        toObject() {
            return { playlistItems: this.playlistItems, state: this.state };
        }
    }

    class PlaylistTimeManager {
        /**
        * Create a playlist item.
        * @param {HTMLElement} playlistContainer - The container element for the playlist.
        * @param {PlaylistState} sharedState - The seconds array to merge.
        */
        constructor(playlistContainer, sharedState) {
            this.playlistContainer = playlistContainer;
            this.sharedState = sharedState;
            // 其他需要的初始化代碼...
        }

        /**
        * 獲取視頻總長，並轉換為小時、分鐘和秒。
        * @returns {?{TimeSlot}} 包含時間信息的物件，或者如果沒有視頻元素則返回 null。
        */
        static getVideoDuration = () => {
            const video = document.querySelector('video');
            if (!video) return null;

            const videoDuration = TimeSlot.fromTotalseconds(Math.floor(video.duration));

            return videoDuration;
        };

        /**
        * 校驗並保證開始時間不晚於結束時間。
        * @param {TimeSlot} startObj - 開始時間物件，包含 hours、minutes 和 seconds 屬性。
        * @param {TimeSlot} endObj - 結束時間物件，包含 hours、minutes 和 seconds 屬性。
        * @returns {Object} 一個包含調整後的開始和結束時間的物件。
        */
        static checkStartAndEnd(startObj, endObj) {
            const startSeconds = startObj.getTotalseconds();
            const endseconds = endObj.getTotalseconds();
            const videoDuration = this.getVideoDuration();

            // 如果視頻時間可用，則將結束時間限制為視頻時間
            if (videoDuration) {
                const videoSeconds = videoDuration.getTotalseconds();
                if (startSeconds > videoSeconds) {
                    startObj.setByTotalseconds(videoSeconds);
                }
                if (endseconds > videoSeconds) {
                    endObj.setByTotalseconds(videoSeconds);
                }
            }

            // 如果開始時間晚於結束時間，則把結束時間變為開始時間
            if (startSeconds > endseconds) {
                endObj = startObj;
            }

            //console.log(startObj, endObj)

            return { start: startObj, end: endObj };
        }


        /**
         * 更新 DOM 元素中顯示的時間文本。這個元素應該有類 'ytj-playlist-item-text-start' 和 'ytj-playlist-item-text-end'。
         * @param {Element} itemText - 應該更新文本的 DOM 元素。
         * @param {number} originalTime - 原始時間秒數。
         * @throws Will throw an error if DOM operations fail or if time parsing fails.
         */
        updateTimeText(itemText, originalTime) {
            try {
                const start_item = itemText.parentNode.querySelector('.ytj-playlist-item-text-start');
                const end_item = itemText.parentNode.querySelector('.ytj-playlist-item-text-end');

                const inputTimeObj = TimeSlot.fromString(itemText.innerText);
                const originalTimeObj = TimeSlot.fromTotalseconds(originalTime);
                inputTimeObj.standardization(originalTimeObj);

                let startTimeObj, endTimeObj;
                if (itemText.classList.contains('ytj-playlist-item-text-end')) {
                    endTimeObj = inputTimeObj;
                    startTimeObj = TimeSlot.fromTotalseconds(Number(start_item.getAttribute('timeat')));
                } else {
                    startTimeObj = inputTimeObj;
                    endTimeObj = TimeSlot.fromTotalseconds(Number(end_item.getAttribute('timeat')));
                }

                let timeObj = PlaylistTimeManager.checkStartAndEnd(startTimeObj, endTimeObj);
                start_item.innerText = timeObj.start.toformatString();
                start_item.setAttribute('timeat', timeObj.start.getTotalseconds());
                end_item.innerText = timeObj.end.toformatString();
                end_item.setAttribute('timeat', timeObj.end.getTotalseconds());

                // 更新播放列表狀態並傳送資料
                this.sharedState.state = getandUpdatePlaylistState(this.sharedState);

            } catch (error) {
                console.error('Error updating time text:', error);
            }
        }

        deletePlaylistItem(item) {
            item.remove();
            //修改sharedState
            this.sharedState.playlistItems = Array.from(this.playlistContainer.querySelectorAll('.ytj-playlist-item'));
            this.sharedState.state = getandUpdatePlaylistState(this.sharedState);
        }
    }

    class MouseEventHandler {
        constructor(ul, playlistContainer, sharedState) {
            this.ul = ul;
            this.playlistContainer = playlistContainer;
            this.sharedState = sharedState;
            this.dragItem = null;
            this.dragImage = null;
            this.waitCountReset = 3;
            this.waitCount = this.waitCountReset;
        }

        createDragImage(dragItem) {
            const computedStyle = window.getComputedStyle(dragItem);
            const dragImage = dragItem.cloneNode(true);
            const dragHandle = dragImage.querySelector('.ytj-drag-handle');
            dragHandle.classList.replace('ytj-drag-handle', 'ytj-drag-handle-clicked');
            dragImage.classList.replace('ytj-playlist-item', 'ytj-display-dragging');
            Object.assign(dragImage.style, {
                position: 'absolute',
                top: '-16px',
                left: '-16px',
                width: computedStyle.width,
                height: computedStyle.height,
                zIndex: '1000',
                opacity: '0',
            });
            return dragImage;
        }

        handleDragStart(event) {
            const dragHandle = event.target.closest('.ytj-drag-handle');
            if (!dragHandle) return;
            const playlistItem = dragHandle.closest('.ytj-playlist-item');
            if (!playlistItem) return;
            event.preventDefault();
            this.initiateDrag(playlistItem, event);
        }

        initiateDrag(item, event) {
            this.dragItem = item;
            this.dragImage = this.createDragImage(item);
            document.body.appendChild(this.dragImage);
            this.updateDragImagePosition(event.pageX, event.pageY);
            item.classList.add('ytj-dragging');
            document.body.style.cursor = 'grabbing';
            document.addEventListener('mousemove', this.handleDragging.bind(this));
            document.addEventListener('mouseup', this.handleDragEnd.bind(this));
        }

        updateDragImagePosition(pageX, pageY) {
            if (this.dragImage) {
                this.dragImage.style.opacity = '1';
                this.dragImage.style.transform = `translate(${pageX}px, ${pageY}px)`;
            }
        }

        handleDragging(event) {
            requestAnimationFrame(() => {
                if (--this.waitCount <= 0) {
                    this.waitCount = this.waitCountReset;
                    const crossElement = this.getDragCrossElement('.ytj-playlist-item:not(.ytj-dragging)', event.clientY);
                    if (crossElement && this.dragItem) {
                        this.ul.insertBefore(this.dragItem, crossElement);
                    } else if (!crossElement && this.dragItem) {
                        this.ul.appendChild(this.dragItem);
                    }
                }
            });
            this.updateDragImagePosition(event.pageX, event.pageY);
        }


        getDragCrossElement(selector, y) {
            const draggableElements = [...this.ul.querySelectorAll(selector)];
            return draggableElements.reduce((closest, child) => {
                const box = child.getBoundingClientRect();
                const offset = y - box.top - box.height / 2;
                if (offset < 0 && offset > closest.offset) {
                    return { offset, element: child };
                } else {
                    return closest;
                }
            }, { offset: Number.NEGATIVE_INFINITY }).element;
        }

        handleDragEnd() {
            document.removeEventListener('mousemove', this.handleDragging);
            document.removeEventListener('mouseup', this.handleDragEnd);
            if (this.dragImage) {
                this.dragImage.remove();
            }
            this.finalizeDrag();
        }

        finalizeDrag() {
            if (this.dragItem) {
                this.dragItem.classList.remove('ytj-dragging');
            }
            document.body.style.cursor = 'default';
            this.dragItem = null;
            this.dragImage = null;
            this.waitCount = this.waitCountReset;
            this.updatePlaylistState();
        }

        updatePlaylistState() {
            this.sharedState.playlistItems = Array.from(this.ul.querySelectorAll('.ytj-playlist-item'));
            this.sharedState.state = getandUpdatePlaylistState(this.sharedState);
        }
    }

    const equalsCheck = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    const getandUpdatePlaylistState = (sharedState) => {
        const nowPlaylistState = sharedState.playlistItems.map(
            item => {
                const startTime = TimeSlot.fromTotalseconds(Number(item.querySelector('.ytj-playlist-item-text-start').getAttribute('timeat')));
                const endTime = TimeSlot.fromTotalseconds(Number(item.querySelector('.ytj-playlist-item-text-end').getAttribute('timeat')));
                const title = item.querySelector('.ytj-playlist-item-title').value || '';
                return new PlaylistItem(startTime, endTime, title);
            });

        if (!equalsCheck(sharedState.state, nowPlaylistState)) {
            console.debug('Playlist State:', nowPlaylistState);
            sendPlaylistStateToBackground(nowPlaylistState);
        }
        return nowPlaylistState;
    };

    async function stopCurrentPlayback() {
        console.debug('Stopping current playback');
        const video = document.querySelector('video');
        if (video) video.pause();
    
        const playButton = document.querySelector('.ytj-play-playlist');
        if (playButton) playButton.classList.remove('playing'); // 恢復播放按鈕樣式
    
        const playingItems = document.querySelectorAll('.ytj-playing-item');
        playingItems.forEach(item => {
            item.classList.remove('ytj-playing-item');
            const dragHandle = item.querySelector('.ytj-drag-handle');
            if (dragHandle) dragHandle.classList.remove('playing');
        });
        console.debug('Playback stopped');
    }
    
    async function updateStyles(item, add) {
        console.debug(`Updating styles for item: ${item}, add: ${add}`);
        if (add) {
            item.classList.add('ytj-playing-item');
            item.querySelector('.ytj-drag-handle').classList.add('playing');
        } else {
            item.classList.remove('ytj-playing-item');
            item.querySelector('.ytj-drag-handle').classList.remove('playing');
        }
        console.debug('Styles updated');
    }
    

    async function stopCurrentPlayback() {
        console.debug('Stopping current playback');
        const video = document.querySelector('video');
        if (video) video.pause();

        const playButton = document.querySelector('.ytj-play-playlist');
        if (playButton) playButton.classList.remove('playing'); // 恢復播放按鈕樣式

        const playingItems = document.querySelectorAll('.ytj-playing-item');
        playingItems.forEach(item => {
            item.classList.remove('ytj-playing-item');
            const dragHandle = item.querySelector('.ytj-drag-handle');
            if (dragHandle) dragHandle.classList.remove('playing');
        });
        console.debug('Playback stopped');
    }

    async function playPlaylist(startIndex, sendResponse, tabId) {
        console.debug(`Starting playlist from index: ${startIndex}, tabId: ${tabId}`);
        let { [`currentPlayId_${tabId}`]: currentPlayId } = await chrome.storage.local.get(`currentPlayId_${tabId}`);
        console.debug(currentPlayId);
        if (typeof currentPlayId === 'undefined') {
            currentPlayId = 0;
        }
        currentPlayId++;
        await chrome.storage.local.set({ [`currentPlayId_${tabId}`]: currentPlayId });
        let { [`currentPlayId_${tabId}`]: setPlayId } = (await chrome.storage.local.get(`currentPlayId_${tabId}`))[`currentPlayId_${tabId}`];
        console.debug(`Set new currentPlayId: ${setPlayId}`);

        const thisPlayId = currentPlayId;

        try {
            const { [`isPlaying_${tabId}`]: isPlaying } = await chrome.storage.local.get(`isPlaying_${tabId}`);
            console.debug(`Retrieved isPlaying: ${isPlaying}`);

            // 停止當前播放
            if (isPlaying) {
                await stopCurrentPlayback();
                await chrome.storage.local.set({ [`isPlaying_${tabId}`]: false });
                console.debug('Stopped current playback and updated isPlaying to false');
            }

            await chrome.storage.local.set({ [`isPlaying_${tabId}`]: true });
            console.debug('Set isPlaying to true');

            const playlistContainer = document.querySelector('.ytj-playlist-container');
            const video = document.querySelector('video');
            const playButton = document.querySelector('.ytj-play-playlist');
            if (!playlistContainer || !video || !playButton) return;
            console.debug('Playlist container, video, and play button are present');

            const playlistState = playlistContainer.querySelectorAll('.ytj-playlist-item');
            if (!playButton.classList.contains('playing')) {
                playButton.classList.add('playing'); // 播放按鈕變為暫停按鈕
                console.debug('Play button set to playing');
            }

            for (let i = startIndex; i < playlistState.length; i++) {
                const currentPlayId = (await chrome.storage.local.get(`currentPlayId_${tabId}`))[`currentPlayId_${tabId}`];
                console.debug(`Loop iteration ${i}, currentPlayId: ${currentPlayId}, thisPlayId: ${thisPlayId}`);
                if (thisPlayId !== currentPlayId) break;

                const item = playlistState[i];
                const startTime = parseInt(item.querySelector('.ytj-playlist-item-text-start').getAttribute('timeat'));
                const endTime = parseInt(item.querySelector('.ytj-playlist-item-text-end').getAttribute('timeat'));
                console.debug(`Item ${i} startTime: ${startTime}, endTime: ${endTime}`);

                video.currentTime = startTime;
                await video.play();
                console.debug(`Video started playing from ${startTime}`);

                await updateStyles(item, true);

                await new Promise((resolve) => {
                    const checkTime = setInterval(async () => {
                        const currentPlayId = (await chrome.storage.local.get(`currentPlayId_${tabId}`))[`currentPlayId_${tabId}`];
                        if (thisPlayId !== currentPlayId || video.currentTime >= endTime) {
                            clearInterval(checkTime);
                            resolve();
                        }
                    }, 100);
                });

                await updateStyles(item, false);
                console.debug(`Finished playing item ${i}`);
            }

            const currentPlayId = (await chrome.storage.local.get(`currentPlayId_${tabId}`))[`currentPlayId_${tabId}`];
            console.debug(`Playback loop completed, currentPlayId: ${currentPlayId}, thisPlayId: ${thisPlayId}`);
            if (thisPlayId === currentPlayId) {
                playButton.classList.remove('playing'); // 播放按鈕恢復為播放按鈕
                video.pause();
                await chrome.storage.local.set({ [`currentPlayId_${tabId}`]: 0 });
                console.debug('Playback ended, reset play button and currentPlayId');
            }
            await chrome.storage.local.set({ [`isPlaying_${tabId}`]: false });
            console.debug('Set isPlaying to false');

        } catch (error) {
            console.error('Error playing playlist:', error);
        }

        try {
            const currentPlayId = (await chrome.storage.local.get(`currentPlayId_${tabId}`))[`currentPlayId_${tabId}`];
            console.debug(`Final check currentPlayId: ${currentPlayId}, thisPlayId: ${thisPlayId}`);
            if (thisPlayId === currentPlayId) {
                await chrome.storage.local.set({ [`isPlaying_${tabId}`]: false }); // 確保播放結束後的狀態更新
                console.debug('Ensured isPlaying is set to false at the end');
            }
            sendResponse({ success: true });
        } catch (error) {
            console.error('Error executing script:', error);
        }
    }

    function enableEditMode(editableElement, playlistState, playlistTimeManager) {
        const originalText = editableElement.innerText || editableElement.value;
        const originalAttr = editableElement.getAttribute('timeat') || originalText;

        if (editableElement.tagName === 'INPUT') {
            editableElement.readOnly = false;
            editableElement.focus();
        } else {
            editableElement.contentEditable = 'true';
            editableElement.focus();
        }

        // 設置失去焦點事件處理
        editableElement.addEventListener('blur', () => handleBlur(editableElement, originalAttr, playlistState, playlistTimeManager), { once: true });

        // 設置鍵盤事件，以支持保存和取消
        editableElement.addEventListener('keydown', (event) => handleKeydown(event, editableElement, originalText));
    }

    function handleBlur(editableElement, originalAttr, playlistState, playlistTimeManager) {
        if (editableElement.tagName === 'INPUT') {
            editableElement.readOnly = true;
        } else {
            editableElement.contentEditable = 'false';
            if (editableElement.classList.contains('ytj-playlist-item-text-start') || editableElement.classList.contains('ytj-playlist-item-text-end')) {
                playlistTimeManager.updateTimeText(editableElement, Number(originalAttr));
            }
        }
        playlistState.state = getandUpdatePlaylistState(playlistState);
    }

    function handleKeydown(event, editableElement, originalText) {
        event.stopPropagation(); // 防止事件冒泡
        if (event.key === 'Enter') {
            event.preventDefault(); // 防止 Enter 鍵的默認行為
            editableElement.blur(); // 觸發失去焦點事件來保存
        } else if (event.key === 'Escape') {
            if (editableElement.tagName === 'INPUT') {
                editableElement.value = originalText; // 恢復原始文本
            } else {
                editableElement.innerText = originalText; // 恢復原始文本
            }
            editableElement.blur(); // 取消編輯
        }
    }

    function getCurrentVideoId() {
        const videoUrl = window.location.href;
        const url = new URL(videoUrl);
        const urlParams = new URLSearchParams(url.search);

        // 檢查標準網址格式
        let videoId = urlParams.get('v');
        if (videoId) {
            return videoId;
        }

        // 檢查短網址格式
        const pathnameParts = url.pathname.split('/');
        if (url.hostname === 'youtu.be' && pathnameParts.length > 1) {
            return pathnameParts[1];
        }

        // 檢查嵌入式影片網址格式
        if (url.hostname === 'www.youtube.com' && pathnameParts[1] === 'embed' && pathnameParts.length > 2) {
            return pathnameParts[2];
        }

        return null;
    }

    function getCurrentVideoTime() {
        const video = document.querySelector('video');
        if (!video) return null;
        return TimeSlot.fromTotalseconds(Math.floor(video.currentTime));
    }

    function isYouTubeDarkTheme() {
        var element = document.querySelector('ytd-app');
        if (!element) return false;
        var styles = getComputedStyle(element);
        var value = styles.getPropertyValue('--yt-spec-base-background').trim();
        return value === '#0f0f0f';
    }

    function applyTheme() {
        if (isYouTubeDarkTheme()) {
            document.body.classList.add('dark-theme');
            document.body.classList.remove('light-theme');
        } else {
            document.body.classList.add('light-theme');
            document.body.classList.remove('dark-theme');
        }
    }

    function sendPlaylistStateToBackground(nowPlaylistState) {
        const videoId = getCurrentVideoId();
        if (!videoId) {
            console.debug('No video ID found.');
            return;
        }
    
        const playlistData = {
            videoId: videoId,
            state: nowPlaylistState
        };
    
        chrome.runtime.sendMessage({ action: 'updatePlaylistState', data: playlistData }, response => {
            if (response && response.success) {
                console.debug('Playlist state updated successfully.');
            } else {
                console.debug('Failed to update playlist state.');
            }
        });
    }

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
    async function handleRuntimeMessage(request, sender, sendResponse, context) {
        try {
            let { deleteAppElement, main, sidebarQuery, appPlayListContainerQuery, document } = context;
            let { extensionWorkOrNot } = await chrome.storage.sync.get('extensionWorkOrNot');
            let sidebarElm = document.querySelector(sidebarQuery);

            console.info('runtimeHandler.js:', request);
            if (request.action === 'switchExtensionOnState') {
                extensionWorkOrNot = !extensionWorkOrNot;
                await chrome.storage.sync.set({ extensionWorkOrNot: extensionWorkOrNot }, () => {
                    console.info('Extension state saved:', extensionWorkOrNot);
                });

                if (extensionWorkOrNot) {
                    console.info('yt-tj start.');
                    sendResponse({ appstart: 'yt-tj start.' });
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
                } else {
                    sendResponse({ appstop: 'yt-tj stop.' });
                    console.info('yt-tj stop.');
                    await deleteAppElement();
                }
            }
            if (request.action === 'initializePlaylist') {
                if (extensionWorkOrNot) {
                    console.info('Initializing playlist...');
                    sendResponse({ initialize: 'success' });
                    if (sidebarElm) {
                        main(sidebarElm);
                    } else {
                        // loop for wait sidebarElm
                        let loopCount = 0;
                        const loop = setInterval(() => {
                            loopCount++;
                            if (document.querySelector(appPlayListContainerQuery)) {
                                clearInterval(loop);
                            } else if (loopCount > 100) {
                                clearInterval(loop);
                            } else {
                                sidebarElm = document.querySelector(sidebarQuery);
                                if (sidebarElm) {
                                    main(sidebarElm);
                                }
                            }
                        }, 100);
                    }
                } else {
                    sendResponse({ initialize: 'app-not-start' });
                }
            }
            if (request.action === 'playPlaylist') {
                const tabId = request.tabId; // 獲取傳入的 tab ID
                console.info('Playing playlist...');
                await playPlaylist(request.startIndex, sendResponse, tabId);
            }
        } catch (error) {
            console.error('Error handling runtime message:', error);
        }
    }

    function createPlaylistContainer(videoId) {
        const container = document.createElement('div');
        container.id = 'ytj-playlist-container';
        container.className = 'ytj-playlist-container';
        container.setAttribute('youtubeID', videoId);
        return container;
    }

    function createButtonContainer() {
        const container = document.createElement('div');
        container.id = 'ytj-button-container';
        container.className = 'ytj-button-container';
        return container;
    }

    function createImportExportContainer() {
        const container = document.createElement('div');
        container.id = 'ytj-importexport-container';
        container.className = 'ytj-importexport-container';
        return container;
    }

    function createPlaylistItemsContainer() {
        const ul = document.createElement('ul');
        ul.id = 'ytj-playlist-items';
        return ul;
    }

    function createTimeTextElements(startTime = null, endTime = null) {
        let startObj, endObj;

        if (startTime !== null) {
            const startAndEndTimeObj = PlaylistTimeManager.checkStartAndEnd(startTime, endTime);
            startObj = startAndEndTimeObj['start'];
            endObj = startAndEndTimeObj['end'];
        } else {
            startObj = getCurrentVideoTime();
            endObj = getCurrentVideoTime();
        }

        if (!startObj || !endObj) {
            console.error('No video element found.');
            return null;
        }

        const startItemText = document.createElement('div');
        startItemText.classList.add('ytj-playlist-item-text-start');
        startItemText.innerText = startObj.toformatString();
        startItemText.setAttribute('timeat', startObj.getTotalseconds().toString());
        startItemText.contentEditable = false;

        const endItemText = document.createElement('div');
        endItemText.classList.add('ytj-playlist-item-text-end');
        endItemText.innerText = endObj.toformatString();
        endItemText.setAttribute('timeat', endObj.getTotalseconds().toString());
        endItemText.contentEditable = false;

        return {
            startElement: startItemText,
            endElement: endItemText
        };
    }

    function createAddToPlaylistButton() {
        const button = document.createElement('button');
        button.id = 'ytj-add-to-playlist';
        button.className = 'ytj-add-to-playlist';
        return button;
    }

    function createImportPlaylistButton(importPlaylistFromText) {
        const button = document.createElement('button');
        button.id = 'ytj-import-playlist-text';
        button.className = 'ytj-import-playlist-text';
        button.innerText = 'Import Playlist';
        button.addEventListener('click', importPlaylistFromText);
        return button;
    }

    function createExportPlaylistButton(exportPlaylist) {
        const button = document.createElement('button');
        button.id = 'ytj-export-playlist';
        button.className = 'ytj-export-playlist';
        button.innerText = 'Export Playlist';
        button.addEventListener('click', exportPlaylist);
        return button;
    }

    function createPlayButton() {
        const button = document.createElement('button');
        button.id = 'ytj-play-playlist';
        button.className = 'ytj-play-playlist';
        return button;
    }

    function createPopupTextBox(title, onSave) {
        const overlay = document.createElement('div');
        overlay.className = 'ytj-overlay';

        const popup = document.createElement('div');
        popup.className = 'ytj-popup';

        const popupTitle = document.createElement('h2');
        popupTitle.innerText = title;

        const textArea = document.createElement('textarea');
        textArea.className = 'ytj-popup-textarea';

        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'ytj-popup-button-container';

        const saveButton = document.createElement('button');
        saveButton.innerText = 'Save';
        saveButton.addEventListener('click', () => {
            onSave(textArea.value);
            document.body.removeChild(overlay);
        });

        const cancelButton = document.createElement('button');
        cancelButton.innerText = 'Cancel';
        cancelButton.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });

        buttonContainer.appendChild(saveButton);
        buttonContainer.appendChild(cancelButton);
        popup.appendChild(popupTitle);
        popup.appendChild(textArea);
        popup.appendChild(buttonContainer);
        overlay.appendChild(popup);
        document.body.appendChild(overlay);

        return overlay;
    }

    async function appstart() {
        let sidebarElm = document.querySelector(sidebarQuery);
        if (sidebarElm) {
            main(sidebarElm);
        } else {
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

    const response = await chrome.runtime.sendMessage({ action: 'getExtensionWorkOrNot' });
    console.info('getExtensionWorkOrNot:', response);
    let extensionWorkOrNot = response.state || false;
    if (extensionWorkOrNot) {
        appstart();
    }

    const observer = new MutationObserver(() => {
        applyTheme();
    });
    const ytdApp = document.querySelector('ytd-app');
    if (ytdApp) {
        observer.observe(ytdApp, { attributes: true, attributeFilter: ['style'] });
    }

    applyTheme();

    function createStartFromHereButton(listItem) {
        const button = document.createElement('button');
        button.classList.add('ytj-start-from-here');
        button.addEventListener('click', async () => {
            try {
                const video = document.querySelector('video');
                if (!video) return;
                const index = Array.from(playlistState.playlistItems).indexOf(listItem);

                if (playButton.classList.contains('playing')) {
                    const styleModificationPromise = new Promise(resolve => {
                        document.querySelectorAll('.ytj-playing-item').forEach(item => item.classList.remove('ytj-playing-item'));
                        document.querySelectorAll('.ytj-drag-handle.playing').forEach(handle => handle.classList.remove('playing'));
                        resolve();
                    });
                    styleModificationPromises.push(styleModificationPromise);
                    await styleModificationPromise;
                }

                await Promise.all(styleModificationPromises);
                styleModificationPromises.length = 0;
                await sendPlayPlaylist(index);
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

        playlistContainer.innerHTML = '';
        ul.innerHTML = '';

        playlistContainer = createPlaylistContainer(getCurrentVideoId());
        buttonContainer = createButtonContainer();
        importexportContainer = createImportExportContainer();
        addToPlaylistButton = createAddToPlaylistButton();
        playButton = createPlayButton();
        importPlaylistButton = createImportPlaylistButton(importPlaylistFromText);
        exportPlaylistButton = createExportPlaylistButton(exportPlaylist);
        ul = createPlaylistItemsContainer();

        mouseEventHandler = new MouseEventHandler(ul, playlistContainer, playlistState);
        playlistTimeManager = new PlaylistTimeManager(playlistContainer, playlistState);
    }

    async function main(sidebarElm) {
        const appPlayListContainer = document.querySelector(appPlayListContainerQuery);
        if (appPlayListContainer) {
            if (appPlayListContainer.getAttribute('youtubeID') !== getCurrentVideoId()) {
                await deleteAppElement();
            } else {
                return;
            }
        }

        initializePlaylist(sidebarElm);
    }

    async function initializePlaylist(sidebarElm) {
        const videoId = getCurrentVideoId();
        if (!videoId) {
            console.debug('No video ID found for initialization.');
            return;
        }

        await chrome.storage.sync.get([videoId], async (result) => {
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
            }
        });

        importexportContainer.appendChild(importPlaylistButton);
        importexportContainer.appendChild(exportPlaylistButton);
        sidebarElm.insertBefore(importexportContainer, sidebarElm.firstChild);

        sidebarElm.insertBefore(playlistContainer, sidebarElm.firstChild);

        buttonContainer.appendChild(addToPlaylistButton);
        buttonContainer.appendChild(playButton);
        sidebarElm.insertBefore(buttonContainer, sidebarElm.firstChild);

        ul.addEventListener('mousedown', handleMouseDown);
        playlistContainer.addEventListener('click', handleClick);
        addToPlaylistButton.addEventListener('click', await addToPlaylist);

        playButton.addEventListener('click', async () => {
            if (!playButton.classList.contains('playing')) {
                await Promise.all(styleModificationPromises);
                styleModificationPromises.length = 0;
                await sendPlayPlaylist();
            } else {
                const video = document.querySelector('video');
                if (video) {
                    if (playButton.classList.contains('playing')) {
                        const styleModificationPromise = new Promise(resolve => {
                            document.querySelectorAll('.ytj-playing-item').forEach(item => item.classList.remove('ytj-playing-item'));
                            document.querySelectorAll('.ytj-drag-handle.playing').forEach(handle => handle.classList.remove('playing'));
                            resolve();
                        });
                        styleModificationPromises.push(styleModificationPromise);
                        await styleModificationPromise;
                    }

                    await Promise.all(styleModificationPromises);
                    styleModificationPromises.length = 0;
                    playButton.classList.remove('playing');
                    video.pause();
                    await chrome.storage.local.set({ currentPlayId: 0 });
                }
            }
        });

        const importButton = document.querySelector('#ytj-import-playlist-text');
        const exportButton = document.querySelector('#ytj-export-playlist');
        if (importButton) importButton.addEventListener('click', importPlaylistFromText);
        if (exportButton) exportButton.addEventListener('click', exportPlaylist);
    }

    function handleMouseDown(event) {
        const dragHandle = event.target.closest('.ytj-drag-handle');
        if (dragHandle) {
            mouseEventHandler.handleDragStart(event);
        }
    }

    function handleClick(event) {
        const editableElement = event.target.closest('.ytj-playlist-item-text-start, .ytj-playlist-item-text-end, .ytj-playlist-item-title');

        if (editableElement) {
            if (editableElement.contentEditable === 'true' || editableElement.readOnly === false) return;

            enableEditMode(editableElement, playlistState, playlistTimeManager);
        }
    }

    async function addToPlaylist() {
        const newItem = createPlaylistItem();
        playlistState.playlistItems.push(newItem);
        ul.appendChild(newItem);
        playlistContainer.appendChild(ul);
        playlistState.state = getandUpdatePlaylistState(playlistState);
    }

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

        const startFromHereButton = createStartFromHereButton(newItem);

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
        input.readOnly = true;
        return input;
    }

    async function sendPlayPlaylist(startIndex = 0) {
        await chrome.runtime.sendMessage({ action: 'playPlaylist', startIndex: startIndex, videoId: getCurrentVideoId() });
    }

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
                    const newItem = createPlaylistItem(start, end, title);
                    playlistState.playlistItems.push(newItem);
                    ul.appendChild(newItem);
                }
            }
            playlistContainer.appendChild(ul);
            playlistState.state = getandUpdatePlaylistState(playlistState);
        });
    }

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