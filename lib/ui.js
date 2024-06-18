import { TimeSlot } from "./dataclass.js";
import { getCurrentVideoTime } from "./getVideoInfo.js";
import { PlaylistTimeManager } from "./playlistTool.js";

export function createPlaylistContainer(videoId) {
    const container = document.createElement('div');
    container.id = 'ytj-playlist-container';
    container.className = 'ytj-playlist-container';
    container.setAttribute('youtubeID', videoId);
    return container;
}

export function createButtonContainer() {
    const container = document.createElement('div');
    container.id = 'ytj-button-container';
    container.className = 'ytj-button-container';
    return container;
}

export function createImportExportContainer() {
    const container = document.createElement('div');
    container.id = 'ytj-importexport-container';
    container.className = 'ytj-importexport-container';
    return container;
}

export function createPlaylistItemsContainer() {
    const ul = document.createElement('ul');
    ul.id = 'ytj-playlist-items';
    return ul;
}

export function createTimeTextElements(startTime = null, endTime = null) {
    let startObj, endObj;

    if (startTime !== null) {
        const startAndEndTimeObj = PlaylistTimeManager.checkStartAndEnd(startTime, endTime);
        startObj = startAndEndTimeObj['start'];
        endObj = startAndEndTimeObj['end'];
    } else {
        startObj = getCurrentVideoTime();
        endObj = getCurrentVideoTime(); 
    }

    if (!startObj || !endObj) {
        console.error('No video element found.');
        return null;
    }

    const startItemText = document.createElement('div');
    startItemText.classList.add('ytj-playlist-item-text-start');
    startItemText.innerText = startObj.toformatString();
    startItemText.setAttribute('timeat', startObj.getTotalseconds().toString());
    startItemText.contentEditable = false;

    const endItemText = document.createElement('div');
    endItemText.classList.add('ytj-playlist-item-text-end');
    endItemText.innerText = endObj.toformatString();
    endItemText.setAttribute('timeat', endObj.getTotalseconds().toString());
    endItemText.contentEditable = false;

    return {
        startElement: startItemText,
        endElement: endItemText
    };
}



export function createAddToPlaylistButton() {
    const button = document.createElement('button');
    button.id = 'ytj-add-to-playlist';
    button.className = 'ytj-add-to-playlist';
    return button;
}

export function createImportPlaylistButton(importPlaylistFromText) {
    const button = document.createElement('button');
    button.id = 'ytj-import-playlist-text';
    button.className = 'ytj-import-playlist-text';
    button.innerText = 'Import Playlist';
    button.addEventListener('click', importPlaylistFromText);
    return button;
}

export function createExportPlaylistButton(exportPlaylist) {
    const button = document.createElement('button');
    button.id = 'ytj-export-playlist';
    button.className = 'ytj-export-playlist';
    button.innerText = 'Export Playlist';
    button.addEventListener('click', exportPlaylist);
    return button;
}

export function createPlayButton() {
    const button = document.createElement('button');
    button.id = 'ytj-play-playlist';
    button.className = 'ytj-play-playlist';
    return button;
}


/**
 * 建立彈出文本框的函數
 * @param {string} title - 彈出框的標題
 * @param {function} onSave - 當保存按鈕被點擊時的回調函數
 * @returns {HTMLElement} 彈出文本框元素
 */
export function createPopupTextBox(title, onSave) {
    const overlay = document.createElement('div');
    overlay.className = 'ytj-overlay';

    const popup = document.createElement('div');
    popup.className = 'ytj-popup';

    const popupTitle = document.createElement('h2');
    popupTitle.innerText = title;

    const textArea = document.createElement('textarea');
    textArea.className = 'ytj-popup-textarea';

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'ytj-popup-button-container';

    const saveButton = document.createElement('button');
    saveButton.innerText = 'Save';
    saveButton.addEventListener('click', () => {
        onSave(textArea.value);
        document.body.removeChild(overlay);
    });

    const cancelButton = document.createElement('button');
    cancelButton.innerText = 'Cancel';
    cancelButton.addEventListener('click', () => {
        document.body.removeChild(overlay);
    });

    buttonContainer.appendChild(saveButton);
    buttonContainer.appendChild(cancelButton);
    popup.appendChild(popupTitle);
    popup.appendChild(textArea);
    popup.appendChild(buttonContainer);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    return overlay;
}