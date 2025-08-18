// 清單(manifest)版本
const CURRENT_VERSION = chrome.runtime.getManifest().version;

// 遷移腳本(migration)表：依目標版執行對應遷移
const MIGRATIONS = [
  {
    to: '2.0.0',
    run: async () => {
      // 將舊版播放清單鍵（陣列值）搬移到 playlist_ 前綴
      const allData = await chrome.storage.local.get(null);
      const keepPrefixes = ['currentPlayId_', 'isPlaying_', 'playlist_'];
      const keepSet = new Set(['extensionWorkOrNot', 'version']);
      const migrated = {};
      const removeKeys = [];

      for (const [key, value] of Object.entries(allData)) {
        if (keepSet.has(key) || keepPrefixes.some(p => key.startsWith(p))) continue;
        if (Array.isArray(value)) {
          migrated[`playlist_${key}`] = value;
          removeKeys.push(key);
        }
      }

      if (Object.keys(migrated).length) {
        await chrome.storage.local.set(migrated);
      }
      if (removeKeys.length) {
        await chrome.storage.local.remove(removeKeys);
      }
    }
  },
];

// ── SemVer 比較：回傳 -1/0/1
function cmpSemver(a, b) {
  const pa = String(a).split('.').map(x => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0, db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

// 安全傳訊：避免未注入 content.js 或分頁不存在造成噪訊
async function safeSendTabMessage(tabId, message) {
  if (typeof tabId !== 'number') return { ok: false, error: 'Invalid tabId' };
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    return { ok: true, res };
  } catch (e) {
    // 常見於 content script 未注入
    return { ok: false, error: e?.message || String(e) };
  }
}

// 初始化預設狀態
async function ensureDefaultState() {
  const { extensionWorkOrNot } = await chrome.storage.local.get('extensionWorkOrNot');
  if (extensionWorkOrNot === undefined) {
    await chrome.storage.local.set({ extensionWorkOrNot: true });
  }
}

// 執行遷移
async function runMigrationsIfNeeded() {
  const { version: oldVersion = '1.0.0' } = await chrome.storage.local.get('version');
  if (cmpSemver(oldVersion, CURRENT_VERSION) === 0) return;

  // 依 MIGRATIONS.to 昇冪排序，依序執行需要的遷移
  const sorted = [...MIGRATIONS].sort((a, b) => cmpSemver(a.to, b.to));
  for (const m of sorted) {
    if (cmpSemver(oldVersion, m.to) < 0 && cmpSemver(CURRENT_VERSION, m.to) >= 0) {
      await m.run();
    }
  }
  await chrome.storage.local.set({ version: CURRENT_VERSION });
}

// ── onInstalled：安裝/更新時處理預設值與遷移
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await ensureDefaultState();
    await runMigrationsIfNeeded();
  } catch (err) {
    console.error('Error during installation/update:', err);
  }
});


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      if (request.action === 'getExtensionWorkOrNot') {
        let { extensionWorkOrNot } = await chrome.storage.local.get('extensionWorkOrNot');
        sendResponse({ state: extensionWorkOrNot });
      }
      if (request.action === 'updatePlaylistState') {
        const { videoId, state } = request.data;
        // 儲存資料，使用 chrome.storage.local
        await chrome.storage.local.set({ [videoId]: state }, () => {
          sendResponse({ success: true });
        });
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
