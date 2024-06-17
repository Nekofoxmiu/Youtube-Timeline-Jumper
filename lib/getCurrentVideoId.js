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