document.addEventListener('DOMContentLoaded', async () => {
    // Apply localization to any element that uses data-i18n attribute
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        try {
            el.textContent = chrome.i18n.getMessage(key) || el.textContent;
        } catch (e) {
            // chrome.i18n may not be available in some contexts; ignore
        }
    });

    const playlistContainer = document.getElementById('playlistContainer');
    const importBtn = document.getElementById('importBtn');
    const exportBtn = document.getElementById('exportBtn');
    const importInput = document.getElementById('importInput');
    // clearEmptyBtn removed: automatic cleanup on load
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
        // 將狀態儲存到 storage，確保在沒有 YouTube 分頁時也能生效
        await chrome.storage.local.set({ extensionWorkOrNot: newState });

        // 取得目前的 YouTube 分頁
        const tabs = await chrome.tabs.query({
            url: ['*://*.youtube.com/*', '*://youtube.com/*', '*://youtu.be/*']
        });
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
    const msg = state ? chrome.i18n.getMessage('toggle_on') : chrome.i18n.getMessage('toggle_off');
    toggleStatus.textContent = msg;
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
    function displayPlaylists(list) {
    playlistContainer.innerHTML = '';
    // helper to format a time token (TimeSlot object, number seconds, or string)
    function formatTimeToken(tok) {
        try {
            if (!tok && tok !== 0) return '';
            // If it's an object with toformatString (our TimeSlot), use it
            if (typeof tok === 'object') {
                if (typeof tok.toformatString === 'function') return tok.toformatString();
                // if it's a plain object with hours/minutes/seconds
                if ('hours' in tok || 'minutes' in tok || 'seconds' in tok) {
                    const h = Number(tok.hours) || 0;
                    const m = Number(tok.minutes) || 0;
                    const s = Number(tok.seconds) || 0;
                    const parts = [];
                    if (h) parts.push(String(h));
                    parts.push(String(m).padStart(2, '0'));
                    parts.push(String(s).padStart(2, '0'));
                    return parts.join(':');
                }
                return String(tok);
            }
            // number of seconds
            if (typeof tok === 'number') {
                const s = Math.floor(tok);
                const h = Math.floor(s / 3600);
                const m = Math.floor((s % 3600) / 60);
                const sec = s % 60;
                return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
            }
            // string: maybe it's already formatted
            return String(tok);
        } catch (err) {
            return String(tok);
        }
    }

    list.forEach(({ videoId, playlist, title }) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'playlist-item';
        itemDiv.setAttribute('data-vid', videoId);
        itemDiv.style.cursor = 'pointer';
        itemDiv._playlist = playlist || [];

        // top area: title + meta (open)
        const top = document.createElement('div');
        top.style.display = 'flex';
        top.style.width = '100%';
        top.style.alignItems = 'center';
        top.style.justifyContent = 'space-between';

        const left = document.createElement('div');
        left.style.flex = '1';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'playlist-title';
        titleDiv.textContent = title || `影片 ID: ${videoId}`;

        const infoDiv = document.createElement('div');
        infoDiv.className = 'playlist-info';
        infoDiv.textContent = `${Array.isArray(playlist) ? playlist.length : 0} ${chrome.i18n.getMessage('timepoints_suffix')}`;

        left.appendChild(titleDiv);
        left.appendChild(infoDiv);

        const meta = document.createElement('div');
        meta.className = 'playlist-meta';
        const openBtn = document.createElement('button');
        openBtn.className = 'secondary';
        openBtn.textContent = chrome.i18n.getMessage('open_video');
        openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}` });
        });
        meta.appendChild(openBtn);

        top.appendChild(left);
        top.appendChild(meta);
        itemDiv.appendChild(top);

        // expandable area placed under the title (full width)
        const details = document.createElement('div');
        details.className = 'playlist-details';
        details.style.display = 'none';
        details.style.marginTop = '8px';
        details.style.paddingTop = '8px';
        details.style.borderTop = '1px solid rgba(255,255,255,0.03)';

        const ul = document.createElement('ul');
        ul.style.listStyle = 'none';
        ul.style.padding = '0';
        (playlist || []).forEach((pt, idx) => {
            const li = document.createElement('li');
            const startText = formatTimeToken(pt.start);
            const endText = formatTimeToken(pt.end);
            const titleText = pt.title ? ` • ${pt.title}` : '';
            li.textContent = `${startText || '0:00'} - ${endText || startText || '0:00'}${titleText}`;
            li.style.padding = '6px 0';
            ul.appendChild(li);
        });
        details.appendChild(ul);
        itemDiv.appendChild(details);

        // toggle expand on click (but not when clicking buttons)
        itemDiv.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.closest('button')) return;
            details.style.display = details.style.display === 'none' ? 'block' : 'none';
        });

        playlistContainer.appendChild(itemDiv);
    });
    }

    // Search & Sort handlers
    const searchInput = document.getElementById('searchInput');
    const sortSelect = document.getElementById('sortSelect');
    sortSelect.value = 'lastModified_desc';

    async function refreshView() {
        const all = await chrome.storage.local.get(null);
        let playlists = Object.keys(all)
            .filter(k => k.startsWith('playlist_') && !k.startsWith('playlist_meta_'))
            .map(k => ({ videoId: k.replace('playlist_', ''), playlist: Array.isArray(all[k]) ? all[k] : [] }));

        // compute playlist-level metadata by reading separate meta store and preserve already-rendered titles
        const metaKeys = playlists.map(p => `playlist_meta_${p.videoId}`);
        const metaResults = await chrome.storage.local.get(metaKeys);
        playlists = playlists.map(p => {
            const existingTitleEl = document.querySelector(`[data-vid="${p.videoId}"] .playlist-title`);
            const existingTitle = existingTitleEl ? existingTitleEl.textContent : null;
            const meta = metaResults[`playlist_meta_${p.videoId}`] || {};
            const lastModified = meta.lastModified || '';
            const uploadTime = meta.uploadTime || '';
            return { ...p, title: existingTitle || null, lastModified, uploadTime };
        });

        const mode = sortSelect.value;

        // For any missing titles, fetch in parallel (non-blocking for each)
        await Promise.all(playlists.map(async (p) => {
            if (!p.title) {
                try {
                    const t = await getVideoTitle(p.videoId);
                    p.title = t || `${chrome.i18n.getMessage('video_id_prefix')} ${p.videoId}`;
                } catch (e) {
                    p.title = `${chrome.i18n.getMessage('video_id_prefix')} ${p.videoId}`;
                }
            }
        }));

        // apply search
        const q = (searchInput.value || '').trim().toLowerCase();
        let filtered = playlists;
        if (q) {
            filtered = playlists.filter(p => (p.videoId && p.videoId.includes(q)) || (p.title && p.title.toLowerCase().includes(q)));
        }

        // apply sort
        if (mode === 'lastModified_desc') filtered.sort((a,b) => (b.lastModified||'').localeCompare(a.lastModified||''));
        else if (mode === 'lastModified_asc') filtered.sort((a,b) => (a.lastModified||'').localeCompare(b.lastModified||''));
        else if (mode === 'uploadTime_desc') filtered.sort((a,b) => (b.uploadTime||'').localeCompare(a.uploadTime||''));
        else if (mode === 'uploadTime_asc') filtered.sort((a,b) => (a.uploadTime||'').localeCompare(b.uploadTime||''));

        displayPlaylists(filtered.map(p => ({ videoId: p.videoId, playlist: p.playlist, title: p.title })));
    }
    searchInput.addEventListener('input', () => refreshView());
    sortSelect.addEventListener('change', () => refreshView());


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
            if (key.startsWith('playlist_') || key.startsWith('playlist_meta_')) {
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
                refreshView(); // 重新載入顯示
                showToast(chrome.i18n.getMessage('import_success'));
            } catch (error) {
                console.error('Import error:', error);
                showToast(chrome.i18n.getMessage('import_failed'));
            }
        };
        reader.readAsText(file);
    });

    // 初始載入所有播放清單
    // First, automatically remove empty playlist_* entries then load playlists
    (async () => {
        try {
            const all = await chrome.storage.local.get(null);
            const keysToRemove = [];
            for (const k of Object.keys(all)) {
                if (k.startsWith('playlist_') && !k.startsWith('playlist_meta_')) {
                    const v = all[k];
                    if (!Array.isArray(v) || v.length === 0) {
                        keysToRemove.push(k);
                        const vid = k.replace('playlist_', '');
                        const metaKey = `playlist_meta_${vid}`;
                        if (metaKey in all) keysToRemove.push(metaKey);
                    }
                }
            }
            if (keysToRemove.length) {
                await chrome.storage.local.remove(keysToRemove);
                showToast(chrome.i18n.getMessage('deleted_empty_playlists', [String(keysToRemove.length)]));
            }
        } catch (err) {
            console.error('Auto-cleanup failed:', err);
        }
        refreshView();
    })();
});