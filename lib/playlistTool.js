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
            // update metadata lastModified on DOM
            try {
                const listItem = itemText.closest('.ytj-playlist-item');
                if (listItem) {
                    const nowStr = new Date().toISOString();
                    listItem.dataset.lastModified = nowStr;
                    // persist playlist-level meta (update lastModified)
                    try {
                        if (this.stateManager && typeof this.stateManager.saveMeta === 'function') {
                            // load existing meta and update lastModified
                            (async () => {
                                const existingMeta = await this.stateManager.loadMeta() || {};
                                const newMeta = { ...(existingMeta || {}), lastModified: nowStr };
                                await this.stateManager.saveMeta(newMeta);
                            })();
                        }
                    } catch (e) {
                        // ignore meta save errors
                    }
                }
            } catch (e) {
                // ignore
            }
            this.sharedState.state = getandUpdatePlaylistState(this.sharedState);
            if (this.stateManager) {
                this.stateManager.setState(this.sharedState.state);
                this.stateManager.save();
            }

        } catch (error) {
            console.error('Error updating time text:', error);
        }
    }

    deletePlaylistItem(item) {
        item.remove();
        //修改sharedState
        this.sharedState.playlistItems = Array.from(this.playlistContainer.querySelectorAll('.ytj-playlist-item'));
        this.sharedState.state = getandUpdatePlaylistState(this.sharedState);
        if (this.stateManager) {
            this.stateManager.setState(this.sharedState.state);
            this.stateManager.save();
            // if playlist became empty, remove both items and meta keys
            (async () => {
                try {
                    if (!this.sharedState.playlistItems || this.sharedState.playlistItems.length === 0) {
                        const vid = this.stateManager.videoId || null;
                        if (vid) {
                            await chrome.storage.local.remove([`playlist_${vid}`, `playlist_meta_${vid}`]);
                        }
                    } else if (typeof this.stateManager.saveMeta === 'function') {
                        // update playlist-level meta from DOM datasets
                        const metaCandidates = this.sharedState.playlistItems.map(it => ({
                            lastModified: it.dataset?.lastModified || null,
                            uploadTime: it.dataset?.uploadTime || null
                        }));
                        const lmList = metaCandidates.map(m => m.lastModified).filter(Boolean).sort();
                        const utList = metaCandidates.map(m => m.uploadTime).filter(Boolean).sort();
                        const lastModified = lmList.length ? lmList.slice(-1)[0] : new Date().toISOString();
                        const uploadTime = utList.length ? utList[0] : new Date().toISOString();
                        const newMeta = { lastModified, uploadTime };
                        await this.stateManager.saveMeta(newMeta);
                    }
                } catch (e) {
                    // ignore
                }
            })();
        }
    }

    deleteAllPlaylistItems() {
        Array.from(this.playlistContainer.querySelectorAll('.ytj-playlist-item')).map(item => item.remove());
        //修改sharedState
        this.sharedState.playlistItems = [];
        this.sharedState.state = getandUpdatePlaylistState(this.sharedState);
        if (this.stateManager) {
            this.stateManager.setState(this.sharedState.state);
            this.stateManager.save();
            // playlist cleared -> remove meta as well
            (async () => {
                try {
                    const vid = this.stateManager.videoId || null;
                    if (vid) {
                        await chrome.storage.local.remove([`playlist_${vid}`, `playlist_meta_${vid}`]);
                    }
                } catch (e) {
                    // ignore
                }
            })();
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
 * Get and update the playlist state.
 * @param {PlaylistState} sharedState - The shared state object.
 * @returns {PlaylistState} The updated playlist state.
 */
export const getandUpdatePlaylistState = (sharedState) => {
    // Build items without metadata to avoid duplicating meta values in every item
    const nowPlaylistState = sharedState.playlistItems.map(item => {
        const startTime = TimeSlot.fromTotalseconds(Number(item.querySelector('.ytj-playlist-item-text-start').getAttribute('timeat')));
        const endTime = TimeSlot.fromTotalseconds(Number(item.querySelector('.ytj-playlist-item-text-end').getAttribute('timeat')));
        const title = item.querySelector('.ytj-playlist-item-title').value || '';
        return { start: startTime.toformatObject(), end: endTime.toformatObject(), title };
    });

    // compute playlist-level metadata from DOM dataset (not saved inside each item)
    let lastModified = null;
    let uploadTime = null;
    try {
        const metaCandidates = sharedState.playlistItems.map(it => ({
            lastModified: it.dataset?.lastModified || null,
            uploadTime: it.dataset?.uploadTime || null
        }));
        const lmList = metaCandidates.map(m => m.lastModified).filter(Boolean).sort();
        lastModified = lmList.length ? lmList.slice(-1)[0] : null;
        const utList = metaCandidates.map(m => m.uploadTime).filter(Boolean).sort();
        uploadTime = utList.length ? utList[0] : null;
    } catch (e) {
        // ignore
    }

    if (!equalsCheck(sharedState.state, nowPlaylistState)) {
        console.debug('Playlist State:', nowPlaylistState);
        // send items and meta separately
        const meta = { lastModified: lastModified || new Date().toISOString(), uploadTime: uploadTime || new Date().toISOString() };
        sendPlaylistStateToBackground(nowPlaylistState, meta);
    }
    return nowPlaylistState;
};



