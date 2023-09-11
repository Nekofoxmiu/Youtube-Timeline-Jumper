chrome.action.onClicked.addListener(async (tab) => {
  // 向content.js发送消息，通知它启动
  const response = await chrome.tabs.sendMessage(tab.id, { action: "startExtension" });
  console.log(response);
});
