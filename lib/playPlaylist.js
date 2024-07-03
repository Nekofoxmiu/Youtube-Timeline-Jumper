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

export async function playPlaylist(startIndex, endIndex, sendResponse, tabId) {
    console.debug(`Starting playlist from index: ${startIndex}, to ${endIndex}, tabId: ${tabId}`);
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

        for (let i = startIndex; i < playlistState.length && i < endIndex; i++) {
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
