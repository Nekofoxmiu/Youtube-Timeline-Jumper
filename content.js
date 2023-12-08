'use strict';

console.log('yt-paj content.js injected');

// 定義拖動項目和播放列表項目
//let dragItem;
//let dragImage;
//let playlistItems = [];
//let lastPlaylistState = [];

// 建立播放列表容器
const playlistContainer = document.createElement('div');
playlistContainer.id = 'playlist-container';
playlistContainer.className = 'playlist-container';

// 建立添加到播放列表的按鈕
const addToPlaylistButton = document.createElement('button');
addToPlaylistButton.id = 'add-to-playlist';
addToPlaylistButton.className = 'add-to-playlist';

const ul = document.createElement('ul');
ul.id = 'playlist-items';


//一個集成撥放列表的類
class TimeSlot {
    constructor(start, end) {
        this.start = start;
        this.end = end;
    }
    getStartTime() {
        return this.start;
    }
    getEndTime() {
        return this.end;
    }
    setStartTime(start) {
        this.start = start;
    }
    setEndTime(end) {
        this.end = end;
    }
    toString() {
        return this.start + " ~ " + this.end;
    }
    toObject() {
        return { start: this.start, end: this.end };
    }
    static fromObject(obj) {
        return new TimeSlot(obj.start, obj.end);
    }
}

class PlaylistState {
    constructor() {
        this.playlistItems = [];
        this.lastPlaylistState = [];
        // 其他共享狀態...
    }
}

const playlistState = new PlaylistState();

class PlaylistCheckTool {
    /**
    * Merges two arrays into an array of objects with 'start' and 'end' properties.
    * @param {HTMLDivElement} playlistContainer - The first array to merge.
    * @param {PlaylistState} sharedState - The second array to merge.
    */
    constructor(playlistContainer, sharedState) {
        this.playlistContainer = playlistContainer;
        this.sharedState = sharedState;
        // 其他需要的初始化代碼...
    }
    /**
    * Check if two objects are equal.
    * @param {Object} a - The first object.
    * @param {Object} b - The second object.
    * @returns {boolean} True if the objects are equal, false otherwise.
    */
    equalsCheck = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    /**
    * Merges two arrays into an array of objects with 'start' and 'end' properties.
    * @param {Array} arr1 - The first array to merge.
    * @param {Array} arr2 - The second array to merge.
    * @throws Will throw an error if either argument is not an array or if they do not have the same length.
    * @returns {Array<Object>} An array of objects with 'start' from arr1 and 'end' from arr2.
    */
    mergeArraysToObjects = (arr1, arr2) => {
        if (!Array.isArray(arr1)) {
            throw new Error('First input must be an array');
        }
        if (!Array.isArray(arr2)) {
            throw new Error('Second input must be an array');
        }
        if (arr1.length !== arr2.length) {
            throw new Error('Input arrays must have the same length');
        }

        return arr1.map((start, index) => ({ start, end: arr2[index] }));
    };

    // 定義輸出播放列表狀態至控制台的函數
    logPlaylistState = () => {
        const playlistStartState = this.sharedState.playlistItems.map(item => item.querySelector('.playlist-item-text-start').innerText);
        const playlistEndState = this.sharedState.playlistItems.map(item => item.querySelector('.playlist-item-text-end').innerText);
        const playlistState = this.mergeArraysToObjects(playlistStartState, playlistEndState);
        console.log(playlistState);
        console.log(this.sharedState.lastPlaylistState);
        if (!this.equalsCheck(this.sharedState.lastPlaylistState, playlistState)) {
            console.log('Playlist State:', playlistState);
        }
        return playlistState;
    };
};

const playlistCheckTool = new PlaylistCheckTool(playlistContainer, playlistState);

class PlaylistTimeManager extends PlaylistCheckTool {
    /**
    * Create a playlist item.
    * @param {HTMLElement} playlistContainer - The container element for the playlist.
    */
    constructor(playlistContainer, sharedState) {
        super(playlistContainer, sharedState);
        this.playlistContainer = playlistContainer;
        // 其他需要的初始化代碼...
    }

