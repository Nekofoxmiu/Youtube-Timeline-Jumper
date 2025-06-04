import { TimeSlot, PlaylistState, PlaylistItem } from './dataclass.js';
import { sendPlaylistStateToBackground } from './sendPlaylistStateToBackground.js';


export class PlaylistTimeManager {
    /**
    * Create a playlist item.
    * @param {HTMLElement} playlistContainer - The container element for the playlist.
    * @param {PlaylistState} sharedState - The seconds array to merge.
    */
    constructor(playlistContainer, sharedState, stateManager) {
        this.playlistContainer = playlistContainer;
        this.sharedState = sharedState;
        this.stateManager = stateManager;
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
    async updateTimeText(itemText, originalTime) {
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
            if (this.stateManager) {
                await this.stateManager.updateState(this.sharedState.state);
            }

        } catch (error) {
            console.error('Error updating time text:', error);
        }
    }

    async deletePlaylistItem(item) {
        item.remove();
        //修改sharedState
        this.sharedState.playlistItems = Array.from(this.playlistContainer.querySelectorAll('.ytj-playlist-item'));
        this.sharedState.state = getandUpdatePlaylistState(this.sharedState);
        if (this.stateManager) {
            await this.stateManager.updateState(this.sharedState.state);
        }
    }

    async deleteAllPlaylistItems() {
        Array.from(this.playlistContainer.querySelectorAll('.ytj-playlist-item')).map(item => item.remove());
        //修改sharedState
        this.sharedState.playlistItems = [];
        this.sharedState.state = getandUpdatePlaylistState(this.sharedState);
        if (this.stateManager) {
            await this.stateManager.updateState(this.sharedState.state);
        }
    }
}

/**
    * Check if two objects are equal.
    * @param {Object} a - The first object.
    * @param {Object} b - The seconds object.
    * @returns {boolean} True if the objects are equal, false otherwise.
    */
export const equalsCheck = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Extract playlist state from DOM elements.
 * @param {HTMLElement[]} playlistItems - The list item elements.
 * @returns {PlaylistItem[]} The extracted state array.
 */
export const extractPlaylistState = (playlistItems) => {
    return Array.from(playlistItems).map(item => {
        const startTime = TimeSlot.fromTotalseconds(
            Number(item.querySelector('.ytj-playlist-item-text-start').getAttribute('timeat'))
        );
        const endTime = TimeSlot.fromTotalseconds(
            Number(item.querySelector('.ytj-playlist-item-text-end').getAttribute('timeat'))
        );
        const title = item.querySelector('.ytj-playlist-item-title').value || '';
        return new PlaylistItem(startTime, endTime, title);
    });
};

/**
 * Get and update the playlist state.
 * @param {PlaylistState} sharedState - The shared state object.
 * @returns {PlaylistState} The updated playlist state.
 */
export const getandUpdatePlaylistState = (sharedState) => {
    const nowPlaylistState = extractPlaylistState(sharedState.playlistItems);

    if (!equalsCheck(sharedState.state, nowPlaylistState)) {
        console.debug('Playlist State:', nowPlaylistState);
        sendPlaylistStateToBackground(nowPlaylistState);
    }
    return nowPlaylistState;
};



