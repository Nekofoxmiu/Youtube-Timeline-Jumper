chrome.runtime.onInstalled.addListener(() => {
  // 初始化本地存儲中的 extensionWorkOrNot 狀態
  chrome.storage.sync.set({ extensionWorkOrNot: false }, () => {
      console.log('ExtensionWorkOrNot state initialized to false.');
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  // 向content.js发送消息，通知它启动
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "switchExtensionOnState" });
    console.log(response);
  } catch {
    console.log("Content.js isn't injected.")
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && changeInfo.url.includes('youtube.com/watch')) {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'initializePlaylist' });
    console.log(response);
  }
});
