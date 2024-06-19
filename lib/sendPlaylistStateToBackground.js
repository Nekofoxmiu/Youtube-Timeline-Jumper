import { PlaylistState } from './dataclass.js';
import { getCurrentVideoId } from './getVideoInfo.js';
/**
 * 將播放列表狀態傳送到 background.js 進行紀錄。
 * @param {PlaylistState} nowPlaylistState - 現在狀態的播放列表。
 */
export function sendPlaylistStateToBackground(nowPlaylistState) {
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