    /**
    * 格式化時間物件為 HH:MM:SS 字符串。
    * @param {Object} timeObj 包含時間的對象
    * @param {number} timeObj.hours 小時數
    * @param {number} timeObj.minutes 分鐘數
    * @param {number} timeObj.seconds 秒數
    * @returns {string} 格式化後的時間字串
    */
    formatTime({ hours, minutes, seconds }) {
        hours = hours || 0;
        minutes = minutes || 0;
        seconds = seconds || 0;
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    /**
    * 解析時間字符串為時間物件。
    * @param {string} timeString - 格式為 "HH:MM:SS" 的時間字符串。
    * @returns {{hours: number, minutes: number, seconds: number}} - 包含小時、分鐘和秒的時間物件。
    */
    parseTime(timeString) {
        if (typeof timeString !== 'string') {
            throw new Error('Input must be a string');
        }
        const [hours, minutes, seconds] = timeString.split(':').map((num) => {
            const parsedNum = Number(num);
            return Number.isNaN(parsedNum) ? 0 : parsedNum;
        });
        return { hours, minutes, seconds };
    }

    /**
    * 驗證和標準化時間物件。如果時間不合法，則返回原始時間物件。
    * @param {Object} timeObj - 包含時間的對象。
    * @param {number} timeObj.hours - 小時數。
    * @param {number} timeObj.minutes - 分鐘數。
    * @param {number} timeObj.seconds - 秒數。
    * @param {Object} originalTimeObj - 原始時間物件，用於在無效時返回。
    * @returns {Object} 標準化的時間物件或原始時間物件。
    */
    validateTime(timeObj, originalTimeObj) {
        let { hours, minutes, seconds } = timeObj;
        // 標準化秒
        if (seconds >= 60) {
            minutes += Math.floor(seconds / 60);
            seconds %= 60;
        }
        // 標準化分鐘
        if (minutes >= 60) {
            hours += Math.floor(minutes / 60);
            minutes %= 60;
        }
        // 驗證時間的有效性
        const isValidTime = hours >= 0 && minutes >= 0 && seconds >= 0 && minutes < 60 && seconds < 60;
        return isValidTime ? { hours, minutes, seconds } : originalTimeObj;
    }

    /**
    * 校驗並保證開始時間不晚於結束時間。
    * @param {Object} startObj - 開始時間物件，包含 hours、minutes 和 seconds 屬性。
    * @param {Object} endObj - 結束時間物件，包含 hours、minutes 和 seconds 屬性。
    * @returns {Object} 一個包含調整後的開始和結束時間的物件。
    */
    checkStartAndEnd(startObj, endObj) {
        const timeToSeconds = time => time.hours * 3600 + time.minutes * 60 + time.seconds;
        const startSeconds = timeToSeconds(startObj);
        const endSeconds = timeToSeconds(endObj);
        if (startSeconds > endSeconds) {
            return { start: startObj, end: startObj };
        }
        return { start: startObj, end: endObj };
    }

    /**
    * 創建一個顯示特定時間的 DOM 元素。
    * @param {Object} timeObj - 包含時間的對象。
    * @param {number} timeObj.hours - 小時數。
    * @param {number} timeObj.minutes - 分鐘數。
    * @param {number} timeObj.seconds - 秒數。
    * @returns {Element} 一個設置了時間文本和類別的 DOM 元素。
    */
    /**
    * 更新 DOM 元素中顯示的時間文本。這個元素應該有類 'playlist-item-text-start' 和 'playlist-item-text-end'。
    * @param {Element} itemText - 應該更新文本的 DOM 元素。
    * @param {string} originalText - 原始時間文本，格式應該為 "HH:MM:SS"。
    * @throws Will throw an error if DOM operations fail or if time parsing fails.
    */
    updateTimeText(itemText, originalText) {
        try {
            const originalTimeObj = this.parseTime(originalText);
            const inputTimeObj = this.parseTime(itemText.innerText);

            let startTimeObj, endTimeObj;
            //檢查修改哪個
            if (itemText.classList.contains('playlist-item-text-end')) {
                const startTimeText = itemText.parentNode.querySelector('.playlist-item-text-start').innerText;
                startTimeObj = this.parseTime(startTimeText);
                endTimeObj = this.validateTime(inputTimeObj, originalTimeObj);
            } else {
                startTimeObj = this.validateTime(inputTimeObj, originalTimeObj);
                const endTimeText = itemText.parentNode.querySelector('.playlist-item-text-end').innerText;
                endTimeObj = this.parseTime(endTimeText);
            }

            let timeObj = this.checkStartAndEnd(startTimeObj, endTimeObj);
            itemText.parentNode.querySelector('.playlist-item-text-start').innerText = this.formatTime(timeObj.start);
            itemText.parentNode.querySelector('.playlist-item-text-end').innerText = this.formatTime(timeObj.end);
        } catch (error) {
            console.error('Error updating time text:', error);
        }
    }
}

/*
        let drag_handle = document.querySelector('#drag-handle');
        const handlerStyle = drag_handle.getBoundingClientRect();
        const handlerWidth = handlerStyle.width;
        const handlerHeight = handlerStyle.height;
        */
class MouseEventHandler extends PlaylistCheckTool {
    /**
    * Create a playlist item.
    * @param {HTMLElement} playlistContainer - The container element for the playlist.
    * @param {PlaylistState} sharedState - The shared state object.
    */
    constructor(playlistContainer, sharedState) {
        super(playlistContainer, sharedState);
        this.playlistContainer = playlistContainer;
        this.frame = null;
        this.dragItem = null;
        this.dragImage = null;
        // 其他需要的初始化代碼...
    }

