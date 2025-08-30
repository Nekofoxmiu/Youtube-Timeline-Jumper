import { TimeSlot } from './dataclass.js';
/**
    * 獲取當前 YouTube 影片 ID。
    * @returns {string|null} 影片 ID 或 null。
    */
export function getCurrentVideoId() {
    const videoUrl = window.location.href;
    const url = new URL(videoUrl);
    const urlParams = new URLSearchParams(url.search);

    // 檢查標準網址格式
    let videoId = urlParams.get('v');
    if (videoId) {
        return videoId;
    }

    // 檢查短網址格式
    const pathnameParts = url.pathname.split('/');
    if (url.hostname === 'youtu.be' && pathnameParts.length > 1) {
        return pathnameParts[1];
    }

    // 檢查嵌入式影片網址格式
    if (url.hostname === 'www.youtube.com' && pathnameParts[1] === 'embed' && pathnameParts.length > 2) {
        return pathnameParts[2];
    }

    return null;
}

/**
 * 獲取當前視頻播放時間，並轉換為小時、分鐘和秒。
 * @returns {?TimeSlot} 包含時間信息的物件，或者如果沒有視頻元素則返回 null。
 */
export function getCurrentVideoTime() {
    const video = document.querySelector('video');
    if (!video) return null;
    return TimeSlot.fromTotalseconds(Math.floor(video.currentTime));
}

/**
 * 嘗試從目前播放頁面擷取影片上傳時間（ISO 字串），若無法取得則回傳 null
 * 取得順序：
 *  1) 檢查頁面 meta[itemprop="datePublished"|"uploadDate"]
 *  2) 檢查全域變數 ytInitialPlayerResponse.microformat.playerMicroformatRenderer
 *  3) 回退抓取整個頁面 HTML 並正規表達式搜尋 uploadDate/publishDate
 *
 * @param {string} videoId - 影片 ID（目前實作並未用到，但保留以供未來擴充）
 * @returns {Promise<string|null>} ISO 格式的日期字串或 null
 */
export async function fetchVideoUploadTime(videoId) {
    try {
        // 1) meta 標籤
        const meta = document.querySelector('meta[itemprop="datePublished"], meta[itemprop="uploadDate"], meta[name="datePublished"]');
        if (meta && meta.content) {
            const d = new Date(meta.content);
            if (!Number.isNaN(d.getTime())) return d.toISOString();
        }

        // 2) ytInitialPlayerResponse microformat
        try {
            const ytr = window.ytInitialPlayerResponse || (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args && window.ytplayer.config.args.player_response && JSON.parse(window.ytplayer.config.args.player_response));
            const mr = ytr && ytr.microformat && ytr.microformat.playerMicroformatRenderer;
            const candidate = mr && (mr.uploadDate || mr.publishDate || mr.publishDateUtc || mr.datePublished || null);
            if (candidate) {
                const d2 = new Date(candidate);
                if (!Number.isNaN(d2.getTime())) return d2.toISOString();
            }
        } catch (e) {
            // 解析 ytplayer.config 的 JSON 失敗則忽略
        }

        // 3) 回退：抓取 HTML 並用正則找 uploadDate / publishDate
        try {
            const resp = await fetch(window.location.href, { credentials: 'same-origin' });
            if (resp && resp.ok) {
                const text = await resp.text();
                // 例如出現在 JSON 字串中："uploadDate":"2020-01-01"
                const m = text.match(/"uploadDate"\s*:\s*"([0-9T:\-\.Z ]+)"/) || text.match(/"publishDate"\s*:\s*"([0-9T:\-\.Z ]+)"/);
                if (m && m[1]) {
                    const d3 = new Date(m[1]);
                    if (!Number.isNaN(d3.getTime())) return d3.toISOString();
                }
            }
        } catch (e) {
            // fetch 也可能失敗，忽略
        }

        return null;
    } catch (err) {
        return null;
    }
}