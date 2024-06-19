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
          console.debug("Content Script isn't injected.", error);
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
        chrome.tabs.sendMessage(tabId, { action: 'playPlaylist', startIndex: request.startIndex, tabId: tabId }, (response) => {
          if (response.success) {
            console.log('Playlist started successfully');
          } else {
            console.log('Failed to start playlist:', response.message);
          }
        });
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
      console.debug(`Removed state for tab ID ${tabId}`);
    } catch (error) {
      console.log('Error removing state for closed tab:', error);
    }
  })();
});