    createDragImage = (dragItem, event) => {
        const computedStyle = window.getComputedStyle(dragItem);
        const computedWidth = computedStyle.width;
        const computedHeight = computedStyle.height;

        const dragImage = dragItem.cloneNode(true);
        const dragHandle = dragImage.querySelector('.drag-handle');
        dragHandle.classList.remove('drag-handle');
        dragHandle.classList.add('drag-handle-clicked');
        dragImage.classList.remove('playlist-item');
        dragImage.classList.add('display-dragging');
        dragImage.style.position = 'absolute';
        dragImage.style.top = `${event.pageY}px`;
        dragImage.style.left = `${event.pageX}px`;
        dragImage.style.zIndex = '1000';
        dragImage.style.width = computedWidth;
        dragImage.style.height = computedHeight;

        return dragImage;
    };

    // 定義獲取拖放位置的函數
    getDragAfterElement = (ul, querySelector, y) => {
        const draggableElements = [...ul.querySelectorAll(querySelector)];

        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height * (2 / 3);

            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    };

    /**
    * 初始化拖曳過程。
    * @param {HTMLElement} item - 要拖曳的播放列表項目。
    * @param {MouseEvent} event - 觸發拖曳的事件對象。
    */
    handleDragStart = (event) => {
        const dragHandle = event.target.closest('.drag-handle');
        if (!dragHandle) return;

        const playlistItem = dragHandle.closest('.playlist-item');
        // 避免對非 playlist-item 元素進行操作
        if (!playlistItem) {
            return;
        }
        event.preventDefault();

        this.dragItem = playlistItem; // 設置拖動項目的參考
        // 創建拖曳縮略圖元素
        this.dragImage = this.createDragImage(this.dragItem, event);
        document.body.appendChild(this.dragImage);
        this.dragItem.classList.add('dragging');

        // 添加移動和放開的事件監聽器
        document.addEventListener('mousemove', this.handleDragging);
        document.addEventListener('mouseup', this.handleDragEnd);
    };

    /**
     * 處理拖動過程中的事件。
     * @param {MouseEvent} event - 觸發拖動事件的事件對象。
     */
    handleDragging = (event) => {
        if (!this.dragImage) {
            console.error('拖曳圖像未找到。');
            return;
        }

        // 更新拖曳縮略圖的位置
        this.dragImage.style.top = `${event.pageY}px`;
        this.dragImage.style.left = `${event.pageX}px`;

        const movingY = event.clientY;
        const ul = this.playlistContainer.querySelector('ul');
        const afterElement = this.getDragAfterElement(ul, '.playlist-item:not(.dragging)', movingY);

        // 進行 DOM 操作前確保有改變再操作，避免不必要的性能消耗
        if (afterElement == null && this.dragItem.parentNode !== this.ul) {
            ul.appendChild(this.dragItem);
        } else if (afterElement && this.dragItem.nextSibling !== afterElement) {
            ul.insertBefore(this.dragItem, afterElement);
        }

    };

