function compareVersions(v1, v2) {
  const a = v1.split('.').map(Number);
  const b = v2.split('.').map(Number);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function migrateOldStorage() {
  try {
    const allData = await chrome.storage.local.get(null);
    const newStore = {};
    const keysToRemove = [];
    for (const [key, value] of Object.entries(allData)) {
      const isReserved = key === 'extensionWorkOrNot' || key === 'playlistStates' || key.startsWith('currentPlayId_') || key.startsWith('isPlaying_');
      if (!isReserved && Array.isArray(value)) {
        newStore[key] = value;
        keysToRemove.push(key);
      }
    }
    if (Object.keys(newStore).length > 0) {
      const existing = (await chrome.storage.local.get('playlistStates')).playlistStates || {};
      await chrome.storage.local.set({ playlistStates: { ...existing, ...newStore } });
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch (error) {
    console.log('Error migrating old storage:', error);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    try {
      let data = await chrome.storage.local.get('extensionWorkOrNot');
      if (data.extensionWorkOrNot === undefined) {
        await chrome.storage.local.set({ extensionWorkOrNot: false });
      }
      if (details.reason === 'update' && compareVersions(details.previousVersion || '0', '2.0.0') < 0) {
        await migrateOldStorage();
      }
    } catch (error) {
      console.log('Error during installation process:', error);
    }
  })();
});


chrome.action.onClicked.addListener((tab) => {
  (async () => {
    // 向 content.js 發送消息，通知它啟動
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: "switchExtensionOnState" });
      //console.log(response);
    } catch (error) {
      console.log("Content.js isn't injected.", error);
    }
  })();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      if (request.action === 'switchExtensionOnState') {
        let { extensionWorkOrNot } = await chrome.storage.local.get('extensionWorkOrNot')
        const newState = !extensionWorkOrNot;
        await chrome.storage.local.set({ extensionWorkOrNot: newState });
        //console.log('ExtensionWorkOrNot state switched to:', newState);
        sendResponse({ state: newState });
      }
      if (request.action === 'getExtensionWorkOrNot') {
        let { extensionWorkOrNot } = await chrome.storage.local.get('extensionWorkOrNot');
        sendResponse({ state: extensionWorkOrNot });
      }
      if (request.action === 'updatePlaylistState') {
        const { videoId, state } = request.data;
        const data = await chrome.storage.local.get('playlistStates');
        const playlists = data.playlistStates || {};
        playlists[videoId] = state;
        await chrome.storage.local.set({ playlistStates: playlists });
        sendResponse({ success: true });
      }
      if (request.action === 'playPlaylist') {
        const tabId = sender.tab.id; // 獲取發送消息的 tab ID
        chrome.tabs.sendMessage(tabId, { action: 'playPlaylist', startIndex: request.startIndex, endIndex: request.endIndex, tabId: tabId }, (response) => {
          if (response.success) {
            //console.log('Playlist started successfully');
          } else {
            console.log('Failed to start playlist:', response.message);
          }
        });
      }
      if (request.action === "getTabId") {
        sendResponse(sender.tab.id); // 傳回目前的 tabId
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
          //console.log(response);
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


chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  (async () => {
    try {
      // 刪除與該 tab ID 相關的狀態資訊
      await chrome.storage.local.remove(`currentPlayId_${tabId}`);
      await chrome.storage.local.remove(`isPlaying_${tabId}`);
      //console.debug(`Removed state for tab ID ${tabId}`);
    } catch (error) {
      console.log('Error removing state for closed tab:', error);
    }
  })();
});