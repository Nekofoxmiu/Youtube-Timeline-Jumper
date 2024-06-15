chrome.runtime.onInstalled.addListener(() => {
  // 初始化本地存儲中的 extensionWorkOrNot 狀態
  try {
    chrome.storage.sync.set({ extensionWorkOrNot: false }, () => {
      console.log('ExtensionWorkOrNot state initialized to false.');
    });
  } catch (error) {
    console.log('Error initializing ExtensionWorkOrNot state:', error);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  // 向 content.js 發送消息，通知它啟動
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "switchExtensionOnState" });
    console.log(response);
  } catch (error) {
    console.log("Content.js isn't injected.", error);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  try {
    if (request.action === 'switchExtensionOnState') {
      chrome.storage.sync.get(['extensionWorkOrNot'], (result) => {
        const newState = !result.extensionWorkOrNot;
        chrome.storage.sync.set({ extensionWorkOrNot: newState }, () => {
          console.log('ExtensionWorkOrNot state switched to:', newState);
          sendResponse({ state: newState });
        });
      });
      // 保持非同步訊息通道開啟
      return true;
    }
    if (request.action === 'getExtensionWorkOrNot') {
      chrome.storage.sync.get(['extensionWorkOrNot'], (result) => {
        sendResponse({ state: result.extensionWorkOrNot });
      });
      // 保持非同步訊息通道開啟
      return true;
    }
    if (request.action === 'updatePlaylistState') {
      const { videoId, state } = request.data;
      // 儲存資料的邏輯，例如使用 chrome.storage.sync
      chrome.storage.sync.set({ [videoId]: state }, () => {
        sendResponse({ success: true });
      });
      return true; // 表示異步回應
    }
  } catch (error) {
    console.log('Error handling runtime message:', error);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status === 'complete' && tab.url.includes('youtube.com/watch')) {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'initializePlaylist' });
      console.log(response);
    }
  } catch (error) {
    console.log("Request failed.", error);
  }
});
