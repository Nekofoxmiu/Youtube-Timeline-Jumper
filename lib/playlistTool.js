let dataClassModule;
try {
    dataClassModule = await import('./dataclass.js');
}
catch (error) {
    console.error('Module loading failed:', error);
}
const TimeSlot = dataClassModule.TimeSlot;
const PlaylistItem = dataClassModule.PlaylistItem;
const PlaylistState = dataClassModule.PlaylistState;

export class PlaylistCheckTool {
    /**
    * Merges two arrays into an array of objects with 'start' and 'end' properties.
    * @param {HTMLDivElement} playlistContainer - The first array to merge.
    * @param {PlaylistState} sharedState - The seconds array to merge.
    */
    constructor(playlistContainer, sharedState) {
        this.playlistContainer = playlistContainer;
        this.sharedState = sharedState;
        // 其他需要的初始化代碼...
    }
    /**
    * Check if two objects are equal.
    * @param {Object} a - The first object.
    * @param {Object} b - The seconds object.
    * @returns {boolean} True if the objects are equal, false otherwise.
    */
    equalsCheck = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    /**
    * Merges two arrays into an array of objects with 'start' and 'end' properties.
    * @param {Array} arr1 - The first array to merge.
    * @param {Array} arr2 - The seconds array to merge.
    * @throws Will throw an error if either argument is not an array or if they do not have the same length.
    * @returns {Array<Object>} An array of objects with 'start' from arr1 and 'end' from arr2.
    */
   /*
    mergeArraysToObjects = (arr1, arr2) => {
        if (!Array.isArray(arr1)) {
            throw new Error('First input must be an array');
        }
        if (!Array.isArray(arr2)) {
            throw new Error('seconds input must be an array');
        }
        if (arr1.length !== arr2.length) {
            throw new Error('Input arrays must have the same length');
        }

        return arr1.map((start, index) => ({ start, end: arr2[index] }));
    };
    */
   
    // 定義輸出播放列表狀態至控制台的函數
    getandUpdatePlaylistState = () => {
        const nowPlaylistState = this.sharedState.playlistItems.map(
            item => {
                const startTime = TimeSlot.fromString(item.querySelector('.ytj-playlist-item-text-start').innerText);
                const endTime = TimeSlot.fromString(item.querySelector('.ytj-playlist-item-text-end').innerText);
                return new PlaylistItem(startTime, endTime);
            });
        
        //console.log(playlistState);
        //console.log(this.sharedState.state);
        if (!this.equalsCheck(this.sharedState.state, nowPlaylistState)) {
            console.log('Playlist State:', nowPlaylistState);
        }
        return nowPlaylistState;
    };
};


export class PlaylistTimeManager {
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
    * 獲取當前視頻播放時間，並轉換為小時、分鐘和秒。
    * @returns {?{hours: number, minutes: number, seconds: number, allseconds: number}} 包含時間信息的物件，或者如果沒有視頻元素則返回 null。
    */
    getVideoTime = () => {
        const video = document.querySelector('video');
        if (!video) return null;

        const unparsedseconds = Math.floor(video.duration);
        const hours = Math.floor(unparsedseconds / 3600);
        const minutes = Math.floor((unparsedseconds % 3600) / 60);
        const seconds = unparsedseconds % 60;

        return { hours, minutes, seconds, allseconds: unparsedseconds };
    };

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
        const timeToseconds = time => time.hours * 3600 + time.minutes * 60 + time.seconds;
        const startseconds = timeToseconds(startObj);
        const endseconds = timeToseconds(endObj);
        const videoTime = this.getVideoTime();

        // 如果視頻時間可用，則將結束時間限制為視頻時間
        if (videoTime) {
            const videoseconds = videoTime.allseconds;
            if (startseconds > videoseconds) {
                startObj.setByTotalseconds(videoseconds);
            }
            if (endseconds > videoseconds) {
                endObj.setByTotalseconds(videoseconds);
            }
        }

        // 如果開始時間晚於結束時間，則交換它們
        if (startseconds > endseconds) {
            const temp = startObj;
            startObj = endObj;
            endObj = temp;
        }

        //console.log(startObj, endObj)

        return { start: startObj, end: endObj };
    }

    // 定義輸出播放列表狀態至控制台的函數
    getandUpdatePlaylistState = () => {
        const nowPlaylistState = this.sharedState.playlistItems.map(
            item => {
                const startTime = TimeSlot.fromString(item.querySelector('.ytj-playlist-item-text-start').innerText);
                const endTime = TimeSlot.fromString(item.querySelector('.ytj-playlist-item-text-end').innerText);
                return new PlaylistItem(startTime, endTime);
            });

        //console.log(playlistState);
        //console.log(this.sharedState.state);
        if (!this.equalsCheck(this.sharedState.state, nowPlaylistState)) {
            console.log('Playlist State:', nowPlaylistState);
        }
        return nowPlaylistState;
    };

    /**
    * 創建一個顯示特定時間的 DOM 元素。
    * @param {Object} timeObj - 包含時間的對象。
    * @param {number} timeObj.hours - 小時數。
    * @param {number} timeObj.minutes - 分鐘數。
    * @param {number} timeObj.seconds - 秒數。
    * @returns {Element} 一個設置了時間文本和類別的 DOM 元素。
    */
    /**
    * 更新 DOM 元素中顯示的時間文本。這個元素應該有類 'ytj-playlist-item-text-start' 和 'ytj-playlist-item-text-end'。
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
            if (itemText.classList.contains('ytj-playlist-item-text-end')) {
                const startTimeText = itemText.parentNode.querySelector('.ytj-playlist-item-text-start').innerText;
                startTimeObj = TimeSlot.fromObject(this.parseTime(startTimeText));
                endTimeObj = TimeSlot.fromObject(this.validateTime(inputTimeObj, originalTimeObj));
            } else {
                startTimeObj = TimeSlot.fromObject(this.validateTime(inputTimeObj, originalTimeObj));
                const endTimeText = itemText.parentNode.querySelector('.ytj-playlist-item-text-end').innerText;
                endTimeObj = TimeSlot.fromObject(this.parseTime(endTimeText));
            }


            //console.log(startTimeObj, endTimeObj)
            let timeObj = this.checkStartAndEnd(startTimeObj, endTimeObj);
            itemText.parentNode.querySelector('.ytj-playlist-item-text-start').innerText = this.formatTime(timeObj.start);
            itemText.parentNode.querySelector('.ytj-playlist-item-text-end').innerText = this.formatTime(timeObj.end);
        } catch (error) {
            console.error('Error updating time text:', error);
        }
    }
}