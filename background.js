// 清單(manifest)版本
const CURRENT_VERSION = chrome.runtime.getManifest().version;

// 遷移腳本(migration)表：依目標版執行對應遷移
const MIGRATIONS = [
  {
    to: '2.0.0',
    run: async () => {
      // 將舊版播放清單鍵（陣列值）搬移到 playlist_ 前綴，並整理 meta
      const allData = await chrome.storage.local.get(null);
      const keepPrefixes = ['currentPlayId_', 'isPlaying_', 'playlist_', 'playlist_meta_'];
      const keepSet = new Set(['extensionWorkOrNot', 'version']);
      const migrated = {};
      const removeKeys = [];

      for (const [key, value] of Object.entries(allData)) {
        if (keepSet.has(key) || keepPrefixes.some(p => key.startsWith(p))) continue;
        if (Array.isArray(value)) {
          // strip legacy per-item meta and consolidate
          let items = [];
          const metaCandidates = [];
          for (const it of value) {
            if (it && typeof it === 'object') {
              const { lastModified, uploadTime, ...rest } = it;
              if (lastModified || uploadTime) {
                metaCandidates.push({ lastModified, uploadTime });
              }
              items.push(rest);
            } else {
              items.push(it);
            }
          }
          migrated[`playlist_${key}`] = items;

          if (metaCandidates.length) {
            const now = new Date().toISOString();
            const lmList = metaCandidates.map(m => m.lastModified).filter(Boolean).sort();
            const utList = metaCandidates.map(m => m.uploadTime).filter(Boolean).sort();
            migrated[`playlist_meta_${key}`] = {
              lastModified: lmList.length ? lmList.slice(-1)[0] : now,
              uploadTime: utList.length ? utList[0] : now,
            };
          }
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

// 嘗試從 watch page 抓取 uploadDate 的輔助函式
async function fetchUploadTimeFromWatchPage(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp || !resp.ok) return null;
    const text = await resp.text();

    const metaMatch = text.match(/<meta[^>]+itemprop=(?:"|')datePublished(?:"|')[^>]*content=(?:"|')([^"']+)(?:"|')/i);
    if (metaMatch && metaMatch[1]) {
      const d = new Date(metaMatch[1]);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }

    const jsonMatch =
      text.match(/"uploadDate"\s*:\s*"([0-9T:\-\.Z ]+)"/i) ||
      text.match(/"datePublished"\s*:\s*"([0-9T:\-\.Z ]+)"/i);
    if (jsonMatch && jsonMatch[1]) {
      const d2 = new Date(jsonMatch[1]);
      if (!Number.isNaN(d2.getTime())) return d2.toISOString();
    }
  } catch (err) {
    console.debug('fetchUploadTimeFromWatchPage failed for', videoId, err);
  }
  return null;
}

// 確保所有播放清單擁有 meta（lastModified / uploadTime）
async function ensureAllPlaylistMeta() {
  const all = await chrome.storage.local.get(null);
  const now = new Date().toISOString();

  const playlists = Object.keys(all)
    .filter(k => k.startsWith('playlist_') && !k.startsWith('playlist_meta_'))
    .map(k => ({ videoId: k.replace('playlist_', ''), items: Array.isArray(all[k]) ? all[k] : [] }));

  for (const p of playlists) {
    const metaKey = `playlist_meta_${p.videoId}`;
    const meta = all[metaKey] || {};
    let { lastModified, uploadTime } = meta;
    let changed = false;

    if (!lastModified) {
      const lmList = p.items.map(it => it && it.lastModified).filter(Boolean).sort();
      lastModified = lmList.length ? lmList.slice(-1)[0] : now;
      changed = true;
    }
    if (!uploadTime) {
      // 1) try asking any open YouTube watch tab
      try {
        const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/watch*' });
        for (const t of tabs) {
          try {
            const resp = await chrome.tabs.sendMessage(t.id, { action: 'getUploadTime', videoId: p.videoId });
            if (resp && resp.uploadTime) {
              uploadTime = resp.uploadTime;
              break;
            }
          } catch (e) {
            // ignore - content script may not exist in tab
          }
        }
      } catch (e) {
        // ignore
      }
      // 2) fallback to fetching watch page directly
      if (!uploadTime) {
        uploadTime = await fetchUploadTimeFromWatchPage(p.videoId);
      }
      if (!uploadTime) uploadTime = now;
      changed = true;
    }

    if (changed) {
      await chrome.storage.local.set({ [metaKey]: { ...meta, lastModified, uploadTime } });
    }
  }
}

async function checkMetaOnStartup() {
  try {
    await ensureAllPlaylistMeta();
  } catch (err) {
    console.error('ensureAllPlaylistMeta failed:', err);
  }
}

// ── onInstalled：安裝/更新時處理預設值與遷移
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await ensureDefaultState();
    await runMigrationsIfNeeded();
    await checkMetaOnStartup();
  } catch (err) {
    console.error('Error during installation/update:', err);
  }
});

// 其他情境下（如瀏覽器啟動）也要檢查 meta
chrome.runtime.onStartup.addListener(() => {
  checkMetaOnStartup();
});

// service worker 啟動時先嘗試檢查一次
checkMetaOnStartup();


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      if (request.action === 'getExtensionWorkOrNot') {
        let { extensionWorkOrNot } = await chrome.storage.local.get('extensionWorkOrNot');
        sendResponse({ state: extensionWorkOrNot });
      }
        if (request.action === 'updatePlaylistState') {
        // new format: data = { videoId, state, meta }
        const { videoId, state, meta } = request.data || {};
        try {
          if (videoId && Array.isArray(state)) {
            const itemsKey = `playlist_${videoId}`;
            const metaKey = `playlist_meta_${videoId}`;
            if (state.length === 0) {
              await chrome.storage.local.remove([itemsKey, metaKey]);
            } else {
              const toSet = { [itemsKey]: state };
              if (meta && typeof meta === 'object') toSet[metaKey] = meta;
              await chrome.storage.local.set(toSet);
            }
            sendResponse({ success: true });
          } else if (request.data && typeof request.data === 'object') {
            // Backwards compatibility: older callers may send { videoId: stateArray }
            // If caller passed direct mapping, merge into storage
            await chrome.storage.local.set(request.data);
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, message: 'Invalid payload' });
          }
        } catch (err) {
          console.error('Error saving playlist state:', err);
          sendResponse({ success: false, message: String(err) });
        }
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
