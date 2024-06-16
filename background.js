chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    // 初始化本地存儲中的 extensionWorkOrNot 狀態
    try {
      await chrome.storage.sync.set({ extensionWorkOrNot: false }, () => {
        console.log('ExtensionWorkOrNot state initialized to false.');
      });
    } catch (error) {
      console.log('Error initializing ExtensionWorkOrNot state:', error);
    }
  })();
});

chrome.action.onClicked.addListener((tab) => {
  (async () => {
    // 向 content.js 發送消息，通知它啟動
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: "switchExtensionOnState" });
      console.log(response);
    } catch (error) {
      console.log("Content.js isn't injected.", error);
    }
  })();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      if (request.action === 'switchExtensionOnState') {
        let { extensionWorkOrNot } = await chrome.storage.sync.get('extensionWorkOrNot')
        const newState = !extensionWorkOrNot;
        await chrome.storage.sync.set({ extensionWorkOrNot: newState });
        console.log('ExtensionWorkOrNot state switched to:', newState);
        sendResponse({ state: newState });
      }
      if (request.action === 'getExtensionWorkOrNot') {
        let { extensionWorkOrNot } = await chrome.storage.sync.get('extensionWorkOrNot');
        sendResponse({ state: extensionWorkOrNot });
      }
      if (request.action === 'updatePlaylistState') {
        const { videoId, state } = request.data;
        // 儲存資料，使用 chrome.storage.sync
        await chrome.storage.sync.set({ [videoId]: state }, () => {
          sendResponse({ success: true });
        });
      }
    } catch (error) {
      console.log('Error handling runtime message:', error);
    }

  })();
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  (async () => {
    try {
      console.debug(tabId, changeInfo, tab);
      if (changeInfo.status === 'complete') {
        try {
          const response = await chrome.tabs.sendMessage(tabId, { action: 'initializePlaylist' });
          console.log(response);
        } catch (error) {
          console.debug("Content Script not isn't injected.", error);
        }
      }

    } catch (error) {
      console.log("Request failed.", error);
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  (async () => {
    try {
      if (request.action === 'playPlaylist') {
        const tabId = sender.tab.id; // 獲取發送消息的 tab ID
        await playPlaylist(request.startIndex, sendResponse, tabId);
      }
    } catch (error) {
      console.log('Error handling runtime message:', error);
    }
  })();
  return true; // 保持非同步訊息通道開啟
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  (async () => {
    try {
      // 刪除與該 tab ID 相關的狀態資訊
      await chrome.storage.local.remove(`currentPlayId_${tabId}`);
      await chrome.storage.local.remove(`isPlaying_${tabId}`);
      console.log(`Removed state for tab ID ${tabId}`);
    } catch (error) {
      console.log('Error removing state for closed tab:', error);
    }
  })();
});

async function playPlaylist(startIndex, sendResponse, tabId) {
  let { currentPlayId } = await chrome.storage.local.get(`currentPlayId_${tabId}`);
  if (typeof currentPlayId === 'undefined') {
    currentPlayId = 0;
  }
  currentPlayId++;
  await chrome.storage.local.set({ [`currentPlayId_${tabId}`]: currentPlayId });

  const thisPlayId = currentPlayId;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    await chrome.storage.local.set({ [`isPlaying_${tabId}`]: false });
    sendResponse({ success: false, message: 'No active tab found.' });
    return;
  }

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    function: async (startIndex, thisPlayId, tabId) => {
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
    },
    args: [startIndex, thisPlayId, tabId]
  }, () => {
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
  });
}
