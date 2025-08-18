document.addEventListener('DOMContentLoaded', async () => {
    const playlistContainer = document.getElementById('playlistContainer');
    const importBtn = document.getElementById('importBtn');
    const exportBtn = document.getElementById('exportBtn');
    const importInput = document.getElementById('importInput');
    const clearEmptyBtn = document.getElementById('clearEmptyBtn');
    const extensionToggle = document.getElementById('extensionToggle');
    const toggleStatus = document.getElementById('toggleStatus');

    // 初始化開關狀態
    const { extensionWorkOrNot } = await chrome.storage.local.get('extensionWorkOrNot');
    extensionToggle.checked = extensionWorkOrNot;
    updateToggleStatus(extensionWorkOrNot);

    // 監聽開關變更
    extensionToggle.addEventListener('change', async () => {
        const newState = extensionToggle.checked;
        updateToggleStatus(newState);

        // 取得目前的 YouTube 分頁
        const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
        for (const tab of tabs) {
            // 向每個 YouTube 分頁發送更新狀態的消息
            try {
                await chrome.tabs.sendMessage(tab.id, { 
                    action: newState ? 'initializePlaylist' : 'removePlaylist' 
                });
            } catch (error) {
                console.debug(`Tab ${tab.id} not ready or not a video page`);
            }
        }
    });

    function updateToggleStatus(state) {
        toggleStatus.textContent = state ? '擴充功能已啟用' : '擴充功能已停用';
        toggleStatus.style.color = state ? '#2196F3' : '#666';
    }
    // Toast 顯示函式
    const toastContainer = document.getElementById('toastContainer');
    function showToast(message, timeout = 3000) {
        if (!toastContainer) return;
        const el = document.createElement('div');
        el.className = 'toast';
        el.textContent = message;
        toastContainer.appendChild(el);
        // force reflow
        void el.offsetWidth;
        el.classList.add('show');
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 200);
        }, timeout);
    }
    async function loadAllPlaylists() {
    const result = await chrome.storage.local.get(null);

    // 先收集鍵，立刻渲染 skeleton
    const playlists = Object.keys(result)
        .filter(k => k.startsWith('playlist_'))
        .map(k => ({
        videoId: k.replace('playlist_', ''),
        playlist: result[k],
        title: null
        }));

    displayPlaylists(playlists); // 先畫出清單（先用 ID 當佔位）

    // 併發補標題，不阻塞 UI
    await Promise.all(
        playlists.map(async (p) => {
        p.title = await getVideoTitle(p.videoId);
        const titleEl = document.querySelector(`[data-vid="${p.videoId}"] .playlist-title`);
        if (titleEl) titleEl.textContent = p.title || `影片 ID: ${p.videoId}`;
        })
    );

    // 強制觸發 popup 重新計算高度（保險）
    requestAnimationFrame(() => {
        document.body.style.minHeight = `${document.body.scrollHeight}px`;
    });
    }

    function displayPlaylists(list) {
    playlistContainer.innerHTML = '';
    list.forEach(({ videoId, playlist, title }) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'playlist-item';
        itemDiv.setAttribute('data-vid', videoId); // 用於後續更新標題

        const left = document.createElement('div');
        left.style.flex = '1';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'playlist-title';
        titleDiv.textContent = title || `影片 ID: ${videoId}`;

        const infoDiv = document.createElement('div');
        infoDiv.className = 'playlist-info';
        infoDiv.textContent = `${Array.isArray(playlist) ? playlist.length : 0} 個時間點`;

        left.appendChild(titleDiv);
        left.appendChild(infoDiv);

        const meta = document.createElement('div');
        meta.className = 'playlist-meta';
        const openBtn = document.createElement('button');
        openBtn.className = 'secondary';
        openBtn.textContent = '打開影片';
        openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}` });
        });
        meta.appendChild(openBtn);

        itemDiv.appendChild(left);
        itemDiv.appendChild(meta);

        playlistContainer.appendChild(itemDiv);
    });
    }


    // 從 YouTube API 獲取影片標題
    async function getVideoTitle(videoId) {
        try {
            const response = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
            const data = await response.json();
            return data.title;
        } catch (error) {
            console.error('Error fetching video title:', error);
            return null;
        }
    }

    // 匯出所有播放清單
    exportBtn.addEventListener('click', async () => {
        const result = await chrome.storage.local.get(null);
        const exportData = {};
        
        for (let key in result) {
            if (key.startsWith('playlist_')) {
                exportData[key] = result[key];
            }
        }
        
        const blob = new Blob([JSON.stringify(exportData, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'youtube-timeline-playlists.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    // 清除長度為 0 的播放清單紀錄
    clearEmptyBtn.addEventListener('click', async () => {
        try {
            const all = await chrome.storage.local.get(null);
            const keysToRemove = [];
            for (const k of Object.keys(all)) {
                if (k.startsWith('playlist_')) {
                    const v = all[k];
                    if (!Array.isArray(v) || v.length === 0) {
                        keysToRemove.push(k);
                    }
                }
            }

            if (keysToRemove.length === 0) {
                showToast('沒有可清除的空播放清單。');
                return;
            }

            await chrome.storage.local.remove(keysToRemove);
            loadAllPlaylists();
            showToast(`已刪除 ${keysToRemove.length} 個空播放清單`);
        } catch (error) {
            console.error('清除空播放清單失敗：', error);
            showToast('清除失敗，請查看 console 取得更多資訊。');
        }
    });

    // 觸發檔案選擇
    importBtn.addEventListener('click', () => {
        importInput.click();
    });

    // 匯入播放清單
    importInput.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const importData = JSON.parse(e.target.result);
                await chrome.storage.local.set(importData);
                loadAllPlaylists(); // 重新載入顯示
                showToast('播放清單已成功匯入！');
            } catch (error) {
                console.error('Import error:', error);
                showToast('匯入失敗，請確認檔案格式正確。');
            }
        };
        reader.readAsText(file);
    });

    // 初始載入所有播放清單
    loadAllPlaylists();
});