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
 * 從目前頁面取得影片上傳日期。
 * @returns {string|null} 以 ISO 格式表示的日期字串，若無法取得則回傳 null。
 */
export function getCurrentVideoUploadDate() {
    const element = document.querySelector('meta[itemprop="uploadDate"]');
    return element ? element.getAttribute('content') : null;
}