    // 定義處理拖動結束的函數
    handleDragEnd = () => {
        // 移除滑鼠事件的監聽器
        document.removeEventListener('mousemove', this.handleDragging);
        document.removeEventListener('mouseup', this.handleDragEnd);

        if (this.dragImage) {
            this.dragImage.remove(); // 移除拖曳縮略圖
            this.dragImage = null;
        }

        this.dragItem.classList.remove('dragging');
        this.dragItem = null; // 清除拖動項目的參考
        this.sharedState.playlistItems = Array.from(this.playlistContainer.querySelectorAll('.playlist-item'));
        this.sharedState.lastPlaylistState = this.logPlaylistState(); // 更新播放列表狀態
    }

}


const mouseEventHandler = new MouseEventHandler(playlistContainer, playlistState);
const playlistTimeManager = new PlaylistTimeManager(playlistContainer, playlistState);

/**
 * 獲取當前視頻播放時間，並轉換為小時、分鐘和秒。
 * @returns {?{hours: number, minutes: number, seconds: number, allSeconds: number}} 包含時間信息的物件，或者如果沒有視頻元素則返回 null。
 */
const getCurrentVideoTime = () => {
    const video = document.querySelector('video');
    if (!video) return null;

    const unparsedSeconds = Math.floor(video.currentTime);
    const hours = Math.floor(unparsedSeconds / 3600);
    const minutes = Math.floor((unparsedSeconds % 3600) / 60);
    const seconds = unparsedSeconds % 60;

    return { hours, minutes, seconds, allSeconds: unparsedSeconds };
};

/**
* 創建一個時間文本元素，用於播放列表中顯示和編輯時間。
* @param {string} startOrEnd - 指示是創建開始時間還是結束時間的元素允許值'start','end'。
* @returns {HTMLElement|null} 返回一個時間文本的 DOM 元素，如果沒有視頻元素則返回 null。
*/
const createTimeTextElement = (startOrEnd) => {
    const timeObj = getCurrentVideoTime();
    if (!timeObj) {
        console.error('No video element found.');
        return null;
    }

    const itemText = document.createElement('div');
    itemText.classList.add(`playlist-item-text-${startOrEnd}`);
    itemText.innerText = playlistTimeManager.formatTime(timeObj);
    itemText.contentEditable = false;

    let originalText = itemText.innerText;

    // 定義事件處理函數來處理不同的用戶互動
    const enableEditMode = () => {
        itemText.contentEditable = true;
        itemText.focus();
    };

    const saveEdits = () => {
        itemText.contentEditable = false;
        playlistTimeManager.updateTimeText(itemText, originalText);
        originalText = itemText.innerText;
        playlistState.lastPlaylistState = playlistCheckTool.logPlaylistState();
    };

    const cancelEdits = () => {
        itemText.innerText = originalText;
        itemText.contentEditable = false;
    };

    // 事件監聽器
    itemText.addEventListener('click', enableEditMode);
    itemText.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === 'Escape') {
            event.preventDefault(); // 只有在需要時阻止默認行為
            event.stopPropagation();
            if (event.key === 'Enter') {
                saveEdits();
            } else if (event.key === 'Escape') {
                cancelEdits();
            }
        }
    });
    itemText.addEventListener('keyup', (event) => {
        event.stopPropagation();
    });
    itemText.addEventListener('blur', saveEdits);

    return itemText;
};

//初始化並與background.js進行綁定
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startExtension') {
        console.log("receive startExtension");
        sendResponse({ appstart: 'yt-tj start.' });
        //尋找sidebar 並開始主程式
        const sidebarQuery = '#related.style-scope.ytd-watch-flexy';
        const yttjQuery = '#playlist-container'
        const yttjContainer = document.querySelector(yttjQuery);
        const sidebarElm = document.querySelector(sidebarQuery);
        if (!yttjContainer && sidebarElm)
            main(sidebarElm);

    }
});

async function main(sidebarElm) {

    async function test(sidebarElm) {
        // 建立播放列表容器
        sidebarElm.insertBefore(playlistContainer, sidebarElm.firstChild);

        // 建立添加到播放列表的按鈕
        sidebarElm.insertBefore(addToPlaylistButton, sidebarElm.firstChild);

        // 使用事件委派來處理所有子項目的 mousedown 事件
        ul.addEventListener('mousedown', event => {
            const dragHandle = event.target.closest('.drag-handle');
            if (dragHandle) {
                mouseEventHandler.handleDragStart(event);
            }
        });

        /**
         * 重新渲染播放列表並設置事件委派以處理拖曳事件。
         */
        /*
        const reRenderPlaylist = () => {
            // 清空播放列表容器
            while (playlistContainer.firstChild) {
                playlistContainer.removeChild(playlistContainer.firstChild);
            }

            // 使用 DocumentFragment 來一次性添加所有項目
            const fragment = document.createDocumentFragment();
            playlistState.playlistItems.forEach(item => {
                fragment.appendChild(item);
            });

            ul.appendChild(fragment);
            playlistContainer.appendChild(ul);
        };
        */

        /**
        * 添加一個新的項目到播放列表並更新顯示。
        */
        const addToPlaylist = () => {
            const newItem = createPlaylistItem();
            playlistState.playlistItems.push(newItem);
            ul.appendChild(newItem);
            playlistContainer.appendChild(ul);
            playlistState.lastPlaylistState = playlistCheckTool.logPlaylistState();
        }
        // 監聽添加到播放列表按鈕的點擊事件
        addToPlaylistButton.addEventListener('click', addToPlaylist);

        /**
        * 創建一個新的播放列表項目元素，包含拖拽處理和時間顯示。
        * @returns {HTMLElement} 一個代表播放列表項目的新元素。
        */
        const createPlaylistItem = () => {
            const newItem = document.createElement('li');
            newItem.classList.add('playlist-item');

            const dragHandle = document.createElement('div');
            dragHandle.classList.add('drag-handle');
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

    }

    test(sidebarElm);
}