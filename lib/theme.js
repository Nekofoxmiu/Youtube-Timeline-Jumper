// theme.js
/**
 * 判斷 YouTube 是否為黑暗主題
 * @returns {boolean} true 表示為黑暗主題，false 表示為明亮主題
 */
export function isYouTubeDarkTheme() {
    var element = document.querySelector('ytd-app');
    if (!element) return false;
    var styles = getComputedStyle(element);
    var value = styles.getPropertyValue('--yt-spec-base-background').trim();
    return value === '#0f0f0f';
}

/**
 * 應用相應的 CSS 主題
 */
export function applyTheme() {
    if (isYouTubeDarkTheme()) {
        document.body.classList.add('dark-theme');
        document.body.classList.remove('light-theme');
    } else {
        document.body.classList.add('light-theme');
        document.body.classList.remove('dark-theme');
    }
}
