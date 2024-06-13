chrome.action.onClicked.addListener(async (tab) => {
  // 向content.js发送消息，通知它启动
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "startExtension" });
    console.log(response);
  } catch {
    console.log("Content.js isn't injected.")
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updatePlaylistState') {
      const { videoId, state } = request.data;
      // 儲存資料的邏輯，例如使用 chrome.storage.local
      chrome.storage.local.set({ [videoId]: state }, () => {
          sendResponse({ success: true });
      });
      return true; // 表示異步回應
  }
});
