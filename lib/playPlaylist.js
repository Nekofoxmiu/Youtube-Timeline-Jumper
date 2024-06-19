export async function playPlaylist(startIndex, sendResponse, tabId) {
    let { currentPlayId } = await chrome.storage.local.get(`currentPlayId_${tabId}`);
    if (typeof currentPlayId === 'undefined') {
        currentPlayId = 0;
    }
    currentPlayId++;
    await chrome.storage.local.set({ [`currentPlayId_${tabId}`]: currentPlayId });

    const thisPlayId = currentPlayId;

    try {
        const { [`isPlaying_${tabId}`]: isPlaying } = await chrome.storage.local.get(`isPlaying_${tabId}`);

        async function stopCurrentPlayback() {
            const video = document.querySelector('video');
            if (video) {
                video.pause();
            }
            const playButton = document.querySelector('.ytj-play-playlist');
            if (playButton) {
                playButton.classList.remove('playing'); // 恢復播放按鈕樣式
            }
            const playingItems = document.querySelectorAll('.ytj-playing-item');
            playingItems.forEach(item => {
                item.classList.remove('ytj-playing-item');
                const dragHandle = item.querySelector('.ytj-drag-handle');
                if (dragHandle) {
                    dragHandle.classList.remove('playing');
                }
            });
        }

        function updateStyles(item, add) {
            return new Promise((resolve) => {
                setTimeout(() => {
                    if (add) {
                        item.classList.add('ytj-playing-item');
                        item.querySelector('.ytj-drag-handle').classList.add('playing');
                    } else {
                        item.classList.remove('ytj-playing-item');
                        item.querySelector('.ytj-drag-handle').classList.remove('playing');
                    }
                    resolve();
                }, 0); // 使用0毫秒的延遲確保操作排入事件隊列
            });
        }


        // 停止當前播放
        if (isPlaying) {
            await stopCurrentPlayback();
            await chrome.storage.local.set({ [`isPlaying_${tabId}`]: false });
        }

        await chrome.storage.local.set({ [`isPlaying_${tabId}`]: true });

        const playlistContainer = document.querySelector('.ytj-playlist-container');
        const video = document.querySelector('video');
        const playButton = document.querySelector('.ytj-play-playlist');
        if (!playlistContainer || !video || !playButton) return;

        const playlistState = playlistContainer.querySelectorAll('.ytj-playlist-item');

        if (!playButton.classList.contains('playing')) {
            playButton.classList.add('playing'); // 播放按鈕變為暫停按鈕
        }

        let retryTolerance = 0;

        for (let i = startIndex; i < playlistState.length; i++) {
            const { [`currentPlayId_${tabId}`]: currentPlayId } = await chrome.storage.local.get(`currentPlayId_${tabId}`);
            if (thisPlayId !== currentPlayId) break;

            const item = playlistState[i];
            const startTime = parseInt(item.querySelector('.ytj-playlist-item-text-start').getAttribute('timeat'));
            const endTime = parseInt(item.querySelector('.ytj-playlist-item-text-end').getAttribute('timeat'));

            video.currentTime = startTime;
            await video.play();

            await updateStyles(item, true);

            await new Promise((resolve) => {
                const checkTime = setInterval(async () => {
                    const { [`currentPlayId_${tabId}`]: currentPlayId } = await chrome.storage.local.get(`currentPlayId_${tabId}`);
                    if (thisPlayId !== currentPlayId) {
                        //console.log(thisPlayId, currentPlayId);
                        //console.log('Playback stopped. by thisPlayId !== currentPlayId');
                        clearInterval(checkTime);
                        resolve();
                    }
                    if (video.currentTime >= endTime) {
                        retryTolerance++;
                        if (retryTolerance > 5) {
                            //console.log('Playback stopped. by retryTolerance > 5');
                            clearInterval(checkTime);
                            resolve();
                        }
                    }
                }, 100);
            });

            await updateStyles(item, false);
        }

        const { [`currentPlayId_${tabId}`]: currentPlayId } = await chrome.storage.local.get(`currentPlayId_${tabId}`);
        if (thisPlayId === currentPlayId) {
            playButton.classList.remove('playing'); // 播放按鈕恢復為播放按鈕
            video.pause();
            await chrome.storage.local.set({ [`currentPlayId_${tabId}`]: 0 });
        }
        await chrome.storage.local.set({ [`isPlaying_${tabId}`]: false });

    } catch (error) {
        console.log('Error playing playlist:', error);
    }

    try {
        (async () => {
            const { [`currentPlayId_${tabId}`]: currentPlayId } = await chrome.storage.local.get(`currentPlayId_${tabId}`);
            if (thisPlayId === currentPlayId) {
                await chrome.storage.local.set({ [`isPlaying_${tabId}`]: false }); // 確保播放結束後的狀態更新
            }
            sendResponse({ success: true });
        })();
    } catch (error) {
        console.log('Error executing script:', error);
    }
}