import { getandUpdatePlaylistState } from './playlistTool.js';

// editModule.js
export function enableEditMode(editableElement, playlistState, playlistTimeManager) {
    const originalText = editableElement.innerText || editableElement.value;
    const originalAttr = editableElement.getAttribute('timeat') || originalText;

    if (editableElement.tagName === 'INPUT') {
        editableElement.readOnly = false;
        editableElement.focus();
    } else {
        editableElement.contentEditable = 'true';
        editableElement.focus();
    }

    // 設置失去焦點事件處理
    editableElement.addEventListener('blur', () => handleBlur(editableElement, originalAttr, playlistState, playlistTimeManager), { once: true });

    // 設置鍵盤事件，以支持保存和取消
    editableElement.addEventListener('keydown', (event) => handleKeydown(event, editableElement, originalText));
}

export function handleBlur(editableElement, originalAttr, playlistState, playlistTimeManager) {
    if (editableElement.tagName === 'INPUT') {
        editableElement.readOnly = true;
    } else {
        editableElement.contentEditable = 'false';
        if (editableElement.classList.contains('ytj-playlist-item-text-start') || editableElement.classList.contains('ytj-playlist-item-text-end')) {
            playlistTimeManager.updateTimeText(editableElement, Number(originalAttr));
        }
    }
    playlistState.state = getandUpdatePlaylistState(playlistState);
}

export function handleKeydown(event, editableElement, originalText) {
    event.stopPropagation(); // 防止事件冒泡
    if (event.key === 'Enter') {
        event.preventDefault(); // 防止 Enter 鍵的默認行為
        editableElement.blur(); // 觸發失去焦點事件來保存
    } else if (event.key === 'Escape') {
        if (editableElement.tagName === 'INPUT') {
            editableElement.value = originalText; // 恢復原始文本
        } else {
            editableElement.innerText = originalText; // 恢復原始文本
        }
        editableElement.blur(); // 取消編輯
    }
}
