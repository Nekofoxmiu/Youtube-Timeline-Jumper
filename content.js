'use strict';
console.log('yt-paj content.js injected');

// 異步加載模組
(async () => {
    let dataClassModule;
    let playlistToolModule;
    let mouseEventHandlerModule;

    try {
        dataClassModule = await import('./lib/dataclass.js');
        playlistToolModule = await import('./lib/playlistTool.js');
        mouseEventHandlerModule = await import('./lib/mouseEventHandler.js');
    } catch (error) {
        console.error('Module loading failed:', error);
    }

    // 從模組中提取所需的類和方法
    const { TimeSlot, PlaylistItem, PlaylistState } = dataClassModule;
    const { getandUpdatePlaylistState, PlaylistTimeManager } = playlistToolModule;
    const { MouseEventHandler } = mouseEventHandlerModule;

    // 建立播放列表容器
    const playlistContainer = createPlaylistContainer();
    const addToPlaylistButton = createAddToPlaylistButton();
    const ul = createPlaylistItemsContainer();

    const playlistState = new PlaylistState();
    const mouseEventHandler = new MouseEventHandler(ul, playlistContainer, playlistState);
    const playlistTimeManager = new PlaylistTimeManager(playlistContainer, playlistState);

    // 初始化並與 background.js 綁定
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    /**
     * 建立播放列表容器的函數
     * @returns {HTMLElement} 播放列表容器
     */
    function createPlaylistContainer() {
        const container = document.createElement('div');
        container.id = 'playlist-container';
        container.className = 'playlist-container';
        return container;
    }

    /**
     * 建立添加到播放列表按鈕的函數
     * @returns {HTMLElement} 按鈕元素
     */
    function createAddToPlaylistButton() {
        const button = document.createElement('button');
        button.id = 'add-to-playlist';
        button.className = 'add-to-playlist';
        return button;
    }

    /**
     * 建立播放列表內組件的容器
     * @returns {HTMLElement} 播放列表項目容器
     */
    function createPlaylistItemsContainer() {
        const ul = document.createElement('ul');
        ul.id = 'ytj-playlist-items';
        return ul;
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
    * 獲取當前 YouTube 影片 ID。
    * @returns {string|null} 影片 ID 或 null。
    */
    function getCurrentVideoId() {
        const videoUrl = window.location.href;
        const urlParams = new URLSearchParams((new URL(videoUrl)).search);
        return urlParams.get('v');
    }


    /**
     * 創建一個時間文本元素，用於播放列表中顯示和編輯時間。
     * @param {string} startOrEnd - 指示是創建開始時間還是結束時間的元素允許值 'start', 'end'。
     * @returns {HTMLElement|null} 返回一個時間文本的 DOM 元素，如果沒有視頻元素則返回 null。
     */
    function createTimeTextElement(startOrEnd) {
        const timeObj = getCurrentVideoTime();
        if (!timeObj) {
            console.error('No video element found.');
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
     * 處理接收到的 runtime 訊息
     * @param {Object} request - 訊息請求物件
     * @param {Object} sender - 發送訊息的發件人
     * @param {function} sendResponse - 回應訊息的函數
     */
    function handleRuntimeMessage(request, sender, sendResponse) {
        if (request.action === 'startExtension') {
            console.log("receive startExtension");
            sendResponse({ appstart: 'yt-tj start.' });
            const sidebarQuery = '#related.style-scope.ytd-watch-flexy';
            const sidebarElm = document.querySelector(sidebarQuery);
            if (!document.querySelector('#playlist-container') && sidebarElm) {
                main(sidebarElm);
            }
        }
    }


    /**
     * 主程式入口
     * @param {HTMLElement} sidebarElm - 側邊欄元素
     */
    async function main(sidebarElm) {
        initializePlaylist(sidebarElm);
    }

    /**
     * 初始化播放列表
     * @param {HTMLElement} sidebarElm - 側邊欄元素
     */
    async function initializePlaylist(sidebarElm) {
        // 將播放列表容器和按鈕插入側邊欄
        sidebarElm.insertBefore(playlistContainer, sidebarElm.firstChild);
        sidebarElm.insertBefore(addToPlaylistButton, sidebarElm.firstChild);

        // 使用事件委派來處理所有子項目的 mousedown 事件
        ul.addEventListener('mousedown', handleMouseDown);

        // 使用事件委派來處理所有子項目的點擊、編輯和保存邏輯
        playlistContainer.addEventListener('click', handleClick);

        // 監聽添加到播放列表按鈕的點擊事件
        addToPlaylistButton.addEventListener('click', addToPlaylist);
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
    function addToPlaylist() {
        const newItem = createPlaylistItem();
        playlistState.playlistItems.push(newItem);
        ul.appendChild(newItem);
        playlistContainer.appendChild(ul);
        playlistState.state = getandUpdatePlaylistState(playlistState);
    }

    /**
     * 創建一個新的播放列表項目元素，包含拖拽處理和時間顯示
     * @returns {HTMLElement} 一個代表播放列表項目的新元素
     */
    function createPlaylistItem() {
        const newItem = document.createElement('li');
        newItem.classList.add('ytj-playlist-item');

        const dragHandle = document.createElement('div');
        dragHandle.classList.add('ytj-drag-handle');
        dragHandle.draggable = true;
        dragHandle.addEventListener('dragstart', mouseEventHandler.handleDragStart);

        // 添加時間標籤，用於顯示和編輯開始和結束時間
        const startTimeText = createTimeTextElement('start');
        const endTimeText = createTimeTextElement('end');

        newItem.appendChild(dragHandle);
        newItem.appendChild(startTimeText);
        newItem.appendChild(endTimeText);

        return newItem;
    }

})();
