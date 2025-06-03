/**
 * 取得 `chrome.storage.local` 的值
 * @param {string} key 存儲的 key
 * @returns {Promise<any>} 該 key 的值
 */
async function getStorageValue(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
}

/**
 * 設定 `chrome.storage.local` 的值
 * @param {string} key 存儲的 key
 * @param {any} value 需要設定的值
 */
async function setStorageValue(key, value) {
    await chrome.storage.local.set({ [key]: value });
}

async function stopCurrentPlayback(tabId) {
    console.debug('Stopping current playback');
    const video = document.querySelector('video');
    if (video) video.pause();

    const playButton = document.querySelector('.ytj-play-playlist');
    if (playButton) playButton.classList.remove('playing'); // 恢復播放按鈕樣式

    document.querySelectorAll('.ytj-playing-item').forEach(item => {
        item.classList.remove('ytj-playing-item');
        item.querySelector('.ytj-drag-handle')?.classList.remove('playing');
    });

    // 重置 currentPlayId，讓播放迴圈能夠中斷
    await setStorageValue(`currentPlayId_${tabId}`, 0);
    console.debug(`[stopCurrentPlayback] currentPlayId 已重置`);
}

/**
 * 更新播放樣式
 * @param {Element} item 需要更新的播放項目
 * @param {boolean} add 是否加入播放樣式
 */
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

/**
 * 播放播放清單
 * @param {number} startIndex 開始索引
 * @param {number} endIndex 結束索引
 * @param {Function} sendResponse 回應函數
 * @param {number} tabId Chrome 分頁 ID
 */
export async function playPlaylist(startIndex, endIndex, sendResponse, tabId) {
    console.debug(`Starting playlist from index: ${startIndex}, to ${endIndex}, tabId: ${tabId}`);

    let currentPlayId = await getStorageValue(`currentPlayId_${tabId}`) || 0;
    currentPlayId++;

    await setStorageValue(`currentPlayId_${tabId}`, currentPlayId);
    const thisPlayId = currentPlayId;

    console.debug(`[playPlaylist] 設定 currentPlayId: ${thisPlayId}`);

    try {
        const isPlaying = await getStorageValue(`isPlaying_${tabId}`);

        // 停止當前播放
        if (isPlaying) {
            await stopCurrentPlayback(tabId);
            await setStorageValue(`isPlaying_${tabId}`, false);
            console.debug('Stopped current playback and updated isPlaying to false');
        }

        await setStorageValue(`isPlaying_${tabId}`, true);
        console.debug('Set isPlaying to true');

        const playlistContainer = document.querySelector('.ytj-playlist-container');
        const video = document.querySelector('video');
        const playButton = document.querySelector('.ytj-play-playlist');

        if (!playlistContainer || !video || !playButton) return;
        console.debug('Playlist container, video, and play button are present');

        const playlistItems  = playlistContainer.querySelectorAll('.ytj-playlist-item');
        
        playButton.classList.add('playing');

        for (const [index, item] of playlistItems.entries()) {
            if (index < startIndex || index >= endIndex) continue;

            let currentId = await getStorageValue(`currentPlayId_${tabId}`);
            console.debug(`[playPlaylist] 檢查播放 ID, index: ${index}, currentId: ${currentId}, thisPlayId: ${thisPlayId}`);

            if (thisPlayId !== currentId) break;

            const startTime = parseInt(item.querySelector('.ytj-playlist-item-text-start').getAttribute('timeat'));
            const endTime = parseInt(item.querySelector('.ytj-playlist-item-text-end').getAttribute('timeat'));
            console.debug(`Item ${item} startTime: ${startTime}, endTime: ${endTime}`);

            video.currentTime = startTime;
            await video.play();
            console.debug(`Video started playing from ${startTime}`);

            await updateStyles(item, true);

            await new Promise(resolve => {
                const checkTime = setInterval(async () => {
                    let currentId = await getStorageValue(`currentPlayId_${tabId}`);
                    if (thisPlayId !== currentId || video.currentTime >= endTime) {
                        clearInterval(checkTime);
                        resolve();
                    }
                }, 100);
            });

            if (thisPlayId !== currentId) break;
            await updateStyles(item, false);
            console.debug(`Finished playing item ${item}`);
        }

        let finalPlayId = await getStorageValue(`currentPlayId_${tabId}`);
        console.debug(`Playback loop completed, currentPlayId: ${currentPlayId}, thisPlayId: ${thisPlayId}`);
        if (thisPlayId === finalPlayId) {
            playButton.classList.remove('playing'); // 播放按鈕恢復為播放按鈕
            video.pause();
            await setStorageValue(`currentPlayId_${tabId}`, 0);
            console.debug('Playback ended, reset play button and currentPlayId');
        }
        await setStorageValue(`isPlaying_${tabId}`, false);
        console.debug('Set isPlaying to false');

    } catch (error) {
        console.error('Error playing playlist:', error);
    }

    try {
        let finalPlayId = await getStorageValue(`currentPlayId_${tabId}`);
        console.debug(`Final check currentPlayId: ${currentPlayId}, thisPlayId: ${thisPlayId}`);
        if (thisPlayId === finalPlayId) {
            await setStorageValue(`isPlaying_${tabId}`, false); // 確保播放結束後的狀態更新
            console.debug('Ensured isPlaying is set to false at the end');
        }
        sendResponse({ success: true });
    } catch (error) {
        console.error('Error executing script:', error);
    }
}
